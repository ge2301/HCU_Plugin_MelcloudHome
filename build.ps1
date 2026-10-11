# Builds the MELCloud Home HCU plugin and exports it as an installable .tar.gz
# Requires Docker with buildx (for the linux/arm64 target).
#
# Usage:
#   ./build.ps1                 # builds version 0.1.0
#   ./build.ps1 -Version 0.2.0  # builds a specific version

param(
	[string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"

$PluginId = "de.community.homematic.plugin.melcloud"
$Image = "melcloud-hcu-plugin:$Version"
$Output = Join-Path $PSScriptRoot "$PluginId-$Version.tar.gz"

Write-Host "Building $Image for linux/arm64 ..." -ForegroundColor Cyan
docker build --platform=linux/arm64 --build-arg VERSION=$Version -t $Image .

Write-Host "Exporting to $Output ..." -ForegroundColor Cyan
# Gzip the docker-save tar in place (single gzipped tar, NOT a tar of a tar).
# No 'gzip' CLI on Windows; PowerShell pipes also mangle binary data -> use .NET.
$Tar = Join-Path $PSScriptRoot "$PluginId-$Version.tar"
docker save $Image -o $Tar
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }
$in   = [IO.File]::OpenRead($Tar)
$out  = [IO.File]::Open($Output, [IO.FileMode]::Create)
$gz   = New-Object IO.Compression.GzipStream($out, [IO.Compression.CompressionLevel]::Optimal)
$in.CopyTo($gz)
$gz.Dispose(); $out.Dispose(); $in.Dispose()
Remove-Item $Tar

Write-Host "Done. Upload '$Output' in the HCU web interface (developer mode)." -ForegroundColor Green
