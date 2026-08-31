# Agent instructions for dotfiles work

This repository is **data**: stow packages and a manifest. The installer that
used to live here — `scripts/install.sh`, `scripts/Install.ps1`,
`scripts/Main.ps1` and two bootstraps, 2,815 lines implementing the same
operations twice in two languages — is one Go binary, `doti`, in
[riptone/tone.rip](https://github.com/riptone/tone.rip) under `apps/doti`.

**So: installer behaviour is not changed here.** Adding a command, changing
how linking works, fixing the health check — all of that is a change to
`apps/doti` in that repo. What changes here is what gets installed and linked.

## Rules

- **`manifest.jsonc` is the single source of truth.** Adding a tool or a
  config is a one-line edit there. `Brewfile` and `packages.json` are
  generated from it into a temp directory at install time and are never
  committed, so they cannot drift.
- Keep `manifest.schema.json` in step with the manifest. It is the editor's
  autocomplete and CI validates against it.
- The manifest is JWCC (JSON with comments and trailing commas). It contains
  a URL, so **never strip comments with a regex** — `//` inside a string is
  not a comment. `doti` parses it with a real JWCC parser.
- Configs live in stow packages whose tree mirrors `$HOME`
  (`zsh/.zshrc`, `ghostty/.config/ghostty/config`).
- Ignore rules live in `stow/.stow-global-ignore` (→ `~/.stow-global-ignore`)
  *and* in the manifest's `stow_ignore`. The manifest list is the one `doti`
  reads; the dotfile is for a bare `stow` run by hand. A global ignore list
  *replaces* Stow's built-in defaults rather than merging, which is why that
  file re-lists them.
- The `stow` package is linked first, so `~/.stow-global-ignore` is in place
  before anything else. Order in `stow_packages` is load-bearing.
- Prefer a tool's own config file over a shell alias or env var when the tool
  is also used outside the interactive shell. ripgrep defaults live in
  `ripgrep/.config/ripgrep/config` via `RIPGREP_CONFIG_PATH` (set in
  `.zprofile` and `profile.ps1`), **not** an `rg` alias.
- Machine-local git settings (credential helper, per-machine identity) go in
  `~/.gitconfig.local`, written by `doti` and included from `.gitconfig`. It
  is never committed, and an existing one is never overwritten.
- Terminal: Ghostty on macOS/Linux (stowed), Windows Terminal on Windows
  (`win/terminal/settings.json`, linked directly since it lives outside
  `$HOME`).
- VS Code settings are **not** managed here — Microsoft Settings Sync owns
  them. Do not add a vscode config package.
- Pin third-party plugin versions (e.g. `oh-my-opencode-slim@2.2.8`) and MCP
  npx commands. Only built-in opencode plugins stay unpinned. An unpinned
  version is a registry round trip on every startup.
- A tool installed outside a package manager puts its PATH/env in the tracked
  `zsh/.zprofile`, **not** in the line its own installer appends to
  `~/.zshrc` — that file is a symlink into this repo and the next re-link
  would clobber it.
- `.gitattributes` forces LF on `*.sh` so a CRLF checkout cannot break a
  shell config. Keep shell files LF and PowerShell CRLF.
- `CLAUDE.md` is a symlink to this file. CI diffs them.

## Secrets — the hard rule

**No credentials in this repository, ever.** Every config here is symlinked
into `$HOME` on every machine, so a secret committed here is a secret on all
of them — and `git add -A` in a directory full of config files is how it
happens. CI runs gitleaks over full history.

Secrets are declared in the manifest's `secrets` array and rendered from
**Bitwarden** by `doti secrets` at install time. Two modes:

- `file` — the whole file is one vault field (a secure note), written
  verbatim. For files that are sensitive end to end.
- `template` — a checked-in `.tmpl` with named holes filled from the vault.
  For mostly-public config with a few secret fields.

They are deliberately **not** stow packages. Stow symlinks `$HOME` into this
repo, so a stowed secret lives in the working tree. Rendered secrets are
written straight to their target at `0600` and never exist inside the repo.
`.gitignore` lists the rendered filenames as a backstop.

## Conventions

- Never run a destructive operation against `$HOME` without confirmation.
  `doti` backs up anything it displaces to `~/.dotfiles-backups/<timestamp>/`
  and never deletes.
- Anything that writes has a dry run (`-n`). Use it when changing the
  manifest.
- `doti check` is the read-only view and is safe from a login shell.
