// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-versions engine.
//
// Backs the `/versions` slash command (see ./versions-plugin.ts). It:
//   1. Reads OpenCode's config file and finds all pinned plugins (name@version).
//   2. Queries the npm registry for the latest version of each.
//   3. Reports which are outdated.
//   4. Can update the version strings in-place (preserving JSONC comments).
//   5. Sorts the plugin package cache into what is live, what is an old version
//      of a plugin still in use, and what nothing references any more — and can
//      delete the last two (see "plugin cache" below).
//
// Paths and formatting come from ./shared.mjs.

import fs from "node:fs"
import path from "node:path"
import { dirSize, fmtBytes, xdgDir } from "./shared.mjs"

// ---- config path ------------------------------------------------------------

// The config file this command reads and rewrites.
//
// Overrides, in order:
//   OPENCODE_CONFIG_PATH  ours — point the command at one file (used by tests)
//   OPENCODE_CONFIG       OpenCode's own variable: an extra config file, loaded
//                         on top of the global one. If it is set it is the file
//                         being steered with, so prefer it.
// Otherwise the global config, which is what this repo stows.
export function configPath() {
  const explicit = process.env.OPENCODE_CONFIG_PATH || process.env.OPENCODE_CONFIG
  if (explicit) return explicit
  const dir = xdgDir("config")
  // OpenCode looks for opencode.jsonc first, then opencode.json
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return path.join(dir, "opencode.jsonc")
}

// ---- read pinned plugins ----------------------------------------------------

// Turn JSONC into JSON: strip // and /* */ comments and drop trailing commas,
// without breaking URLs (a "//" inside a string is not a comment) or commas
// inside strings. String literals are copied through whole, so the lookahead
// below only ever runs on structural characters.
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
    if (c === ",") {
      // JWCC allows a trailing comma, JSON.parse does not: skip a comma whose
      // next non-whitespace character closes the object or array.
      let j = i + 1
      while (j < str.length && /\s/.test(str[j])) j++
      if (str[j] === "}" || str[j] === "]") { i++; continue }
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
export function findPinned(plugins) {
  const pinned = []
  for (const entry of plugins) {
    if (typeof entry !== "string") continue
    const { name, version } = parseEntry(entry)
    if (!version) continue // unpinned, or a local file plugin
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

// Check all pinned plugins. `results` is
// [{ rawEntry, name, current, latest, outdated, error? }]; `plugins` is the
// config's plugin array verbatim, which `scanPackages` needs.
export async function checkVersions({ file = configPath() } = {}) {
  const { raw, config } = readConfig(file)
  if (!Array.isArray(config.plugin)) return { file, results: [], raw, plugins: [] }

  const pinned = findPinned(config.plugin)
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

  return { file, results: mapped, raw, plugins: config.plugin }
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

// The plugin entries as they will read after `applyVersion`, so the cache can be
// rescanned against the new pins (which turns the versions just replaced stale).
export function bumpedPlugins(plugins, updates) {
  return plugins.map((entry) => {
    const u = updates.find((p) => p.rawEntry === entry)
    return u?.latest ? `${u.name}@${u.latest}` : entry
  })
}

// ---- plugin cache -----------------------------------------------------------
//
// OpenCode installs every npm plugin into its own directory under
// <cache>/opencode/packages/, named after the config entry
// ("oh-my-opencode-slim@2.2.17"), each with a full node_modules of its own
// (tens to hundreds of MB). Bumping a pin therefore *adds* a directory — the old
// one is never touched again — and dropping a plugin from the config leaves its
// directory behind for good. `scanPackages` sorts the whole cache out.

export function packagesDir() {
  // OPENCODE_PACKAGES_DIR is ours, not OpenCode's (used by tests).
  return process.env.OPENCODE_PACKAGES_DIR || path.join(xdgDir("cache"), "packages")
}

// Split a plugin config entry into { name, version }. Scoped names keep their
// leading "@"; an unpinned entry or a local file path gets a null version.
export function parseEntry(entry) {
  const at = entry.lastIndexOf("@")
  if (at < 1) return { name: entry, version: null }
  return { name: entry.slice(0, at), version: entry.slice(at + 1) }
}

function isPackageDir(dir) {
  return fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, "node_modules"))
}

// Every installed package directory in the cache. A scoped entry becomes a
// "@scope" parent with the package inside it, so descend one level into any
// "@..." directory that is not itself an install.
function listPackageDirs(root) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out // no cache yet
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    if (isPackageDir(dir)) out.push(dir)
    else if (e.name.startsWith("@")) out.push(...listPackageDirs(dir))
  }
  return out
}

// What is actually installed in a cache directory. OpenCode writes a
// package.json holding exactly one dependency, which is authoritative — the
// directory name is not, since Windows cannot spell the "/" of a scoped name.
function readInstalled(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"))
    const deps = Object.entries(pkg.dependencies ?? {})
    if (deps.length === 1) return { name: deps[0][0], version: String(deps[0][1]) }
  } catch {
    // missing or unreadable package.json — a half-finished install. The caller
    // falls back to the directory name.
  }
  return null
}

// Every JSON/JSONC config file next to the main config, comments stripped, as
// one blob. Used to tell "nothing references this package" from "something other
// than the plugin list does" — an MCP server command, another plugin's config.
// Comments are stripped so that a package merely *mentioned* in a note does not
// protect itself forever.
function configBlob(file) {
  let blob = ""
  const dir = path.dirname(file)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return blob
  }
  for (const name of names) {
    if (!/\.jsonc?$/i.test(name)) continue
    try {
      blob += stripJsonc(fs.readFileSync(path.join(dir, name), "utf-8")) + "\n"
    } catch {
      // unreadable — skip
    }
  }
  return blob
}

// Sort the package cache into four buckets, given the config's plugin list.
//
//   keep       the live directory of each configured plugin.
//   stale      a configured plugin at a version the config no longer asks for.
//   unused     no configured plugin, and no mention anywhere in the JSON config
//              files: a plugin that was dropped, or a one-off experiment.
//   referenced not a configured plugin, but named in a config file — an MCP
//              server's package, say. Reported, never offered for deletion.
//
// `stale` and `unused` are safe to delete: OpenCode reinstalls on demand.
export function scanPackages({ plugins = [], dir = packagesDir(), file = configPath(), sizes = true } = {}) {
  const wanted = new Map() // name -> { entry, version }
  for (const entry of plugins) {
    if (typeof entry !== "string") continue
    if (/^[.~/\\]/.test(entry) || /^[a-zA-Z]:[\\/]/.test(entry)) continue // local file plugin
    const { name, version } = parseEntry(entry)
    wanted.set(name, { entry, version })
  }

  const byName = new Map()
  const outside = []
  for (const p of listPackageDirs(dir)) {
    const label = path.relative(dir, p).split(path.sep).join("/")
    const installed = readInstalled(p)
    const item = {
      path: p,
      label,
      name: installed?.name ?? parseEntry(label).name,
      version: installed?.version ?? null,
    }
    if (!wanted.has(item.name)) {
      outside.push(item)
      continue
    }
    if (!byName.has(item.name)) byName.set(item.name, [])
    byName.get(item.name).push(item)
  }

  const keep = []
  const stale = []
  for (const [name, items] of byName) {
    const { entry, version } = wanted.get(name)
    // Unpinned, or a semver range: OpenCode resolves it at startup, so we
    // cannot know which directory is current. Leave the whole set alone.
    if (!version || !/^[0-9]/.test(version)) {
      keep.push(...items)
      continue
    }
    // The live directory is the one named after the config entry; Windows
    // replaces the "/" of a scoped name, so accept that spelling too.
    const live = new Set([entry, entry.replace("/", "_")])
    let current = items.filter((i) => live.has(i.label))
    // Nothing carries the expected name (renamed cache, different sanitising):
    // fall back to what each package.json says is installed.
    if (current.length === 0) current = items.filter((i) => i.version === version)
    for (const i of items) (current.includes(i) ? keep : stale).push(i)
  }

  const blob = outside.length > 0 ? configBlob(file) : ""
  const unused = []
  const referenced = []
  for (const i of outside) (blob.includes(i.name) ? referenced : unused).push(i)

  if (sizes) for (const i of [...stale, ...unused, ...referenced]) i.bytes = dirSize(i.path)
  return { dir, file, keep, stale, unused, referenced }
}

// Delete cached package directories. Each one is re-checked before removal: it
// must sit inside the packages directory and still look like a package install.
//
// A directory whose plugin is loaded in this session can fail here (Windows
// locks files that are open). That is reported, not fatal — the next /versions
// run sees it again and retries.
export function removePackages(items, { dir = packagesDir() } = {}) {
  const removed = []
  const failed = []
  let freed = 0
  for (const item of items) {
    try {
      const rel = path.relative(dir, item.path)
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("outside the packages directory")
      if (!isPackageDir(item.path)) throw new Error("not a package directory")
      fs.rmSync(item.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      removed.push(item)
      freed += item.bytes ?? 0
    } catch (err) {
      failed.push({ ...item, error: err.message })
    }
  }
  pruneEmptyScopes(dir)
  return { removed, failed, freed }
}

// A "@scope" directory left empty by the removals is dead weight too.
function pruneEmptyScopes(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("@")) continue
    const scope = path.join(dir, e.name)
    try {
      if (fs.readdirSync(scope).every((n) => n === ".DS_Store")) fs.rmSync(scope, { recursive: true, force: true })
    } catch {
      // leave it; harmless
    }
  }
}

// ---- formatting -------------------------------------------------------------

export function fmtVersion(pkg) {
  if (pkg.error) return `${pkg.name}  ${pkg.current}  ✗ ${pkg.error}`
  if (pkg.outdated) return `${pkg.name}  ${pkg.current} → ${pkg.latest}`
  return `${pkg.name}  ${pkg.current}  ✓`
}

export function totalBytes(items) {
  return items.reduce((sum, i) => sum + (i.bytes ?? 0), 0)
}

// One "  <size>  <label>" line per directory, biggest first.
export function fmtPackageList(items, limit = 8) {
  const sorted = [...items].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  const lines = sorted
    .slice(0, limit)
    .map((i) => `  ${fmtBytes(i.bytes ?? 0).padStart(9)}  ${i.label}${i.version ? "" : "  (incomplete install)"}`)
  if (sorted.length > limit) lines.push(`  ... and ${sorted.length - limit} more`)
  return lines
}

export function buildVersionLines(results) {
  if (results.length === 0) return ["No pinned plugins found."]
  return results.map((p) => `  ${fmtVersion(p)}`)
}

// The outcome of a `removePackages` run.
export function buildCleanupLines(result) {
  const lines = []
  if (result.removed.length > 0) {
    lines.push(`Removed ${result.removed.length} cached package(s), freeing ${fmtBytes(result.freed)}.`)
  } else if (result.failed.length === 0) {
    lines.push("Nothing needed removing.")
  }
  if (result.failed.length > 0) {
    lines.push(`Could not remove ${result.failed.length} — retry after restarting OpenCode:`)
    for (const f of result.failed.slice(0, 5)) lines.push(`  ${f.label}  ✗ ${f.error}`)
  }
  return lines
}
