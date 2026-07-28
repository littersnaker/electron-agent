$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$installerScript = Join-Path $projectRoot "build\installer.nsh"
$releaseDirectory = Join-Path $projectRoot "release"

if (-not (Test-Path $installerScript)) {
  throw "缺少文件：$installerScript"
}

$content = Get-Content $installerScript -Raw -Encoding UTF8
$forbiddenPatterns = @(
  '\$mui\.',
  'MUI_HEADER_TEXT',
  '!define\s+MUI_HEADERIMAGE',
  '!define\s+MUI_HEADERIMAGE_RIGHT',
  '!define\s+MUI_ABORTWARNING',
  '!define\s+MUI_UNABORTWARNING',
  '!insertmacro\s+MUI_PAGE_DIRECTORY',
  '!insertmacro\s+MUI_PAGE_INSTFILES',
  '!insertmacro\s+MUI_PAGE_FINISH'
)

foreach ($pattern in $forbiddenPatterns) {
  if ($content -match $pattern) {
    throw "installer.nsh 包含不兼容内容：$pattern"
  }
}

$requiredFiles = @(
  "build\installer.nsh",
  "build\installerHeader.bmp",
  "build\installerSidebar.bmp",
  "build\uninstallerSidebar.bmp",
  "electron-builder.yml"
)

foreach ($file in $requiredFiles) {
  if (-not (Test-Path (Join-Path $projectRoot $file))) {
    throw "缺少打包文件：$file"
  }
}

Write-Host "Multi-agent Windows 安装器资源检查通过。" -ForegroundColor Green

Push-Location $projectRoot
try {
  pnpm electron:make:win
  if ($LASTEXITCODE -ne 0) {
    throw "electron:make:win 执行失败，退出码：$LASTEXITCODE"
  }

  $installer = Get-ChildItem `
    -Path $releaseDirectory `
    -Filter "Multi-agent-*-windows-x64-setup.exe" `
    -File `
    | Select-Object -First 1

  if ($null -eq $installer) {
    throw "构建完成但未找到符合命名规范的 Windows 安装包。"
  }

  Write-Host "安装包已生成：$($installer.FullName)" -ForegroundColor Green
}
finally {
  Pop-Location
}
