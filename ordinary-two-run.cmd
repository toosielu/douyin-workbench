@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\ordinary-run.mjs --config config/ordinary-two-account.local.json
set "runResult=%errorlevel%"
pause
exit /b %runResult%
