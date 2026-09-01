// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the OpenCode plugins in this directory (/vacuum, /versions).
//
// Everything here is about agreeing on two things across both engines: where
// OpenCode keeps its files, and how bytes and ages are printed.
//
// ---- where OpenCode keeps things -------------------------------------------
//
// OpenCode resolves its directories with xdg-basedir and has NO win32 special
// case, so all four are under the home directory on macOS, Linux *and* Windows
// (C:\Users\you\.cache\opencode, not %LOCALAPPDATA%), unless the matching
// XDG_* variable is set:
//
//   config  ~/.config/opencode        opencode.jsonc, tui.jsonc, this directory
//   data    ~/.local/share/opencode   opencode.db, auth.json, snapshots
//   cache   ~/.cache/opencode         packages/ (one node_modules per plugin)
//   state   ~/.local/state/opencode
//
// Environment overrides are called out at each use site as either OpenCode's
// own variable or one of ours (a plugin-local escape hatch, used by tests).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const XDG_DEFAULTS = {
  config: [".config"],
  data: [".local", "share"],
  cache: [".cache"],
  state: [".local", "state"],
}

// The OpenCode directory of the given kind: "config" | "data" | "cache" | "state".
export function xdgDir(kind) {
  const fallback = XDG_DEFAULTS[kind]
  if (!fallback) throw new Error(`unknown directory kind: ${kind}`)
  const base = process.env[`XDG_${kind.toUpperCase()}_HOME`] || path.join(os.homedir(), ...fallback)
  return path.join(base, "opencode")
}

// ---- formatting -------------------------------------------------------------

export function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB"
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return `${Math.round(n)} B`
}

const DAY = 86_400_000

export function fmtAge(ms) {
  const d = Math.floor(ms / DAY)
  if (d >= 365) return `${Math.floor(d / 365)}y`
  if (d >= 1) return `${d}d`
  const h = Math.floor(ms / 3_600_000)
  return `${h}h`
}

// ---- filesystem -------------------------------------------------------------

// Size of one file, 0 if it is missing or unreadable.
export function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

// Recursive size of a directory. Never follows symlinks (readdir's file types
// and lstat both describe the link, not its target) and ignores what it cannot
// read, so a permission error or a file vanishing mid-walk costs accuracy
// rather than throwing.
export function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    let entries
    const cur = stack.pop()
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      try {
        total += fs.lstatSync(p).size // lstat: a symlink counts as the link, not its target
      } catch {
        // vanished mid-walk
      }
    }
  }
  return total
}
