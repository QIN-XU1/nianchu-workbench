' ======================================================================
'  DSH Workbench - launcher (ASCII only)
' ======================================================================
'
'  WHY VBS (not cmd):
'    On this machine Electron only starts when launched via
'    WScript.Shell.Run. Launching from cmd `start` or a PowerShell child
'    process results in 1 zombie process, zero log output, and
'    exit code -2147483645 (STATUS_DLL_INIT_FAILED).
'    WScript.Shell detaches from the caller's console and process tree.
'
'  WHY ASCII ONLY:
'    cscript reads .vbs as ANSI. Non-ASCII bytes (Chinese comments) make
'    it fail with "invalid character" at a line number unrelated to the
'    real cause. So this file must contain only ASCII.
'
'  Double-click this file to launch. No console window appears.
' ======================================================================

Option Explicit

Dim fso, sh, env, d, exePath, f, args

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

d = fso.GetParentFolderName(WScript.ScriptFullName)

' Find the .exe (name contains CJK chars, so match by extension)
exePath = ""
For Each f In fso.GetFolder(d).Files
    If LCase(fso.GetExtensionName(f.Name)) = "exe" Then
        exePath = f.Path
        Exit For
    End If
Next

If exePath = "" Then
    MsgBox "Cannot find the exe in: " & d, vbCritical, "DSH Workbench"
    WScript.Quit 1
End If

' Clear the env var that makes Electron run as plain Node
' (it silently loads nothing and exits).
On Error Resume Next
Set env = sh.Environment("PROCESS")
env("ELECTRON_RUN_AS_NODE") = ""
env("DSH_SKIP_SINGLE_LOCK") = "1"
On Error GoTo 0

args = " --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer"

sh.CurrentDirectory = d
sh.Run """" & exePath & """" & args, 0, False
