@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\v3\main.mjs --demo
pause
