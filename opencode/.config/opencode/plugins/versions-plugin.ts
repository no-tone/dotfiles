// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-versions TUI plugin.
//
// Registers a `/versions` slash command that checks pinned plugin versions
// against the npm registry and offers to bump them — no @latest needed.
//
// IMPORTANT: TUI plugins are NOT auto-discovered from the plugin/ directory.
// This file must be referenced from `tui.json`:
//   { "plugin": ["./plugins/versions-plugin.ts"] }
//
// The engine lives in ./versions.mjs.

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { buildResultMessage, checkVersions, configPath, readConfig, applyVersion, writeConfig } from "./versions.mjs"

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const tui: TuiPlugin = async (api) => {
  const register = api.command?.register
  if (!register) return

  register(() => [
    {
      title: "Versions",
      value: "versions.check",
      description: "Check pinned plugin versions against npm registry",
      category: "Maintenance",
      suggested: true,
      slash: { name: "versions", aliases: ["updates", "check-versions"] },
      async onSelect(dialog) {
        const stack = dialog ?? api.ui.dialog

        const showError = (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Versions",
              message: `Could not check versions.\n\nError: ${message}`,
              onConfirm: () => stack.clear(),
            }),
          )
          stack.setSize?.("large")
        }

        // 1. Show loading state
        stack.replace(() =>
          api.ui.DialogAlert({
            title: "OpenCode Versions",
            message: "Checking pinned plugins against npm registry...",
            onConfirm: () => {},
          }),
        )
        stack.setSize?.("large")
        await tick()

        // 2. Run check
        let data: Awaited<ReturnType<typeof checkVersions>>
        try {
          data = await checkVersions()
        } catch (err) {
          return showError(err)
        }

        const outdated = data.results.filter((p) => p.outdated)

        // 3. Show results
        if (outdated.length === 0) {
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Versions",
              message: buildResultMessage(data.results),
              onConfirm: () => stack.clear(),
            }),
          )
          stack.setSize?.("large")
          return
        }

        // 4. Updates available — confirm
        stack.replace(() =>
          api.ui.DialogConfirm({
            title: "OpenCode Versions",
            message: `${buildResultMessage(data.results)}\n\nUpdate all ${outdated.length} plugin(s) in ${configPath()}?`,
            onConfirm: () => void applyUpdates(data),
            onCancel: () => stack.clear(),
          }),
        )
        stack.setSize?.("large")

        async function applyUpdates(data: Awaited<ReturnType<typeof checkVersions>>) {
          // Show progress
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Versions",
              message: `Updating ${outdated.length} plugin(s)...`,
              onConfirm: () => {},
            }),
          )
          stack.setSize?.("large")
          await tick()

          const updates = data.results.filter((p) => p.outdated && p.latest)
          const newRaw = applyVersion(data.raw, updates)
          try {
            writeConfig(data.file, newRaw)
          } catch (err) {
            return showError(err)
          }

          const updatedList = updates.map((p) => `  ${p.name}  ${p.current} → ${p.latest}`).join("\n")
          stack.replace(() =>
            api.ui.DialogAlert({
              title: "OpenCode Versions",
              message: `Updated ${updates.length} plugin(s):\n\n${updatedList}\n\nRestart OpenCode to load the new versions.`,
              onConfirm: () => stack.clear(),
            }),
          )
          stack.setSize?.("large")
        }
      },
    },
  ])
}

export default { id: "opencode-versions", tui }