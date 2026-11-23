' ══════════════════════════════════════════════════════════════════════
'  DSH 工作台 —— 启动器（照抄源码版的启动方式）
' ══════════════════════════════════════════════════════════════════════
'
'  为什么用 VBS 而不是 .cmd
'  ──────────────────────────────────────────────────────────────────
'  实测（2026-11-13）：打包出的 exe 从 cmd 的 start / PowerShell 子进程
'  启动时**必然失败**：
'    · 只剩 1 个僵尸进程
'    · 零日志输出（连 main.js 第一行都没执行）
'    · exit code -2147483645 = STATUS_DLL_INIT_FAILED
'
'  但**同一台机器上源码版能正常跑**，它是这样启动的：
'    VBScript → WScript.Shell.Run → electron.exe
'
'  ⇒ WScript.Shell 会脱离调用者的控制台/进程树，
'    这是 Electron 在这台机器上 DLL 初始化成功的前提。
'
'  所以打包版也用 VBS 启动，一模一样。
'
'  ⚠ 双击这个 .vbs 即可。不弹黑窗。
' ══════════════════════════════════════════════════════════════════════

Option Explicit

Dim fso, sh, env, d, exe, f, args

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' 脚本所在目录 = 产物根
d = fso.GetParentFolderName(WScript.ScriptFullName)

' 找 exe（名字含中文，用扩展名匹配更稳）
exe = ""
For Each f In fso.GetFolder(d).Files
    If LCase(fso.GetExtensionName(f.Name)) = "exe" Then
        exe = f.Path
        Exit For
    End If
Next

If exe = "" Then
    MsgBox "找不到 exe。" & vbCrLf & "目录：" & d, vbCritical, "DSH 工作台"
    WScript.Quit 1
End If

' ── 清除会让 Electron 退化成纯 Node 的环境变量 ──
' 实测：这个环境里 shell 残留 ELECTRON_RUN_AS_NODE=1，
'       不清掉的话 Electron 不加载界面、静默退出。
On Error Resume Next
Set env = sh.Environment("PROCESS")
env("ELECTRON_RUN_AS_NODE") = ""
env("DSH_SKIP_SINGLE_LOCK") = "1"
On Error GoTo 0

' ── 启动 ──
' 0 = 隐藏窗口（失败时不会有黑窗残留）
' False = 不等它结束
args = " --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer"
sh.CurrentDirectory = d
sh.Run """" & exe & """" & args, 0, False
