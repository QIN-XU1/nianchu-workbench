# ══════════════════════════════════════════════════════════════
#  CI 定时任务入口 —— 每天跑一次完整检查
#
#  用法：
#    1. 直接运行：pwsh -File ci-run.ps1
#    2. 挂到 Windows 计划任务（每天 09:00）：
#       schtasks /create /tn "DSH-Agent-CI" ^
#         /tr "pwsh -NoProfile -File \"<此文件完整路径>\"" ^
#         /sc daily /st 09:00
#
#  输出：
#    · 控制台显示结果
#    · 日志写入 外壳\data\ci-log.txt
#    · 失败项自动进 _待办.md
# ══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Continue'

# 切到 workbench 目录（脚本在 工具/ 下）
$TOOL_DIR = $PSScriptRoot
$WB = Split-Path $TOOL_DIR -Parent
$ROOT = Split-Path $WB -Parent
$LOG = Join-Path $WB '外壳\data\ci-log.txt'

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

# 写日志头
$header = @(
    '',
    ('=' * 60),
    "CI 运行: $stamp",
    ('=' * 60)
) -join "`r`n"
Add-Content -Path $LOG -Value $header -Encoding UTF8

# 跑 CI
Push-Location $WB
try {
    $output = node (Join-Path $TOOL_DIR 'ci.mjs') 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

# 输出到控制台
$output | ForEach-Object { Write-Host $_ }

# 写日志
Add-Content -Path $LOG -Value ($output -join "`r`n") -Encoding UTF8
Add-Content -Path $LOG -Value "`r`n退出码: $code" -Encoding UTF8

Write-Host ''
if ($code -ne 0) {
    Write-Host '[CI] 有检查失败' -ForegroundColor Yellow
    Write-Host "[CI] 详见: $LOG"
    Write-Host '[CI] 失败项已自动写入 _待办.md'
} else {
    Write-Host '[CI] 全部通过' -ForegroundColor Green
}
Write-Host ''
Write-Host "日志: $LOG"

exit $code
