<#
.SYNOPSIS
    Obtain every dependency this project needs to build and run, from nothing.

.DESCRIPTION
    Written for a genuinely fresh Windows install: no Node, no package manager,
    no build tools. Every dependency is checked for first and installed only
    when missing, from its ecosystem's canonical upstream, into a user-scoped
    location. Nothing here requires administrator rights, and nothing mutates an
    unrelated global toolchain in place.

    Two behaviours are deliberate and easy to get wrong:

    1. PATH is refreshed inside this process after an install. A package manager
       writes PATH for FUTURE shells, so the very next command in this same
       script still cannot find what was just installed — a failure that reads as
       "the install failed" when in fact it succeeded.

    2. Success is judged by whether the artifact EXISTS afterwards, never by
       whether an installer reported success. Electron's own install script in
       particular can print a cache hit, exit 0 in under a second, extract
       nothing, and print no error at all.

.PARAMETER Silent
    No prompts, no interactive pause. Exits non-zero on the first real failure
    so a caller can branch on it. This is the mode CI and automation use.
#>

[CmdletBinding()]
param(
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$script:PhaseStart = $null

function Write-Phase {
    param([string]$Message)
    $script:PhaseStart = Get-Date
    Write-Host "[bootstrap] $Message" -ForegroundColor Cyan
}

function Write-PhaseDone {
    param([string]$Message)
    $elapsed = if ($script:PhaseStart) { (Get-Date) - $script:PhaseStart } else { [TimeSpan]::Zero }
    Write-Host ("[bootstrap] {0} ({1:N1}s)" -f $Message, $elapsed.TotalSeconds) -ForegroundColor Green
}

function Write-Failure {
    param([string]$Message)
    Write-Host "[bootstrap] FAILED: $Message" -ForegroundColor Red
}

# A package manager updates PATH for future shells only. Without this, a command
# installed a moment ago is still not found in this process.
function Update-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Test-CommandAvailable {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
    param(
        [string]$PackageId,
        [string]$FriendlyName
    )

    if (-not (Test-CommandAvailable 'winget')) {
        throw "$FriendlyName is missing and winget is not available to install it. Install $FriendlyName manually, or install App Installer from the Microsoft Store so winget is present."
    }

    Write-Phase "installing $FriendlyName via winget ($PackageId)"
    # --scope user keeps this out of Program Files so no elevation is needed.
    & winget install --id $PackageId --scope user --silent --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Host
    Update-ProcessPath
}

try {
    # ---------------------------------------------------------------- Node.js
    Write-Phase 'checking for Node.js'
    Update-ProcessPath
    if (Test-CommandAvailable 'node') {
        $nodeVersion = (& node --version).Trim()
        Write-PhaseDone "found Node.js $nodeVersion"
    }
    else {
        Install-WithWinget -PackageId 'OpenJS.NodeJS.LTS' -FriendlyName 'Node.js'
        if (-not (Test-CommandAvailable 'node')) {
            throw 'Node.js was installed but is still not on PATH in this process. Open a new terminal and run this script again.'
        }
        Write-PhaseDone ("installed Node.js " + (& node --version).Trim())
    }

    # -------------------------------------------------------------------- Git
    # Needed at run time for document history, and at build time for provenance.
    Write-Phase 'checking for Git'
    if (Test-CommandAvailable 'git') {
        Write-PhaseDone ((& git --version).Trim())
    }
    else {
        Install-WithWinget -PackageId 'Git.Git' -FriendlyName 'Git'
        if (-not (Test-CommandAvailable 'git')) {
            throw 'Git was installed but is still not on PATH in this process. Open a new terminal and run this script again.'
        }
        Write-PhaseDone ((& git --version).Trim())
    }

    # --------------------------------------------------------- Node packages
    Write-Phase 'installing project dependencies'
    Push-Location $RepoRoot
    try {
        & npm install --no-audit --no-fund | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm install exited $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
    Write-PhaseDone 'project dependencies installed'

    # ------------------------------------------------------- Electron binary
    # Checked by EXISTENCE, not by an installer's exit code. npm's install-script
    # gate plus a Node runtime that exits before async work settles can leave the
    # electron package present with an empty dist directory and nothing logged.
    Write-Phase 'verifying the Electron binary'
    Push-Location $RepoRoot
    try {
        & node 'scripts/ensure-electron-binary.mjs' | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "the Electron binary could not be produced (exit $LASTEXITCODE)" }
    }
    finally {
        Pop-Location
    }
    Write-PhaseDone 'Electron binary present'

    Write-Host '[bootstrap] all dependencies ready' -ForegroundColor Green
    exit 0
}
catch {
    Write-Failure $_.Exception.Message
    exit 1
}
