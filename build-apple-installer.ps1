$ErrorActionPreference = "Stop"
Write-Warning "build-apple-installer.ps1 已弃用，请改用 build-windows-installer.ps1。"
& (Join-Path $PSScriptRoot "build-windows-installer.ps1") @args
exit $LASTEXITCODE
