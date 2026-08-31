# .zprofile — login shell config
# Symlinked to ~/.zprofile by stow

# Homebrew — detect the prefix instead of assuming Apple Silicon, so Intel Macs
# (/usr/local) and Linuxbrew (/home/linuxbrew) get brew on PATH too.
for _brew in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
  [ -x "$_brew" ] && eval "$("$_brew" shellenv)" && break
done
unset _brew

# AI tool env vars (non-interactive shell for AI coding tools)
export CI=true
export GIT_TERMINAL_PROMPT=0
export GIT_EDITOR=true
export GIT_PAGER=cat
export PAGER=cat
export GCM_INTERACTIVE=never
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_ENV_HINTS=1
export npm_config_yes=true
export PIP_NO_INPUT=1
export YARN_ENABLE_IMMUTABLE_INSTALLS=false

# Resolve the dotfiles repo from this file's real target, so it works wherever
# the repo was cloned. `doti` reads it as the default checkout to act on.
export DOTFILES="${${:-$HOME/.zprofile}:A:h:h}"
export DOTFILES_DIR="$DOTFILES"

# Where doti's installer puts the binary. There is no longer a scripts/
# directory to put on PATH: install.sh and Install.ps1 were replaced by one
# Go binary (apps/doti in the tone.rip monorepo), which the curl installer
# drops here.
export PATH="$HOME/.local/bin:$PATH"

# ripgrep only reads a config file named by this env var (it has no default path).
export RIPGREP_CONFIG_PATH="$HOME/.config/ripgrep/config"
