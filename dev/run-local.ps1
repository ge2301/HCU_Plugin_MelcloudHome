# Runs the MELCloud Home plugin LOCALLY (no Docker) against the real HCU.
# The plugin connects to wss://<HcuHost>:9001 and the configuration form is
# rendered by the real HCUweb from our CONFIG_TEMPLATE — i.e. the actual UI.
#
# Prerequisites (once):
#   1. HCUweb > Entwicklermodus: "Connect API WebSocket" aktivieren
#   2. HCUweb > Entwicklermodus: Aktivierungscode erzeugen
#   3. node dev\hcu-token.js <HcuHost> <Aktivierungscode>   (creates dev\authtoken.txt)
#
# Usage:
#   .\dev\run-local.ps1 -HcuHost hcu1-1234.local
#   .\dev\run-local.ps1 -HcuHost hcu1-1234.local -LogLevel debug

param(
	[Parameter(Mandatory = $true)]
	[string]$HcuHost,
	[string]$PluginId = "de.community.homematic.plugin.melcloud",
	[string]$LogLevel = "info"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # project root (parent of dev/)

# HCU uses a self-signed certificate.
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
$env:LOG_LEVEL = $LogLevel
# Keep local data out of the (Linux) /data container path.
$env:MELCLOUD_CONFIG_PATH = Join-Path $PSScriptRoot "data\config.json"
$env:MELCLOUD_TOKENS_PATH = Join-Path $PSScriptRoot "data\tokens.json"

$tokenFile = Join-Path $PSScriptRoot "authtoken.txt"
if (-not (Test-Path $tokenFile)) {
	Write-Error "dev\authtoken.txt fehlt. Erst ausfuehren: node dev\hcu-token.js $HcuHost <Aktivierungscode>"
}

Write-Host "Starting plugin against $HcuHost (plugin $PluginId). Strg+C zum Beenden." -ForegroundColor Cyan
Push-Location $root
try {
	node "plugin\src\index.js" $PluginId $HcuHost $tokenFile
}
finally {
	Pop-Location
}
