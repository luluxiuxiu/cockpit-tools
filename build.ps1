#Requires -Version 5.1
<#
.SYNOPSIS
  Cockpit Tools one-click build script (Windows)

.DESCRIPTION
  Check Node/Rust/Go, install npm deps, run Tauri production build.
  Default: npm install (if needed) + npm run tauri build

.PARAMETER Mode
  build     - production bundle (default)
  dev       - dev mode (npm run tauri:dev)
  frontend  - frontend only (npm run build)
  check     - env check + cargo check

.PARAMETER SkipInstall
  Skip npm install

.PARAMETER ForceInstall
  Force npm install

.PARAMETER Clean
  Clean target/dist before build

.PARAMETER OpenOutput
  Open bundle folder after success

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Mode build -OpenOutput
  .\build.ps1 -Mode dev
  .\build.ps1 -Clean -ForceInstall
#>

[CmdletBinding()]
param(
  [ValidateSet('build', 'dev', 'frontend', 'check')]
  [string]$Mode = 'build',

  [switch]$SkipInstall,
  [switch]$ForceInstall,
  [switch]$Clean,
  [switch]$OpenOutput,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $Root

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host ("==> {0}" -f $Message) -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host ("  [OK] {0}" -f $Message) -ForegroundColor Green
}

function Write-WarnLine {
  param([string]$Message)
  Write-Host ("  [!] {0}" -f $Message) -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Message)
  Write-Host ("  [X] {0}" -f $Message) -ForegroundColor Red
}

function Show-Help {
  $text = @"
Cockpit Tools one-click build (Windows)

Usage:
  .\build.ps1 [-Mode build|dev|frontend|check] [options]

Modes:
  build      Production package (default)  -> npm run tauri build
  dev        Dev hot reload                -> npm run tauri:dev
  frontend   Frontend only                 -> npm run build
  check      Env check + cargo check

Options:
  -SkipInstall     Skip npm install
  -ForceInstall    Force npm install
  -Clean           Clean target/dist then build
  -OpenOutput      Open output folder on success
  -Help            Show this help

Examples:
  .\build.ps1
  .\build.ps1 -OpenOutput
  .\build.ps1 -Mode dev
  .\build.ps1 -Clean -ForceInstall
"@
  Write-Host $text
}

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-CommandVersion {
  param(
    [string]$Name,
    [string[]]$VersionArgs = @('--version')
  )
  try {
    $output = & $Name @VersionArgs 2>&1 | Out-String
    return ($output -replace '\r?\n', ' ').Trim()
  } catch {
    return $null
  }
}

function Assert-Prerequisites {
  Write-Step "Checking build environment"

  $missing = @()

  if (Test-CommandExists 'node') {
    Write-Ok ("Node.js: {0}" -f (Get-CommandVersion 'node'))
  } else {
    Write-Fail "Node.js not found (need v18+)"
    $missing += 'Node.js'
  }

  if (Test-CommandExists 'npm') {
    Write-Ok ("npm: {0}" -f (Get-CommandVersion 'npm'))
  } else {
    Write-Fail "npm not found (need v9+)"
    $missing += 'npm'
  }

  if (Test-CommandExists 'rustc') {
    Write-Ok ("Rustc: {0}" -f (Get-CommandVersion 'rustc'))
  } else {
    Write-Fail "rustc not found (install Rust stable)"
    $missing += 'Rust'
  }

  if (Test-CommandExists 'cargo') {
    Write-Ok ("Cargo: {0}" -f (Get-CommandVersion 'cargo'))
  } else {
    Write-Fail "cargo not found"
    $missing += 'Cargo'
  }

  if (Test-CommandExists 'go') {
    Write-Ok ("Go: {0}" -f (Get-CommandVersion 'go' @('version')))
  } else {
    Write-WarnLine "Go not found. Sidecar cockpit-cliproxy build may fail. Install Go and add to PATH."
  }

  $vcvarsCandidates = @(
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat'
  )
  $vcvars = $vcvarsCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($vcvars) {
    Write-Ok ("MSVC toolchain: {0}" -f $vcvars)
  } else {
    Write-WarnLine "vcvars64.bat not found. Windows Tauri build usually needs VS 2022 C++ Build Tools."
    Write-WarnLine "scripts/tauri.cjs will fall back to the current shell environment."
  }

  if ($missing.Count -gt 0) {
    throw ("Missing required tools: {0}" -f ($missing -join ', '))
  }
}

function Invoke-Npm {
  param([Parameter(Mandatory = $true)][string[]]$NpmArgs)
  Write-Host ("  > npm {0}" -f ($NpmArgs -join ' ')) -ForegroundColor DarkGray
  & npm.cmd @NpmArgs
  if ($LASTEXITCODE -ne 0) {
    throw ("npm failed (exit={0}): npm {1}" -f $LASTEXITCODE, ($NpmArgs -join ' '))
  }
}

function Ensure-NpmDeps {
  $nodeModules = Join-Path $Root 'node_modules'
  $needInstall = $ForceInstall -or (-not (Test-Path -LiteralPath $nodeModules))

  if ($SkipInstall) {
    Write-Step "Skip npm install (-SkipInstall)"
    if (-not (Test-Path -LiteralPath $nodeModules)) {
      throw "node_modules missing. Remove -SkipInstall or run npm install first."
    }
    return
  }

  if (-not $needInstall) {
    Write-Step "Dependencies present, skip npm install (use -ForceInstall to reinstall)"
    Write-Ok "node_modules ready"
    return
  }

  Write-Step "Installing npm dependencies"
  Invoke-Npm @('install')
  Write-Ok "npm install done"
}

function Invoke-CleanBuild {
  Write-Step "Cleaning build caches"
  $paths = @(
    (Join-Path $Root 'dist'),
    (Join-Path $Root 'src-tauri\target'),
    (Join-Path $Root 'target')
  )
  foreach ($p in $paths) {
    if (Test-Path -LiteralPath $p) {
      Write-Host ("  remove: {0}" -f $p) -ForegroundColor DarkGray
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
    }
  }
  Write-Ok "clean done"
}

function Get-BundleOutputDir {
  $candidates = @(
    (Join-Path $Root 'src-tauri\target\release\bundle'),
    (Join-Path $Root 'target\release\bundle')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $candidates[0]
}

function Show-BuildArtifacts {
  $bundleDir = Get-BundleOutputDir
  Write-Step "Build artifacts"
  if (-not (Test-Path -LiteralPath $bundleDir)) {
    Write-WarnLine ("bundle dir not found: {0}" -f $bundleDir)
    return
  }

  Write-Ok ("output dir: {0}" -f $bundleDir)
  $files = Get-ChildItem -LiteralPath $bundleDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '\.(msi|exe|nsis|zip|sig)$' } |
    Sort-Object LastWriteTime -Descending

  if (-not $files -or $files.Count -eq 0) {
    Write-WarnLine "No msi/exe/nsis/zip found. Inspect bundle dir manually."
    Get-ChildItem -LiteralPath $bundleDir -Recurse -File -ErrorAction SilentlyContinue |
      Select-Object -First 20 |
      ForEach-Object { Write-Host ("  - {0}" -f $_.FullName) -ForegroundColor DarkGray }
  } else {
    foreach ($f in $files | Select-Object -First 30) {
      $sizeMb = [math]::Round($f.Length / 1MB, 2)
      Write-Host ("  - {0}  ({1} MB)" -f $f.FullName, $sizeMb) -ForegroundColor Gray
    }
  }

  if ($OpenOutput) {
    Start-Process explorer.exe -ArgumentList $bundleDir
  }
}

function Invoke-Build {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  Write-Host ""
  Write-Host "========================================" -ForegroundColor Magenta
  Write-Host "  Cockpit Tools one-click build" -ForegroundColor Magenta
  Write-Host ("  Mode: {0}" -f $Mode) -ForegroundColor Magenta
  Write-Host ("  Root: {0}" -f $Root) -ForegroundColor Magenta
  Write-Host "========================================" -ForegroundColor Magenta

  Assert-Prerequisites

  if ($Clean -and $Mode -ne 'dev') {
    Invoke-CleanBuild
  }

  Ensure-NpmDeps

  switch ($Mode) {
    'check' {
      Write-Step "TypeScript typecheck"
      Invoke-Npm @('run', 'typecheck')
      Write-Ok "typecheck passed"

      Write-Step "Cargo check (src-tauri)"
      Push-Location (Join-Path $Root 'src-tauri')
      try {
        & cargo check
        if ($LASTEXITCODE -ne 0) {
          throw ("cargo check failed (exit={0})" -f $LASTEXITCODE)
        }
      } finally {
        Pop-Location
      }
      Write-Ok "cargo check passed"
    }
    'frontend' {
      Write-Step "Frontend production build"
      Invoke-Npm @('run', 'build')
      Write-Ok "frontend build done (dist/)"
    }
    'dev' {
      Write-Step "Start dev mode (Ctrl+C to stop)"
      Invoke-Npm @('run', 'tauri:dev')
    }
    'build' {
      Write-Step "Sync version and run Tauri production build"
      Write-Host "  This may take several minutes..." -ForegroundColor DarkGray
      Invoke-Npm @('run', 'tauri', '--', 'build')
      Write-Ok "Tauri build finished"
      Show-BuildArtifacts
    }
  }

  $sw.Stop()
  Write-Host ""
  Write-Host ("All done. Elapsed {0:mm\:ss}" -f $sw.Elapsed) -ForegroundColor Green
}

if ($Help) {
  Show-Help
  exit 0
}

try {
  Invoke-Build
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  if ($_.ScriptStackTrace) {
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
  }
  Write-Host ""
  Write-Host "Build failed. Checklist:" -ForegroundColor Yellow
  Write-Host "  1. Install Node 18+, Rust stable, VS 2022 C++ Build Tools" -ForegroundColor Yellow
  Write-Host "  2. Install Go for sidecar cockpit-cliproxy" -ForegroundColor Yellow
  Write-Host "  3. Manual: npm install && npm run tauri build" -ForegroundColor Yellow
  Write-Host "  4. Read the full error log above" -ForegroundColor Yellow
  exit 1
}