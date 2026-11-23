@echo off
rem ============================================================
rem  DSH Workbench launcher  (v2 - WScript-hosted, like source mode)
rem ============================================================
rem
rem  WHY v2: the packaged exe would not start when launched from cmd
rem  `start` or from a PowerShell child process (1 zombie process,
rem  zero log output, exit code -2147483645 = STATUS_DLL_INIT_FAILED).
rem
rem  The SOURCE build starts fine on this same machine, and it is
rem  launched by:  VBScript -> WScript.Shell.Run -> electron.exe
rem
rem  So this launcher does the same: writes a tiny .vbs and runs it.
rem  WScript.Shell detaches from the caller's console/process tree,
rem  which is what makes Electron's DLL init succeed here.
rem
setlocal
set ELECTRON_RUN_AS_NODE=
set DSH_SKIP_SINGLE_LOCK=1
cd /d "%~dp0"

rem Build a small VBS launcher next to this script
> "_launch.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "_launch.vbs" echo Set fso = CreateObject("Scripting.FileSystemObject")
>> "_launch.vbs" echo d = fso.GetParentFolderName(WScript.ScriptFullName)
>> "_launch.vbs" echo exe = d ^& "\DSH Workbench.exe"
>> "_launch.vbs" echo If Not fso.FileExists(exe) Then
>> "_launch.vbs" echo   For Each f In fso.GetFolder(d).Files
>> "_launch.vbs" echo     If LCase(Right(f.Name, 4)) = ".exe" Then exe = f.Path
>> "_launch.vbs" echo   Next
>> "_launch.vbs" echo End If
>> "_launch.vbs" echo sh.Environment("PROCESS")("DSH_SKIP_SINGLE_LOCK") = "1"
>> "_launch.vbs" echo sh.CurrentDirectory = d
>> "_launch.vbs" echo sh.Run """" ^& exe ^& """ --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer", 0, False

cscript //nologo "_launch.vbs"
del "_launch.vbs" 2>nul

endlocal
