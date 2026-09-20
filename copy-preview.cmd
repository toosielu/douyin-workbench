@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\copy-preview.mjs --excel "tests\fixtures\copy-library.xlsx" --materials "D:\materials\demo"
pause
