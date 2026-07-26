$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$installerScript = Join-Path $projectRoot "build\installer.nsh"

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

Write-Host "NSIS Apple UI 文件检查通过。" -ForegroundColor Green
Remove-Item -Recurse -Force (Join-Path $projectRoot "out") -ErrorAction SilentlyContinue

Push-Location $projectRoot
try {
  pnpm electron:make
  if ($LASTEXITCODE -ne 0) {
    throw "electron:make 执行失败，退出码：$LASTEXITCODE"
  }
}
finally {
  Pop-Location
}
