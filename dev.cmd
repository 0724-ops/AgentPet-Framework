@echo off
rem AgentPet Framework 开发版启动器
rem 直接双击即可；需要看控制台输出时在命令行运行：dev.cmd --console
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "ELECTRON=app\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [错误] 找不到 Electron：%ELECTRON%
  echo 请先在 app 目录里执行 npm install
  pause
  exit /b 1
)

if /i "%~1"=="--console" (
  set "ARGS=%*"
  set "ARGS=!ARGS:--console=!"
  "%ELECTRON%" "app" !ARGS!
  exit /b !errorlevel!
)

start "" "%ELECTRON%" "app" %*
echo 已启动 AgentPet Framework
echo 日志：%~dp0logs\pet.log
