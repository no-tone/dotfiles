// SPDX-License-Identifier: GPL-3.0-or-later
// opencode-vacuum engine.
//
// Backs the `/vacuum` slash command (see ./vacuum-plugin.ts). It:
//   1. reads OpenCode's local SQLite database READ-ONLY and works out which old /
//      redundant sessions are safe to prune (heuristics, fully customizable), and
//   2. runs SQLite `VACUUM` to actually shrink the file after the sessions are
//      gone.
//
// It never deletes sessions itself. The plugin deletes them through OpenCode's
// own `client.session.delete` (which "permanently removes all associated data,
// including messages and history"), so the live server tears down its own state
// correctly. This engine only does the read-only planning and the final VACUUM.
//
// VACUUM only reclaims pages freed by deletions; with nothing deleted it just
// defragments. Prefers `bun:sqlite` (OpenCode's runtime), falls back to the
// built-in `node:sqlite` (Node 22+).

import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DAY = 86_400_000

// ---- config -----------------------------------------------------------------

// Env vars seed the picker's initial rule values; everything is then adjustable
// live in the /vacuum settings panel. A rule of 0 (or off) means "disabled".
export function readOpts(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key]
    if (raw === undefined || raw === "") return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const bool = (key, fallback) => {
    const raw = env[key]
    if (raw === undefined || raw === "") return fallback
    return !/^(0|false|no|off)$/i.test(raw.trim())
  }
  return {
    olderThanDays: num("OPENCODE_VACUUM_OLDER_THAN_DAYS", 30), // delete sessions older than this (0 = off)
    largerThanMB: num("OPENCODE_VACUUM_LARGER_THAN_MB", 0), // also delete sessions bigger than this (0 = off)
    keepPerFolder: num("OPENCODE_VACUUM_KEEP_PER_FOLDER", 5), // always keep at least N newest per folder (0 = off)
    protectShared: bool("OPENCODE_VACUUM_PROTECT_SHARED", true), // never delete shared sessions
  }
}

// Resolve the OpenCode database path the same way OpenCode does (XDG aware),
// with optional overrides for non-standard setups.
export function dbPath() {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB
  const data =
    process.env.OPENCODE_DATA_DIR ??
    (process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode")
      : path.join(os.homedir(), ".local", "share", "opencode"))
  return path.join(data, "opencode.db")
}

// ---- sqlite (bun:sqlite preferred, node:sqlite fallback) --------------------

async function open(file, { readonly }) {
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, readonly ? { readonly: true } : {})
    return {
      all: (sql) => db.query(sql).all(),
      exec: (sql) => db.run(sql),
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file, { readOnly: !!readonly })
  return {
    all: (sql) => db.prepare(sql).all(),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

// ---- planning (read-only) ---------------------------------------------------

const PLAN_SQL = `
  SELECT
    s.id          AS id,
    s.project_id  AS project,
    s.parent_id   AS parent,
    s.title       AS title,
    s.directory   AS dir,
    s.time_created AS created,
    s.time_updated AS updated,
    s.share_url   AS share,
    s.time_archived AS archived,
    COALESCE(ev.bytes, 0) AS bytes
  FROM session s
  LEFT JOIN (
    SELECT aggregate_id, SUM(LENGTH(data)) AS bytes FROM event GROUP BY aggregate_id
  ) ev ON ev.aggregate_id = s.id
`

function projectLabel(dir, projectId) {
  if (dir) {
    const parts = String(dir).split("/").filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return projectId ?? "?"
}

// Read every session, read-only, annotated with what the rules need: age, byte
// size (from the event log), folder, whether it is shared, and whether it is in
// the active session's tree. No rules are applied here; that is `applyRules`.
export async function planPrune({ file = dbPath(), now = Date.now(), activeId } = {}) {
  const db = await open(file, { readonly: true })
  let rows
  try {
    rows = db.all(PLAN_SQL)
  } finally {
    db.close()
  }

  // The active session, its parent, and its direct children are never touched,
  // so we never break the tree the user is sitting in.
  const activeTree = new Set()
  if (activeId) {
    activeTree.add(activeId)
    for (const r of rows) {
      if (r.id === activeId && r.parent) activeTree.add(r.parent)
      if (r.parent === activeId) activeTree.add(r.id)
    }
  }

  const sessions = rows.map((r) => ({
    id: r.id,
    title: r.title || "(untitled)",
    project: projectLabel(r.dir, r.project),
    updated: r.updated ?? 0,
    bytes: r.bytes ?? 0,
    age: now - (r.updated ?? now),
    shared: !!r.share,
    active: activeTree.has(r.id),
  }))

  return { file, now, totalSessions: rows.length, sessions, dbSize: fileSize(file) }
}

// Select sessions to delete from the annotated list, given the user's rules.
// Pure function (easy to test), mutates nothing.
//
// rules:
//   olderThan       number ms | "all" | null   delete sessions older than this
//   largerThanBytes number | null              also delete sessions bigger than this
//   keepPerFolder   number                      always keep the N newest per folder
//   protectShared   boolean                     never delete shared sessions
//
// A session is deleted when it is not protected (active tree, shared if
// protected, or among the newest N in its folder) and matches the age rule OR
// the size rule.
export function applyRules(sessions, rules) {
  const { olderThan, largerThanBytes, keepPerFolder = 0, protectShared = true } = rules

  const folders = new Map()
  for (const s of sessions) {
    const key = s.project ?? "?"
    if (!folders.has(key)) folders.set(key, [])
    folders.get(key).push(s)
  }
  const rank = new Map()
  for (const list of folders.values()) {
    ;[...list].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).forEach((s, i) => rank.set(s.id, i + 1))
  }

  const matches = []
  for (const s of sessions) {
    if (s.active) continue
    if (protectShared && s.shared) continue
    if (keepPerFolder > 0 && (rank.get(s.id) ?? 0) <= keepPerFolder) continue
    const ageMatch = olderThan === "all" || (typeof olderThan === "number" && s.age > olderThan)
    const sizeMatch = typeof largerThanBytes === "number" && s.bytes > largerThanBytes
    if (ageMatch || sizeMatch) matches.push(s)
  }
  matches.sort((a, b) => b.bytes - a.bytes)
  return { matches, estReclaim: matches.reduce((sum, s) => sum + s.bytes, 0) }
}

// ---- vacuum -----------------------------------------------------------------

// Spawns a child process for the actual VACUUM because:
//   1. VACUUM requires exclusive access — openCode's own DB connection would
//      block it if run inline.
//   2. openCode's bundled JS runtime may not expose node:sqlite (or may have
//      restricted module loading), while the system Node.js definitely does.
//   3. The child gets a clean SQLite connection with no active statements.

export async function vacuum({ file = dbPath() } = {}) {
  const before = fileSize(file)
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "vacuum-run.mjs")
  execSync(`node "${helper}" --db "${file}"`, {
    shell: true,
    stdio: "inherit",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 1 * 1024 * 1024,
  })
  const after = fileSize(file)
  return { file, before, after, freed: Math.max(0, before - after) }
}

// ---- formatting -------------------------------------------------------------

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

export function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB"
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return `${Math.round(n)} B`
}

export function fmtAge(ms) {
  const d = Math.floor(ms / DAY)
  if (d >= 365) return `${Math.floor(d / 365)}y`
  if (d >= 1) return `${d}d`
  const h = Math.floor(ms / 3_600_000)
  return `${h}h`
}

export function buildResultMessage(result, vac) {
  const lines = ["OpenCode Vacuum - done", ""]
  if (result.deleted.length || result.failed.length) {
    lines.push(`Deleted ${result.deleted.length} session(s)` + (result.failed.length ? `, ${result.failed.length} failed.` : "."))
  } else {
    lines.push("No sessions deleted.")
  }
  lines.push(`Database: ${fmtBytes(vac.before)} -> ${fmtBytes(vac.after)}  (reclaimed ${fmtBytes(vac.freed)})`)
  if (result.failed.length) {
    lines.push("", "Failed to delete:")
    for (const c of result.failed.slice(0, 5)) lines.push(`  ${c.title.slice(0, 56)}`)
  }
  return lines.join("\n")
}
