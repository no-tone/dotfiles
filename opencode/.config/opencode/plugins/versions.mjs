// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-versions engine.
//
// Backs the `/versions` slash command (see ./versions-plugin.ts). It:
//   1. Reads opencode's config file and finds all pinned plugins (name@version).
//   2. Queries the npm registry for the latest version of each.
//   3. Reports which are outdated.
//   4. Can update the version strings in-place (preserving JSONC comments).
//
// Future: could also check globally-installed MCP npm packages.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ---- config path ------------------------------------------------------------

// Resolve the opencode config path the same way opencode does (XDG aware).
export function configPath() {
  if (process.env.OPENCODE_CONFIG_PATH) return process.env.OPENCODE_CONFIG_PATH
  const dir =
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(os.homedir(), ".config", "opencode")
  // opencode looks for opencode.jsonc first, then opencode.json
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return path.join(dir, "opencode.jsonc")
}

// ---- read pinned plugins ----------------------------------------------------

// Strip JSONC comments (// and /* */) without breaking URLs in strings.
function stripJsonc(str) {
  let out = "", i = 0
  while (i < str.length) {
    const c = str[i], n = str[i + 1]
    if (c === '"') {
      // String literal — copy verbatim until matching unescaped "
      out += c; i++
      while (i < str.length) {
        if (str[i] === "\\") { out += str[i] + str[i + 1]; i += 2; continue }
        if (str[i] === '"') break
        out += str[i]; i++
      }
      out += '"'; i++
      continue
    }
    if (c === "/" && n === "/") {
      while (i < str.length && str[i] !== "\n") i++ // skip line
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++
      i += 2 // skip */
      continue
    }
    out += c; i++
  }
  return out
}

export function readConfig(file) {
  const raw = fs.readFileSync(file, "utf-8")
  const clean = stripJsonc(raw)
  try {
    return { raw, config: JSON.parse(clean) }
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`)
  }
}

// Extract every plugin entry that has an @version pin.
// Returns [{ rawEntry, name, current }]
export function findPinned(raw, plugins) {
  const pinned = []
  for (const entry of plugins) {
    if (typeof entry !== "string") continue
    const atIdx = entry.lastIndexOf("@")
    if (atIdx < 1) continue // no version pin or starts with @ (scoped)
    const name = entry.slice(0, atIdx)
    const version = entry.slice(atIdx + 1)
    // Skip semver ranges (^ ~ >= etc) — only exact pins like @2.1.4
    if (/^[0-9]/.test(version)) {
      pinned.push({ rawEntry: entry, name, current: version })
    }
  }
  return pinned
}

// ---- npm registry queries ---------------------------------------------------

async function fetchLatestVersion(pkg) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`npm registry ${res.status}`)
  const data = await res.json()
  return data.version
}

// Check all pinned plugins. Returns [{ rawEntry, name, current, latest, outdated, error? }]
export async function checkVersions({ file = configPath() } = {}) {
  const { raw, config } = readConfig(file)
  if (!Array.isArray(config.plugin)) return { file, results: [], raw }

  const pinned = findPinned(raw, config.plugin)
  const results = await Promise.allSettled(
    pinned.map(async (p) => {
      const latest = await fetchLatestVersion(p.name)
      return { ...p, latest, outdated: latest !== p.current }
    }),
  )

  const mapped = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value
    return { ...pinned[i], latest: null, outdated: null, error: r.reason?.message ?? String(r.reason) }
  })

  return { file, results: mapped, raw }
}

// ---- write updates back -----------------------------------------------------

// Replace "name@oldversion" with "name@newversion" in the raw file content,
// preserving all JSONC comments and formatting.
export function applyVersion(raw, updates) {
  let content = raw
  for (const { rawEntry, name, latest } of updates) {
    if (!latest) continue
    const oldStr = `"${rawEntry}"`
    const newStr = `"${name}@${latest}"`
    if (content.includes(oldStr)) {
      content = content.replace(oldStr, newStr)
    }
  }
  return content
}

export function writeConfig(file, content) {
  fs.writeFileSync(file, content, "utf-8")
}

// ---- formatting -------------------------------------------------------------

export function fmtVersion(pkg) {
  if (pkg.error) return `${pkg.name}  ${pkg.current}  ✗ ${pkg.error}`
  if (pkg.outdated) return `${pkg.name}  ${pkg.current} → ${pkg.latest}`
  return `${pkg.name}  ${pkg.current}  ✓`
}

export function buildResultMessage(results) {
  const lines = ["OpenCode Versions — check complete", ""]
  if (results.length === 0) {
    lines.push("No pinned plugins found.")
    return lines.join("\n")
  }

  let outdated = 0
  for (const p of results) {
    lines.push(`  ${fmtVersion(p)}`)
    if (p.outdated) outdated++
  }

  lines.push("")
  if (outdated > 0) {
    lines.push(`${outdated} plugin(s) outdated.`)
  } else {
    lines.push("All plugins up to date!")
  }
  return lines.join("\n")
}