// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-vacuum TUI plugin.
//
// Registers a `/vacuum` slash command that opens a settings-style panel where you
// dial in prune rules:
//   - Older than:      off / 1 day / 7 days / 30 days / 6 months / all sessions
//   - Larger than:     off / 10 / 50 / 100 / 500 MB / 1 GB / custom
//   - Keep per folder: always keep the N newest per folder (1, 5, 100, custom...)
//   - Protect shared:  never delete shared sessions
// The panel shows live how many sessions match. "Clear & prune" deletes the
// matching sessions through OpenCode's own session API and then runs VACUUM;
// "Vacuum only" just reclaims free pages. The currently open session is always
// protected.
//
// IMPORTANT: TUI plugins are NOT auto-discovered from the plugin/ directory.
// This file must be referenced from `tui.json` (the installer does that):
//   { "plugin": ["./vacuum-plugin.ts"] }
//
// The planning, rule matching, and vacuum logic live in ./vacuum.mjs.

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { applyRules, buildResultMessage, dbPath, fmtBytes, planPrune, readOpts, vacuum } from "./vacuum.mjs"

const DAY = 86_400_000
const MB = 1024 * 1024
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

type Age = number | "all" | null
type Bytes = number | null

// Cycle presets for each rule. A `custom` step opens a prompt instead of setting.
const AGE_STEPS: { v: Age; label: string }[] = [
  { v: null, label: "off" },
  { v: 1 * DAY, label: "1 day" },
  { v: 7 * DAY, label: "7 days" },
  { v: 30 * DAY, label: "30 days" },
  { v: 180 * DAY, label: "6 months" },
  { v: "all", label: "all sessions" },
]
const SIZE_STEPS: { v?: Bytes; custom?: boolean; label: string }[] = [
  { v: null, label: "off" },
  { v: 10 * MB, label: "10 MB" },
  { v: 50 * MB, label: "50 MB" },
  { v: 100 * MB, label: "100 MB" },
  { v: 500 * MB, label: "500 MB" },
  { v: 1024 * MB, label: "1 GB" },
  { custom: true, label: "custom..." },
]
const KEEP_STEPS: { v?: number; custom?: boolean; label: string }[] = [
  { v: 0, label: "off (0)" },
  { v: 1, label: "1" },
  { v: 5, label: "5" },
  { v: 10, label: "10" },
  { v: 50, label: "50" },
  { v: 100, label: "100" },
  { custom: true, label: "custom..." },
]

function ageLabel(v: Age) {
  const step = AGE_STEPS.find((s) => s.v === v)
  if (step) return step.label
  if (v === null) return "off"
  if (v === "all") return "all sessions"
  const d = Math.round(v / DAY)
  return d === 1 ? "1 day" : `${d} days`
}

const tui: TuiPlugin = async (api) => {
  const register = api.command?.register
  if (!register) return

  register(() => [
    {
      title: "Vacuum",
      value: "vacuum.run",
      description: "Prune sessions by rules and reclaim database space",
      category: "Database",
      suggested: true,
      slash: { name: "vacuum", aliases: ["compactdb"] },
      async onSelect(dialog) {
        const stack = dialog ?? api.ui.dialog

        const showError = (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Vacuum",
              message: `Could not complete.\n\nDatabase: ${dbPath()}\nError: ${message}\n\nIf the database is locked, try again when OpenCode is idle (not mid-turn).`,
              onConfirm: () => stack.clear(),
            }),
          )
          stack.setSize?.("large")
        }

        const route = api.route?.current as { name?: string; params?: { sessionID?: string } } | undefined
        const activeId = route?.name === "session" ? route?.params?.sessionID : undefined

        let plan: Awaited<ReturnType<typeof planPrune>>
        try {
          plan = await planPrune({ activeId })
        } catch (err) {
          return showError(err)
        }

        const opts = readOpts()
        const rules = {
          olderThan: (opts.olderThanDays > 0 ? opts.olderThanDays * DAY : null) as Age,
          largerThanBytes: (opts.largerThanMB > 0 ? opts.largerThanMB * MB : null) as Bytes,
          keepPerFolder: opts.keepPerFolder,
          protectShared: opts.protectShared,
        }

        const match = () => applyRules(plan.sessions, rules)

        type V = { kind: "rule"; rule: "age" | "size" | "keep" | "shared" } | { kind: "action"; action: "prune" | "vacuum" }

        const pad = (label: string, value: string) => `${label.padEnd(18)}${value}`

        const buildOptions = () => {
          const { matches, estReclaim } = match()
          const sizeLabel = rules.largerThanBytes === null ? "off" : fmtBytes(rules.largerThanBytes)
          const keepLabel = rules.keepPerFolder > 0 ? String(rules.keepPerFolder) : "off (0)"
          return [
            {
              title: pad("Older than", ageLabel(rules.olderThan)),
              value: { kind: "rule", rule: "age" } as V,
              description: "Delete sessions whose last activity is older than this",
              category: "Rules",
            },
            {
              title: pad("Larger than", sizeLabel),
              value: { kind: "rule", rule: "size" } as V,
              description: "Also delete sessions bigger than this size",
              category: "Rules",
            },
            {
              title: pad("Keep per folder", keepLabel),
              value: { kind: "rule", rule: "keep" } as V,
              description: "Always keep at least this many of the newest sessions per folder",
              category: "Rules",
            },
            {
              title: pad("Protect shared", rules.protectShared ? "on" : "off"),
              value: { kind: "rule", rule: "shared" } as V,
              description: "Never delete sessions that have been shared",
              category: "Rules",
            },
            {
              title:
                matches.length > 0
                  ? `Clear & prune  -  ${matches.length} session(s)  (~${fmtBytes(estReclaim)})  +  VACUUM`
                  : "Clear & prune  -  no sessions match",
              value: { kind: "action", action: "prune" } as V,
              description: "Permanently delete the matching sessions, then reclaim space",
              category: "Run",
            },
            {
              title: "Vacuum only",
              value: { kind: "action", action: "vacuum" } as V,
              description: "Reclaim free pages without deleting anything",
              category: "Run",
            },
          ]
        }

        // DialogSelect remounts on every `replace`, so we re-render on each change
        // and pass `current` to keep the cursor on the row that was just edited.
        const openPanel = (current?: V) => {
          const { matches, estReclaim } = match()
          stack.replace(() =>
            api.ui.DialogSelect<V>({
              title: `OpenCode Vacuum  -  ${fmtBytes(plan.dbSize)}  -  delete ${matches.length}/${plan.totalSessions} (~${fmtBytes(estReclaim)})`,
              placeholder: "Enter changes a rule; pick Clear & prune to run",
              options: buildOptions(),
              current,
              onSelect: (opt) => {
                const v = opt?.value
                if (!v) return
                if (v.kind === "rule") return editRule(v.rule)
                if (v.action === "vacuum") return confirmVacuumOnly()
                const m = match()
                if (m.matches.length === 0) {
                  api.ui.toast?.({ variant: "warning", message: "No sessions match the current rules." })
                  return openPanel({ kind: "action", action: "prune" })
                }
                confirmPrune(m.matches, m.estReclaim)
              },
            }),
          )
          stack.setSize?.("xlarge")
        }

        const cycle = <T extends { custom?: boolean }>(steps: T[], matchIdx: number, set: (s: T) => void, onCustom: () => void) => {
          const next = steps[(matchIdx + 1) % steps.length]
          if (next.custom) onCustom()
          else set(next)
        }

        const promptNumber = (title: string, current: string, onValue: (n: number) => void, back: V) => {
          stack.replace(() =>
            api.ui.DialogPrompt({
              title,
              value: current,
              placeholder: "enter a number",
              onConfirm: (raw) => {
                const n = Number(String(raw).trim())
                if (Number.isFinite(n) && n >= 0) onValue(n)
                openPanel(back)
              },
              onCancel: () => openPanel(back),
            }),
          )
          stack.setSize?.("medium")
        }

        const editRule = (rule: "age" | "size" | "keep" | "shared") => {
          const here: V = { kind: "rule", rule }
          if (rule === "age") {
            const i = AGE_STEPS.findIndex((s) => s.v === rules.olderThan)
            cycle(AGE_STEPS, i, (s) => (rules.olderThan = s.v), () => {})
            return openPanel(here)
          }
          if (rule === "size") {
            const i = SIZE_STEPS.findIndex((s) => !s.custom && s.v === rules.largerThanBytes)
            return cycle(
              SIZE_STEPS,
              i,
              (s) => {
                rules.largerThanBytes = s.v ?? null
                openPanel(here)
              },
              () =>
                promptNumber(
                  "Delete sessions larger than (MB)",
                  rules.largerThanBytes ? String(Math.round(rules.largerThanBytes / MB)) : "",
                  (n) => (rules.largerThanBytes = n > 0 ? Math.round(n * MB) : null),
                  here,
                ),
            )
          }
          if (rule === "keep") {
            const i = KEEP_STEPS.findIndex((s) => !s.custom && s.v === rules.keepPerFolder)
            return cycle(
              KEEP_STEPS,
              i,
              (s) => {
                rules.keepPerFolder = s.v ?? 0
                openPanel(here)
              },
              () => promptNumber("Keep at least N newest per folder", String(rules.keepPerFolder), (n) => (rules.keepPerFolder = Math.round(n)), here),
            )
          }
          rules.protectShared = !rules.protectShared
          openPanel(here)
        }

        const confirmPrune = (matches: ReturnType<typeof match>["matches"], estReclaim: number) => {
          const top = matches.slice(0, 8).map((s) => `  ${fmtBytes(s.bytes).padStart(9)}  ${s.title.slice(0, 50)}`)
          const more = matches.length - Math.min(8, matches.length)
          const message = [
            `Delete ${matches.length} session(s), freeing ~${fmtBytes(estReclaim)}, then VACUUM?`,
            "",
            ...top,
            ...(more > 0 ? [`  ... and ${more} more`] : []),
            "",
            "This permanently removes those sessions and their history.",
          ].join("\n")
          stack.replace(() =>
            api.ui.DialogConfirm({
              title: "OpenCode Vacuum",
              message,
              onConfirm: () => void run(matches),
              onCancel: () => openPanel({ kind: "action", action: "prune" }),
            }),
          )
          stack.setSize?.("large")
        }

        const confirmVacuumOnly = () => {
          stack.replace(() =>
            api.ui.DialogConfirm({
              title: "OpenCode Vacuum",
              message: `Run VACUUM on ${fmtBytes(plan.dbSize)} to defragment and reclaim any free pages? No sessions are deleted.`,
              onConfirm: () => void run([]),
              onCancel: () => openPanel({ kind: "action", action: "vacuum" }),
            }),
          )
          stack.setSize?.("large")
        }

        const run = async (matches: ReturnType<typeof match>["matches"]) => {
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Vacuum",
              message: matches.length ? "Pruning sessions and vacuuming the database..." : "Vacuuming the database...",
              onConfirm: () => {},
            }),
          )
          stack.setSize?.("large")
          await tick()

          const result: { deleted: typeof matches; failed: typeof matches } = { deleted: [], failed: [] }
          let done = 0
          for (const s of matches) {
            try {
              const res: any = await api.client.session.delete({ sessionID: s.id })
              if (res && res.error) result.failed.push(s)
              else result.deleted.push(s)
            } catch {
              result.failed.push(s)
            }
            done++
            if (done % 5 === 0 || done === matches.length) {
              api.ui.toast?.({ message: `Deleting sessions ${done}/${matches.length}...` })
            }
          }

          await tick()
          let vac: Awaited<ReturnType<typeof vacuum>>
          try {
            vac = await vacuum()
          } catch (err) {
            return showError(err)
          }
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Vacuum",
              message: buildResultMessage(result, vac),
              onConfirm: () => stack.clear(),
            }),
          )
          stack.setSize?.("large")
        }

        openPanel()
      },
    },
  ])
}

export default { id: "opencode-vacuum", tui }
