#Requires -Version 5.1
<#
.SYNOPSIS
    Add Windows Defender exclusions for the OpenCode / npm hot paths.

.DESCRIPTION
    Real-time antivirus scans every file read/write. OpenCode keeps a growing
    SQLite session store (~/.local/share/opencode/opencode.db) that is written
    on every streamed token, and its MCP servers unpack node_modules via npx on
    each launch. Defender re-scanning those on every write shows up as slow
    startup AND a stall on each streamed "thought". Excluding these paths (and
    the bun/opencode processes) removes that overhead.

    Idempotent: only adds exclusions that are missing. Safe to re-run.
    Requires an elevated (Administrator) PowerShell — Add-MpPreference needs it.

    Reference: OpenCode issue #7979 (slow startup on Windows), and the local
    diagnosis that opencode.db had grown to ~300 MB. Pair this with the
    /vacuum plugin (opencode/.config/opencode/plugins/vacuum-plugin.ts) which keeps the
    DB small.

.EXAMPLE
    # from an elevated PowerShell:
    .\win\defender-exclusions.ps1

.EXAMPLE
    .\win\defender-exclusions.ps1 -List      # just show current exclusions
#>
[CmdletBinding()]
param(
    [switch] $List   # print current exclusions and exit
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($List) {
    $p = Get-MpPreference
    Write-Host "== ExclusionPath ==" -ForegroundColor Cyan
    $p.ExclusionPath
    Write-Host "== ExclusionProcess ==" -ForegroundColor Cyan
    $p.ExclusionProcess
    return
}

if (-not (Test-Admin)) {
    Write-Error "This needs an elevated PowerShell. Right-click > Run as Administrator, then re-run."
    exit 1
}

# Paths hammered by OpenCode + npx-launched MCP servers.
$paths = @(
    (Join-Path $env:USERPROFILE '.local\share\opencode'),  # session DB + logs
    (Join-Path $env:USERPROFILE '.config\opencode'),       # plugins, node_modules
    (Join-Path $env:APPDATA     'npm'),                    # global npm bins
    (Join-Path $env:LOCALAPPDATA 'npm-cache')              # npx resolution cache
)
$procs = @('bun.exe', 'opencode.exe')

$existingPaths = @((Get-MpPreference).ExclusionPath)
$existingProcs = @((Get-MpPreference).ExclusionProcess)

foreach ($path in $paths) {
    if ($existingPaths -contains $path) {
        Write-Host "  skip (already excluded): $path" -ForegroundColor DarkGray
    } else {
        Add-MpPreference -ExclusionPath $path
        Write-Host "  + path: $path" -ForegroundColor Green
    }
}

foreach ($proc in $procs) {
    if ($existingProcs -contains $proc) {
        Write-Host "  skip (already excluded): $proc" -ForegroundColor DarkGray
    } else {
        Add-MpPreference -ExclusionProcess $proc
        Write-Host "  + process: $proc" -ForegroundColor Green
    }
}

Write-Host "Done. Run with -List to verify." -ForegroundColor Green
