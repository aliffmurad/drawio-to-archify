# Take PNG screenshots of Archify HTML views with headless Microsoft Edge (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\screenshot.ps1
# Run from a normal (non-elevated) PowerShell window.
param(
  [string]$Example = 'online-store',
  [int]$Width = 1440,
  [int]$Height = 1000
)

$repo = Split-Path -Parent $PSScriptRoot
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found.' }

$images = Join-Path $repo 'docs\images'
New-Item -ItemType Directory -Force $images | Out-Null
$profileDir = Join-Path $env:TEMP 'drawio-to-archify-edge'

foreach ($view in 'executive', 'technical') {
  $html = Join-Path $repo "examples\$Example\$view\$Example-$view.html"
  $out = Join-Path $images "$Example-$view.png"
  if (-not (Test-Path $html)) { Write-Warning "Missing $html"; continue }
  $url = 'file:///' + ($html -replace '\\', '/')
  & $edge --headless=new --disable-gpu --hide-scrollbars --no-first-run `
    "--user-data-dir=$profileDir" "--window-size=$Width,$Height" `
    --virtual-time-budget=6000 "--screenshot=$out" $url | Out-Null
  if (Test-Path $out) { Write-Host "OK  $out" } else { Write-Warning "No screenshot for $view" }
}
