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
//
// Paths and formatting come from ./shared.mjs.

import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fileSize, fmtBytes, xdgDir } from "./shared.mjs"

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

// The database file. OPENCODE_DB is OpenCode's own variable (it also accepts
// ":memory:", which has no file to vacuum); otherwise the database sits in the
// data directory, which follows XDG_DATA_HOME. See ./shared.mjs.
export function dbPath() {
  return process.env.OPENCODE_DB || path.join(xdgDir("data"), "opencode.db")
}

// The database is three files — .db, -wal, -shm — and a checkpoint moves bytes
// between them, so a report that only looks at the .db can claim to have
// reclaimed nothing while freeing megabytes of WAL. Always size the set.
export function dbBytes(file = dbPath()) {
  return fileSize(file) + fileSize(`${file}-wal`) + fileSize(`${file}-shm`)
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

// CAST(data AS BLOB) so LENGTH() counts bytes: on a TEXT column it would count
// characters, undercounting every multi-byte one.
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
    SELECT aggregate_id, SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM event GROUP BY aggregate_id
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

  return { file, now, totalSessions: rows.length, sessions, dbSize: dbBytes(file) }
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

// The actual VACUUM runs in a child process because:
//   1. VACUUM requires exclusive access — OpenCode's own DB connection would
//      block it if run inline.
//   2. OpenCode's bundled JS runtime may not expose node:sqlite (or may have
//      restricted module loading), while a plain Node.js or Bun does.
//   3. The child gets a clean SQLite connection with no active statements.
//
// Runtimes are tried in order and the first one present wins. Bun first:
// OpenCode itself runs on Bun, so it is the runtime an OpenCode user is most
// likely to have, and `bun:sqlite` is built in. Node.js is the fallback.
// `process.execPath` is deliberately NOT used: inside OpenCode that is the
// compiled OpenCode binary, which cannot run a script file.
//
// The last candidate is Bun's canonical install path, for when the TUI was
// launched from a GUI with a minimal PATH that has neither on it.
const RUNTIMES = [
  "bun",
  "node",
  path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
]

function helperPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "vacuum-run.mjs")
}

// Spawn once. Resolves { missing: true } when the runtime is not installed, so
// the caller can try the next one. No shell: arguments are passed as an array,
// which keeps paths with spaces working identically on Windows and POSIX.
function spawnOnce(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (err) {
      return err?.code === "ENOENT" ? resolve({ missing: true }) : reject(err)
    }
    let stdout = "", stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`VACUUM timed out after ${Math.round(timeout / 1000)}s`))
    }, timeout)
    child.stdout?.on("data", (d) => { stdout += d })
    child.stderr?.on("data", (d) => { stderr += d })
    child.on("error", (err) => {
      clearTimeout(timer)
      // ENOENT: no such runtime. EINVAL/EACCES: found but not executable here.
      if (err?.code === "ENOENT") resolve({ missing: true })
      else reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// Never uses stdio "inherit": the parent's stdout is the TUI's screen.
async function runHelper(args, { timeout = 120_000 } = {}) {
  const helper = helperPath()
  const wanted = process.env.OPENCODE_VACUUM_RUNTIME // ours, for a non-standard install
  const runtimes = wanted ? [wanted] : RUNTIMES
  for (const runtime of runtimes) {
    const res = await spawnOnce(runtime, [helper, ...args], timeout)
    if (res.missing) continue
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || "").trim()
      throw new Error(`${runtime} exited with code ${res.code}${detail ? `:\n${detail}` : ""}`)
    }
    return res
  }
  throw new Error(
    `No JavaScript runtime found to run the VACUUM helper (tried ${runtimes.join(", ")}). ` +
      "Install Bun or Node.js, or set OPENCODE_VACUUM_RUNTIME to a runtime that can run a .mjs file.",
  )
}

export async function vacuum({ file = dbPath() } = {}) {
  if (file === ":memory:") {
    throw new Error("OPENCODE_DB is set to :memory: — there is no database file to vacuum.")
  }
  const before = dbBytes(file)
  await runHelper(["--db", file])
  const after = dbBytes(file)
  return { file, before, after, freed: Math.max(0, before - after) }
}

// ---- formatting -------------------------------------------------------------

export function buildResultMessage(result, vac) {
  const lines = ["OpenCode Vacuum - done", ""]
  if (result.deleted.length || result.failed.length) {
    lines.push(
      `Deleted ${result.deleted.length} session(s)` + (result.failed.length ? `, ${result.failed.length} failed.` : "."),
    )
  } else {
    lines.push("No sessions deleted.")
  }
  lines.push(`Database: ${fmtBytes(vac.before)} -> ${fmtBytes(vac.after)}  (reclaimed ${fmtBytes(vac.freed)}, including the WAL)`)
  if (result.failed.length) {
    lines.push("", "Failed to delete:")
    for (const c of result.failed.slice(0, 5)) lines.push(`  ${c.title.slice(0, 56)}`)
  }
  return lines.join("\n")
}
