// Standalone VACUUM runner — spawned as a subprocess by vacuum.mjs so the
// VACUUM gets exclusive access to the database and runs in an unrestricted
// Node.js runtime (openCode's own JavaScript environment may not have
// node:sqlite or the right permissions for PRAGMA wal_checkpoint / VACUUM).
//
// Usage: node vacuum-run.mjs --db <path-to-opencode.db>

import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"

function main() {
  const idx = process.argv.indexOf("--db")
  if (idx === -1 || idx + 1 >= process.argv.length) {
    console.error("Usage: node vacuum-run.mjs --db <path-to-opencode.db>")
    process.exit(1)
  }
  const file = process.argv[idx + 1]
  if (!fs.existsSync(file)) {
    console.error(`Database not found: ${file}`)
    process.exit(1)
  }

  const db = new DatabaseSync(file, { readOnly: false })
  try {
    db.exec("PRAGMA busy_timeout = 15000")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.exec("VACUUM")
  } finally {
    db.close()
  }
}

main()
