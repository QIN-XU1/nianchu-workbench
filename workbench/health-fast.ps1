# health-fast.ps1 — scheduled fast-tier health check launcher
#
# IMPORTANT: this file must stay ASCII-only.
#
# Measured 2026-11-12, four failed attempts to automate this:
#   1) Chinese path in .cmd   -> Task Scheduler Last Result 0x80070002
#   2) UTF-8 BOM in .cmd      -> "@echo off" mangled
#   3) ASCII .cmd + Chinese path inside it -> cmd.exe code page truncation
#      ("'0"' / "'\xxx.mjs" --fast' is not recognized")
#   4) Chinese literal inside .ps1 written by a non-UTF8-aware editor
#      -> path decoded as "宸ュ叿\鍒嗙骇浣撴.mjs" (mojibake), file not found
#
# So: keep this file ASCII. Resolve the tool path by *searching*, not by
# embedding Chinese directory names as string literals.

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Find the tiered-health tool without embedding any non-ASCII literal:
# it is the only *.mjs under any subdirectory whose name we discover by
# matching on the ASCII part of the filename ("health" is not in it, so we
# match by enumerating and picking the file that exports splitByTier).
$tool = $null
Get-ChildItem -Path $here -Directory | ForEach-Object {
    $cand = Join-Path $_.FullName '*'.Replace('*', '')
    $mjs = Get-ChildItem -Path $_.FullName -Filter '*.mjs' -File -ErrorAction SilentlyContinue |
        Where-Object { (Select-String -Path $_.FullName -Pattern 'splitByTier' -Quiet -ErrorAction SilentlyContinue) }
    if ($mjs -and -not $tool) { $tool = $mjs[0].FullName }
}

if (-not $tool) {
    Write-Host "  XX cannot locate the tiered-health tool (splitByTier not found)"
    exit 1
}

Write-Host "  tool: $tool"

Push-Location $here
try {
    & node $tool --fast
    $rc = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $rc
