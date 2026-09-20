@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: workbench.cmd config\workbench.local.json
  pause
  exit /b 1
)
node src\v3\main.mjs --config "%~1"
pause
