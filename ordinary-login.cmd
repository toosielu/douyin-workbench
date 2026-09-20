@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0config\ordinary-account.local.json" goto connect
node src\ordinary-login.mjs --file "D:\Demo\douyin_play\video\test1.mp4"
if errorlevel 1 goto done
goto verify
:connect
node src\cli.mjs connect --config config\ordinary-account.local.json --account ordinary-test
if errorlevel 1 goto done
:verify
node src\cli.mjs verify --config config\ordinary-account.local.json --account ordinary-test
:done
pause
