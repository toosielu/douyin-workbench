@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if exist "%~dp0.sau-demo-venv\Scripts\python.exe" (
  set "SAU_DEMO_PYTHON=%~dp0.sau-demo-venv\Scripts\python.exe"
) else (
  set "SAU_DEMO_PYTHON=python"
)
if not "%~1"=="" goto command
"%SAU_DEMO_PYTHON%" -X utf8 -m sau_demo demo
set "SAU_DEMO_STATUS=%ERRORLEVEL%"
pause
exit /b %SAU_DEMO_STATUS%
:command
"%SAU_DEMO_PYTHON%" -X utf8 -m sau_demo %*
exit /b %ERRORLEVEL%
