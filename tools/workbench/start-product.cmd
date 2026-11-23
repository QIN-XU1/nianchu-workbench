@echo off
REM ============================================================
REM  Nianchu product launcher
REM
REM  一份软件 = 一个进程。它同时提供：
REM    界面       http://127.0.0.1:47124/
REM    WebSocket  ws://127.0.0.1:47124/ws   （主 agent 的会话/对话通道）
REM    API        /api/plugin-run /api/mcp /api/scheduler/tick /api/skills ...
REM
REM  不再需要单独启动 ws-host（2026-11-18 合并进同一端口）。
REM ============================================================
setlocal
set "ROOT=%~dp0..\.."
cd /d "%ROOT%"

if not exist "apps\vouch-web\dist\index.html" (
  echo [!] 找不到构建产物 apps\vouch-web\dist\index.html
  echo     先构建前端：
  echo       cd apps\vouch-web\src\web-ui
  echo       ..\..\node_modules\.bin\vite.cmd build
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未找到 node。请先安装 Node.js 20+
  exit /b 1
)

echo [*] 检查模型网关...
node -e "fetch(process.env.NIANCHU_GATEWAY || 'http://127.0.0.1:3425/v1/models', { signal: AbortSignal.timeout(2500) }).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if errorlevel 1 (
  echo     [!] 模型网关不可达。
  echo         界面和知识图谱仍可用，但主 agent 无法回复。
  echo         可用 NIANCHU_GATEWAY 指定网关地址后再启动。
) else (
  echo     [ok] 模型网关正常
)

echo.
echo [*] 启动念初 · http://127.0.0.1:47124/
echo     关闭此窗口即停止。
echo     用户数据：%%APPDATA%%\Nianchu
echo.

start "" cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:47124/"
node tools\workbench\serve.mjs
endlocal
