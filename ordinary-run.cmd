@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\ordinary-run.mjs %*
set "ordinary_run_exit=%errorlevel%"
pause
exit /b %ordinary_run_exit%
