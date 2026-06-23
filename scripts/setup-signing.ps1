<#
.SYNOPSIS
  Downloads signtool.exe and Azure.CodeSigning.Dlib.dll from NuGet.
  No Visual Studio required.

.USAGE
  From the project root:
    powershell -ExecutionPolicy Bypass -File scripts\setup-signing.ps1
#>

$ErrorActionPreference = 'Stop'
$SigningDir = Join-Path $PSScriptRoot '..\signing'
New-Item -ItemType Directory -Force -Path $SigningDir | Out-Null
$SigningDir = Resolve-Path $SigningDir

Write-Host "[1/4] Fetching latest package versions from NuGet..."

$sdkVersion = (Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/index.json').versions | Select-Object -Last 1
$tsVersion  = (Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.trusted.signing.client/index.json').versions | Select-Object -Last 1

Write-Host "  SDK Build Tools : $sdkVersion"
Write-Host "  Trusted Signing : $tsVersion"

# ── signtool.exe from Microsoft.Windows.SDK.BuildTools ──────────────────────
Write-Host "[2/4] Downloading Windows SDK Build Tools..."
$sdkZip = Join-Path $env:TEMP 'sdk-build-tools.zip'
Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools/$sdkVersion" `
  -OutFile $sdkZip -UseBasicParsing

$sdkExtract = Join-Path $env:TEMP 'sdk-build-tools'
if (Test-Path $sdkExtract) { Remove-Item $sdkExtract -Recurse -Force }
Expand-Archive -Path $sdkZip -DestinationPath $sdkExtract -Force

# Locate signtool.exe (x64 preferred)
$signtool = Get-ChildItem -Path $sdkExtract -Filter 'signtool.exe' -Recurse |
  Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if (-not $signtool) {
  $signtool = Get-ChildItem -Path $sdkExtract -Filter 'signtool.exe' -Recurse | Select-Object -First 1
}
if (-not $signtool) { throw 'signtool.exe not found in SDK package.' }
Copy-Item $signtool.FullName (Join-Path $SigningDir 'signtool.exe') -Force
Write-Host "  signtool.exe -> signing\signtool.exe"

# ── Azure.CodeSigning.Dlib.dll from Microsoft.Trusted.Signing.Client ────────
Write-Host "[3/4] Downloading Microsoft.Trusted.Signing.Client..."
$tsZip = Join-Path $env:TEMP 'trusted-signing.zip'
Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Trusted.Signing.Client/$tsVersion" `
  -OutFile $tsZip -UseBasicParsing

$tsExtract = Join-Path $env:TEMP 'trusted-signing'
if (Test-Path $tsExtract) { Remove-Item $tsExtract -Recurse -Force }
Expand-Archive -Path $tsZip -DestinationPath $tsExtract -Force

# Copy the entire bin/x64 folder (includes Azure SDK dependency DLLs)
$binX64 = Join-Path $tsExtract 'bin\x64'
if (-not (Test-Path $binX64)) {
  $binX64 = Get-ChildItem -Path $tsExtract -Filter 'Azure.CodeSigning.Dlib.dll' -Recurse |
    Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
}
if (-not $binX64) { throw 'Azure.CodeSigning.Dlib.dll not found in Trusted Signing package.' }
Get-ChildItem -Path $binX64 -Filter '*.dll' | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $SigningDir $_.Name) -Force
}
Write-Host "  Azure.CodeSigning.Dlib.dll + dependencies -> signing\"

# ── Clean up temp files ──────────────────────────────────────────────────────
Write-Host "[4/4] Cleaning up..."
Remove-Item $sdkZip, $tsZip -Force -ErrorAction SilentlyContinue
Remove-Item $sdkExtract, $tsExtract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Files in signing\:"
Get-ChildItem $SigningDir | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host ""
Write-Host "Next: fill in signing\metadata.json with your Azure Trusted Signing details,"
Write-Host "      then add AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET to .env"
