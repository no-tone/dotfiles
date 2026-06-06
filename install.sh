#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config"

link_dir() {
  local source="$1"
  local target="$2"

  mkdir -p "$CONFIG_DIR"

  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    mv "$target" "${target}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  ln -s "$source" "$target"
  echo "Linked $target -> $source"
}

link_dir "$ROOT_DIR/nvim_backup" "$CONFIG_DIR/nvim_backup"
link_dir "$ROOT_DIR/opencode" "$CONFIG_DIR/opencode"
link_dir "$ROOT_DIR/ghostty" "$CONFIG_DIR/ghostty"

echo "Done."
