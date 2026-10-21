# One-command setup for Windows. On a new machine, paste this into PowerShell:
#
#   $d="$HOME\.agent-bridge\app"; if (!(Test-Path $d)) { git clone https://github.com/tony-xmelon/agent-bridge.git $d }; powershell -ExecutionPolicy Bypass -File "$d\setup.ps1"
#
# Re-running it later updates and re-checks everything.

$ErrorActionPreference = 'Stop'
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Have node)) {
    if (-not (Have winget)) { throw 'agent-bridge needs Node.js 18+. Install it from https://nodejs.org and run this again.' }
    Write-Host 'Installing Node.js LTS with winget...'
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Have node)) { throw 'Node.js was installed but is not on PATH in this window yet. Open a new PowerShell window and run this again.' }
}

node "$PSScriptRoot\bin\agent-bridge.js" setup @args
exit $LASTEXITCODE
