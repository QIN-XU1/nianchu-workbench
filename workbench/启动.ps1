# ══════════════════════════════════════════════════════════════
#  DSH 工作台 —— 独立启动器（PowerShell 版）
#
#  为什么有 .ps1 和 .vbs 两个：
#    .vbs  双击无黑窗口，日常用
#    .ps1  有控制台输出，排查问题用
#
#  实测：PowerShell 5.1 读无 BOM 的 UTF-8 会把中文当 ANSI，
#        导致引号配对错误。此文件必须存成 UTF-8 with BOM。
# ══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

$ROOT = $PSScriptRoot
$ELECTRON = Join-Path $ROOT '外壳\node_modules\electron\dist\electron.exe'
$SHELL_DIR = Join-Path $ROOT '外壳'
$ENGINE_DIR = Join-Path $ROOT '引擎'
$DATA_DIR = Join-Path $ROOT '数据'

Write-Host ''
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '  DSH 工作台' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host "  引擎: $ENGINE_DIR"
Write-Host "  数据: $DATA_DIR"
Write-Host ''

# ── 检查必需文件 ──
$missing = @()
if (-not (Test-Path $ELECTRON))       { $missing += "Electron: $ELECTRON" }
if (-not (Test-Path (Join-Path $ENGINE_DIR 'package.json'))) { $missing += "引擎: $ENGINE_DIR\package.json" }
if (-not (Test-Path (Join-Path $ENGINE_DIR 'node.exe')))     { $missing += "node.exe: $ENGINE_DIR\node.exe" }

if ($missing.Count -gt 0) {
    Write-Host '[错误] 缺少必需文件：' -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  · $m" -ForegroundColor Red }
    Write-Host ''
    Write-Host '按任意键退出...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

# ── 首次运行初始化数据目录 ──
if (-not (Test-Path $DATA_DIR)) { New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null }
if (-not (Test-Path (Join-Path $DATA_DIR '.dsh'))) { New-Item -ItemType Directory -Path (Join-Path $DATA_DIR '.dsh') -Force | Out-Null }

# ── 关键环境变量 ──
# ① 前端版本（不设会用旧前端）
$env:DSH_FRONTEND = 'v2'
# ② 明确不是纯 Node 模式（否则 electron 不起窗口）
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# ③ 显式 PATH
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem"

Write-Host '  启动中，请稍候...' -ForegroundColor Green
Write-Host ''

# ── 启动（目录参数必须在最前面，这是踩过的坑）──
Start-Process -FilePath $ELECTRON `
  -ArgumentList @('.', '--disable-gpu', '--disable-gpu-compositing', '--no-sandbox', '--disable-software-rasterizer') `
  -WorkingDirectory $SHELL_DIR

Write-Host '  已启动。窗口出现需要约 10-30 秒（首次会启动引擎）。' -ForegroundColor Green
Write-Host ''
Write-Host '  若窗口显示"引擎启动失败"，请查看 外壳\server.log' -ForegroundColor DarkGray
Write-Host ''

Start-Sleep -Seconds 2
