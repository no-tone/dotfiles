# dotfiles

A home for personal configuration files.

## Included setup

- `nvim_backup/lua/custom/cmdline.lua` (from the provided gist)
- `opencode/`
- `ghostty/`

## Install everything in one sweep

Run from the repository root:

```bash
./install.sh
```

The installer symlinks these folders into `~/.config`:

- `~/.config/nvim_backup`
- `~/.config/opencode`
- `~/.config/ghostty`

If a target already exists, it is backed up as `*.bak.<timestamp>`.
