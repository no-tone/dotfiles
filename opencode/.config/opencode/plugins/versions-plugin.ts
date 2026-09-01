// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-versions TUI plugin.
//
// Registers a `/versions` slash command that opens a panel with everything to do
// with pinned plugins:
//   - Update plugins    checks each pin in opencode.jsonc against the npm
//                       registry and rewrites it in place — no @latest needed.
//   - Old versions      deletes the cache directory each superseded version left
//                       behind (OpenCode keeps a whole node_modules per pinned
//                       version, hundreds of MB each, and never cleans up).
//   - Unused packages   deletes cached packages that are neither a configured
//                       plugin nor mentioned anywhere in the JSON config —
//                       plugins that were dropped, one-off experiments.
// Updating also clears the versions it just superseded. Anything a config file
// still mentions is reported but never deleted.
//
// IMPORTANT: TUI plugins are NOT auto-discovered from the plugins/ directory.
// This file must be referenced from `tui.jsonc`:
//   { "plugin": ["./plugins/versions-plugin.ts"] }
//
// The engine lives in ./versions.mjs, shared helpers in ./shared.mjs.

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { fmtBytes } from "./shared.mjs"
import {
  applyVersion,
  buildCleanupLines,
  buildVersionLines,
  bumpedPlugins,
  checkVersions,
  fmtPackageList,
  packagesDir,
  removePackages,
  scanPackages,
  totalBytes,
  writeConfig,
} from "./versions.mjs"

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// One cached package directory, as reported by `scanPackages`.
type Pkg = {
  path: string
  label: string
  name: string
  version: string | null
  bytes?: number
}
type Scan = {
  dir: string
  file: string
  keep: Pkg[]
  stale: Pkg[]
  unused: Pkg[]
  referenced: Pkg[]
}
type Bucket = "stale" | "unused"
type Action = { kind: "update" } | { kind: "clear"; bucket: Bucket } | { kind: "report" }

const BUCKETS: Record<Bucket, { title: string; blurb: string; note: string }> = {
  stale: {
    title: "Clear old versions",
    blurb: "Cached versions of plugins you still use, other than the one pinned now",
    note: "The pinned version stays. OpenCode keeps running the code it already loaded until you restart.",
  },
  unused: {
    title: "Clear unused packages",
    blurb: "Cached packages that no plugin entry and no config file mentions",
    note: "Nothing in your OpenCode config refers to these. OpenCode reinstalls whatever it needs, so this only costs a download.",
  },
}

const tui: TuiPlugin = async (api) => {
  const register = api.command?.register
  if (!register) return

  register(() => [
    {
      title: "Versions",
      value: "versions.check",
      description: "Update pinned plugins and clear the plugin package cache",
      category: "Maintenance",
      suggested: true,
      slash: { name: "versions", aliases: ["updates", "check-versions"] },
      async onSelect(dialog) {
        const stack = dialog ?? api.ui.dialog

        // A step that is still working, vs. the last dialog of a run.
        const progress = (message: string) => {
          stack.replace(() =>
            api.ui.DialogAlert({ title: "OpenCode Versions", message, onConfirm: () => {} }),
          )
          stack.setSize?.("large")
        }
        const alert = (message: string, onConfirm: () => void) => {
          stack.replace(() => api.ui.DialogAlert({ title: "OpenCode Versions", message, onConfirm }))
          stack.setSize?.("large")
        }
        const confirm = (message: string, onConfirm: () => void, onCancel: () => void) => {
          stack.replace(() =>
            api.ui.DialogConfirm({ title: "OpenCode Versions", message, onConfirm, onCancel }),
          )
          stack.setSize?.("large")
        }
        const showError = (err: unknown, what: string) => {
          const message = err instanceof Error ? err.message : String(err)
          alert(`Could not ${what}.\n\nError: ${message}`, () => stack.clear())
        }

        // 1. Loading state — the registry check is a network round trip per
        //    plugin, and sizing the cache walks a lot of node_modules.
        progress("Checking pinned plugins against the npm registry...")
        await tick()

        let data: Awaited<ReturnType<typeof checkVersions>>
        try {
          data = await checkVersions()
        } catch (err) {
          return showError(err, "read the plugin versions")
        }

        // 2. Mutable view of the world, refreshed after every action.
        let plugins: unknown[] = data.plugins
        let results = data.results
        const rescan = (): Scan => {
          try {
            return scanPackages({ plugins, file: data.file }) as Scan
          } catch {
            return { dir: packagesDir(), file: data.file, keep: [], stale: [], unused: [], referenced: [] }
          }
        }
        let scan = rescan()

        const outdated = () => results.filter((p) => p.outdated)
        const reclaimable = () => totalBytes(scan.stale) + totalBytes(scan.unused)

        const report = () =>
          [
            "OpenCode Versions",
            "",
            `Config: ${data.file}`,
            ...buildVersionLines(results),
            "",
            `Package cache: ${scan.dir}`,
            `  ${scan.keep.length} live, ${scan.stale.length} old version(s), ${scan.unused.length} unused, ${scan.referenced.length} referenced elsewhere`,
            ...(scan.stale.length > 0 ? ["", "Old versions of plugins in use:", ...fmtPackageList(scan.stale)] : []),
            ...(scan.unused.length > 0 ? ["", "Unused — nothing in the config mentions these:", ...fmtPackageList(scan.unused)] : []),
            ...(scan.referenced.length > 0
              ? ["", "Kept — named in a config file, so something else may need them:", ...fmtPackageList(scan.referenced)]
              : []),
          ].join("\n")

        const pad = (label: string, value: string) => `${label.padEnd(24)}${value}`

        const buildOptions = () => {
          const out = outdated()
          const options = [
            {
              title: pad("Update plugins", out.length > 0 ? `${out.length} outdated` : "all up to date"),
              value: { kind: "update" } as Action,
              description:
                out.length > 0
                  ? out.map((p) => `${p.name} ${p.current} → ${p.latest}`).join(", ")
                  : "Re-pin every plugin in opencode.jsonc to its latest npm version",
              category: "Plugins",
            },
          ]
          for (const bucket of ["stale", "unused"] as Bucket[]) {
            const items = scan[bucket]
            options.push({
              title: pad(
                BUCKETS[bucket].title,
                items.length > 0 ? `${items.length} dir(s)  (${fmtBytes(totalBytes(items))})` : "nothing to clear",
              ),
              value: { kind: "clear", bucket } as Action,
              description: BUCKETS[bucket].blurb,
              category: "Cache",
            })
          }
          const cached = scan.keep.length + scan.stale.length + scan.unused.length + scan.referenced.length
          options.push({
            title: pad("View report", `${cached} cached package(s)`),
            value: { kind: "report" } as Action,
            description: "Full version list and what is in the package cache",
            category: "Cache",
          })
          return options
        }

        // DialogSelect remounts on every `replace`, so the panel is rebuilt on
        // each change and `current` keeps the cursor where it was.
        const openPanel = (current?: Action) => {
          const out = outdated()
          const summary = [
            out.length > 0 ? `${out.length} outdated` : "up to date",
            reclaimable() > 0 ? `${fmtBytes(reclaimable())} reclaimable` : "cache clean",
          ].join("  -  ")
          stack.replace(() =>
            api.ui.DialogSelect<Action>({
              title: `OpenCode Versions  -  ${summary}`,
              placeholder: "Enter runs the highlighted action",
              options: buildOptions(),
              current,
              onSelect: (opt) => {
                const v = opt?.value
                if (!v) return
                if (v.kind === "report") return alert(report(), () => openPanel(v))
                if (v.kind === "update") {
                  if (outdated().length === 0) {
                    api.ui.toast?.({ variant: "warning", message: "Every pinned plugin is already at its latest version." })
                    return openPanel(v)
                  }
                  return confirmUpdate()
                }
                if (scan[v.bucket].length === 0) {
                  api.ui.toast?.({ variant: "warning", message: `Nothing to clear: ${BUCKETS[v.bucket].title.toLowerCase()}.` })
                  return openPanel(v)
                }
                return confirmClear(v.bucket)
              },
            }),
          )
          stack.setSize?.("xlarge")
        }

        const confirmUpdate = () => {
          const updates = outdated()
          const alsoClears =
            scan.stale.length > 0
              ? `\nThe ${scan.stale.length} old version(s) already cached (${fmtBytes(totalBytes(scan.stale))}) are cleared too.`
              : ""
          confirm(
            [
              `Update ${updates.length} plugin(s) in ${data.file}?`,
              "",
              ...updates.map((p) => `  ${p.name}  ${p.current} → ${p.latest}`),
              "",
              `Comments and formatting are preserved. Each superseded version's cache directory is deleted.${alsoClears}`,
            ].join("\n"),
            () => void runUpdate(),
            () => openPanel({ kind: "update" }),
          )
        }

        const confirmClear = (bucket: Bucket) => {
          const items = scan[bucket]
          confirm(
            [
              `Delete ${items.length} cached package(s), freeing ${fmtBytes(totalBytes(items))}?`,
              "",
              ...fmtPackageList(items),
              "",
              BUCKETS[bucket].note,
            ].join("\n"),
            () => void runClear(bucket),
            () => openPanel({ kind: "clear", bucket }),
          )
        }

        const runUpdate = async () => {
          const updates = outdated().filter((p) => p.latest)
          progress(`Updating ${updates.length} plugin(s) in ${data.file}...`)
          await tick()

          try {
            writeConfig(data.file, applyVersion(data.raw, updates))
          } catch (err) {
            return showError(err, "write the config file")
          }

          // The config now pins the new versions, so the ones just replaced are
          // leftovers: rescan against the new pins and clear what that turns up.
          plugins = bumpedPlugins(plugins, updates)
          results = results.map((p) => (p.outdated && p.latest ? { ...p, current: p.latest, outdated: false } : p))
          progress(`Updated ${updates.length} plugin(s). Clearing superseded versions...`)
          await tick()
          scan = rescan()
          const cleanup = scan.stale.length > 0 ? removePackages(scan.stale) : null
          scan = rescan()

          alert(
            [
              `Updated ${updates.length} plugin(s):`,
              "",
              ...updates.map((p) => `  ${p.name}  ${p.current} → ${p.latest}`),
              ...(cleanup ? ["", ...buildCleanupLines(cleanup)] : []),
              "",
              "Restart OpenCode to load the new versions.",
            ].join("\n"),
            () => openPanel({ kind: "update" }),
          )
        }

        const runClear = async (bucket: Bucket) => {
          const items = scan[bucket]
          progress(`Deleting ${items.length} cached package(s)...`)
          await tick()
          const result = removePackages(items)
          scan = rescan()
          alert(buildCleanupLines(result).join("\n"), () => openPanel({ kind: "clear", bucket }))
        }

        openPanel()
      },
    },
  ])
}

export default { id: "opencode-versions", tui }
