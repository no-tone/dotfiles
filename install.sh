#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config"

link_dir() {
  local source="$1"
  local target="$2"
  local current_link=""

  mkdir -p "$CONFIG_DIR"

  if [ -L "$target" ]; then
    current_link="$(readlink "$target")"
    if [ "$current_link" = "$source" ]; then
      echo "Already linked: $target -> $source"
      return
    fi
    echo "Replacing existing symlink: $target"
    rm "$target"
  elif [ -e "$target" ]; then
    local timestamp
    local backup_path
    local suffix=0

    timestamp="$(date +%Y%m%d%H%M%S)"
    backup_path="${target}.bak.${timestamp}"
    while [ -e "$backup_path" ] || [ -L "$backup_path" ]; do
      suffix=$((suffix + 1))
      backup_path="${target}.bak.${timestamp}.${suffix}"
    done

    echo "Backing up existing path: $target -> $backup_path"
    mv "$target" "$backup_path"
  fi

  ln -s "$source" "$target"
  echo "Linked $target -> $source"
}

link_dir "$ROOT_DIR/nvim" "$CONFIG_DIR/nvim"
link_dir "$ROOT_DIR/opencode" "$CONFIG_DIR/opencode"
link_dir "$ROOT_DIR/ghostty" "$CONFIG_DIR/ghostty"

echo "Done."
