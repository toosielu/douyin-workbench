@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\ordinary-run.mjs --config config\ordinary-excel.local.json
pause
