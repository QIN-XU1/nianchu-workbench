@echo off
REM ASCII-only launcher. Delegates to a PowerShell script (UTF-8 safe).
REM
REM History: 2026-11-12
REM   1) Chinese .cmd path -> Task Scheduler Last Result 0x80070002 (file not found)
REM   2) UTF-8 BOM in .cmd -> "@echo off" mangled
REM   3) Even ASCII .cmd with a Chinese path segment -> cmd.exe code-page breakage
REM   Fix: keep .cmd pure ASCII and put the real work in a .ps1.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0health-fast.ps1"
exit /b %ERRORLEVEL%
