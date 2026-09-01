// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone VACUUM runner — spawned as a subprocess by vacuum.mjs so the
// VACUUM gets exclusive access to the database and runs in a runtime that
// definitely has a SQLite binding (OpenCode's own bundled runtime may not
// expose one, or may restrict PRAGMA wal_checkpoint / VACUUM).
//
// Runs under either runtime, which is what lets vacuum.mjs fall back from one
// to the other:
//   bun  vacuum-run.mjs --db <path-to-opencode.db>    (bun:sqlite, preferred)
//   node vacuum-run.mjs --db <path-to-opencode.db>    (node:sqlite, Node 22+)
//
// Anything printed here is captured by the parent and shown in the dialog, so
// errors go to stderr as a single line and the exit code carries the failure.

import fs from "node:fs"

async function open(file) {
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file)
    return { exec: (sql) => db.run(sql), close: () => db.close() }
  }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import("node:sqlite"))
  } catch (err) {
    throw new Error(`no SQLite binding in this runtime (node:sqlite needs Node 22+): ${err.message}`)
  }
  const db = new DatabaseSync(file, { readOnly: false })
  return { exec: (sql) => db.exec(sql), close: () => db.close() }
}

async function main() {
  const idx = process.argv.indexOf("--db")
  if (idx === -1 || idx + 1 >= process.argv.length) {
    throw new Error("Usage: vacuum-run.mjs --db <path-to-opencode.db>")
  }
  const file = process.argv[idx + 1]
  if (!fs.existsSync(file)) throw new Error(`Database not found: ${file}`)

  const db = await open(file)
  try {
    db.exec("PRAGMA busy_timeout = 15000")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.exec("VACUUM")
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
