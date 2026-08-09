@echo off
setlocal
cd /d "%~dp0"
start "" wscript.exe "%~dp0launcher\start-hidden.vbs"
exit /b 0
