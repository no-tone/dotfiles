# dotfiles PowerShell profile — symlinked to $PROFILE by `doti install`.
# Mirrors zsh/.zprofile + zsh/.zshrc + aliases on macOS/Linux, so a Windows
# machine gets the same prompt, tools, and shortcuts.

# --- Repo resolution (works wherever cloned; falls back to ~/dotfiles) ---
$dotfiles = try {
    $target = (Get-Item -LiteralPath $PSCommandPath -Force).Target
    if ($target) { (Get-Item -LiteralPath $target).Directory.Parent.Parent.FullName }
    else { Join-Path $HOME 'dotfiles' }
} catch { Join-Path $HOME 'dotfiles' }

$dotiBin = Join-Path $env:USERPROFILE '.local\bin'

# Put doti on PATH. There is no scripts/ directory any more - install.sh
# and Install.ps1 were replaced by one Go binary.
if ((Test-Path $dotiBin) -and ($env:PATH -notlike "*$dotiBin*")) {
    $env:PATH = "$dotiBin;$env:PATH"
}

# doti reads this as the checkout to act on, the same way zsh/.zprofile does.
$env:DOTFILES_DIR = $dotfiles

# --- Environment (parity with zsh/.zprofile + .zshrc) ---
# ripgrep only reads a config file named by this env var (no default path).
$env:RIPGREP_CONFIG_PATH = Join-Path $HOME '.config\ripgrep\config'
# fzf drives traversal with fd (respects .gitignore, includes dotfiles).
if (Get-Command fd -ErrorAction SilentlyContinue) {
    $env:FZF_DEFAULT_COMMAND = 'fd --type f --hidden --strip-cwd-prefix --exclude .git'
    $env:FZF_CTRL_T_COMMAND  = $env:FZF_DEFAULT_COMMAND
    $env:FZF_ALT_C_COMMAND   = 'fd --type d --hidden --strip-cwd-prefix --exclude .git'
}
$env:FZF_DEFAULT_OPTS = '--height 40% --layout=reverse --border --info=inline'
# File preview (Ctrl-T): syntax-highlighted contents via bat.
# Directory preview (Alt-C): a quick tree via eza, falling back to Get-ChildItem.
if (Get-Command bat -ErrorAction SilentlyContinue) {
    $env:FZF_CTRL_T_OPTS = '--preview "bat --color=always --style=numbers --line-range :100 {}"'
}
if (Get-Command eza -ErrorAction SilentlyContinue) {
    $env:FZF_ALT_C_OPTS = '--preview "eza --tree --level=2 --color=always {}"'
} else {
    $env:FZF_ALT_C_OPTS = '--preview "Get-ChildItem {}"'
}

# --- Non-interactive env vars (parity with .zprofile) ---
$env:CI = 'true'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GIT_EDITOR = 'true'
$env:GIT_PAGER = 'cat'
$env:PAGER = 'cat'
$env:GCM_INTERACTIVE = 'never'
$env:npm_config_yes = 'true'
$env:PIP_NO_INPUT = '1'
$env:YARN_ENABLE_IMMUTABLE_INSTALLS = 'false'

# --- Dotfiles shortcuts (run from anywhere) ---
function dot  { Set-Location $dotfiles }
# doti is a real binary now, so it needs no wrapper. dotu stays as the
# shorthand it always was.
function dotu { doti unlink @args }   # add --restore to put backups back

# --- Tool init (parity with .zshrc) ---
if (Get-Command zoxide -ErrorAction SilentlyContinue) {
    $env:_ZO_EXCLUDE_DIRS = '/tmp:/var:/proc:/sys:/node_modules:/.git'
    $env:_ZO_MAXAGE = '365'
    Invoke-Expression (& { (zoxide init powershell | Out-String) })
}
if (Get-Command starship -ErrorAction SilentlyContinue) {
    Invoke-Expression (&starship init powershell | Out-String)
}

# --- PSReadLine: fish-style history prediction (parity with zsh-autosuggestions
#     + fast-syntax-highlighting). Ships with PowerShell 7; guarded for older. ---
if (Get-Module -ListAvailable -Name PSReadLine) {
    Import-Module PSReadLine
    Set-PSReadLineOption -EditMode Emacs
    Set-PSReadLineOption -HistoryNoDuplicates
    try { Set-PSReadLineOption -PredictionSource History } catch { }  # PSReadLine 2.1.0+
    try { Set-PSReadLineOption -PredictionViewStyle ListView } catch { }  # PSReadLine 2.2+
    Set-PSReadLineKeyHandler -Key Tab         -Function MenuComplete
    Set-PSReadLineKeyHandler -Key UpArrow     -Function HistorySearchBackward
    Set-PSReadLineKeyHandler -Key DownArrow   -Function HistorySearchForward
    Set-PSReadLineKeyHandler -Key Ctrl+z              -Function Undo
    Set-PSReadLineKeyHandler -Key Ctrl+LeftArrow      -Function BackwardWord
    Set-PSReadLineKeyHandler -Key Ctrl+RightArrow     -Function ForwardWord
    Set-PSReadLineKeyHandler -Key Ctrl+Shift+LeftArrow  -Function SelectBackwardWord
    Set-PSReadLineKeyHandler -Key Ctrl+Shift+RightArrow -Function SelectForwardWord
    # Plain Shift+Arrow (parity with the zsh-shift-select plugin's char selection)
    Set-PSReadLineKeyHandler -Key Shift+LeftArrow  -Function SelectBackwardChar
    Set-PSReadLineKeyHandler -Key Shift+RightArrow -Function SelectForwardChar
}

# --- Listing: eza if present (parity with .zshrc eza aliases) ---
# --icons=auto (not bare --icons): eza >=0.19 requires an explicit value and
# errors out on any invocation with a path argument otherwise.
if (Get-Command eza -ErrorAction SilentlyContinue) {
    try { Remove-Alias ls -Force -ErrorAction Stop } catch { }   # let eza own `ls` (PS6+)
    function ls { eza --icons=auto @args }
    function ll { eza -la --icons=auto @args }
    function la { eza -a  --icons=auto @args }
    function lt { eza -T  --icons=auto @args }
    function l1 { eza -1  --icons=auto @args }
}

# --- Tool aliases (parity with aliases.zsh) ---
if (Get-Command bat     -ErrorAction SilentlyContinue) { Set-Alias c  bat }
if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Set-Alias oc opencode
}

# --- git shortcuts (parity with aliases.zsh) ---
# NOTE: gc / gp / gl are intentionally NOT defined — they're core PowerShell
# aliases (Get-Content / Get-ItemProperty / Get-Location). Use git's own
# aliases instead: `git c`, `git p`, `git l` (defined in git/.gitconfig).
function gs { git status @args }
function gd { git diff @args }
function ga { git add @args }

# --- Navigation ---
function .. { Set-Location .. }
function ... { Set-Location ..\.. }

# --- Misc (parity with aliases.zsh) ---
function reload { . $PROFILE }

# Clear the startup banner (Windows PowerShell 5.1 welcome text).
Clear-Host
