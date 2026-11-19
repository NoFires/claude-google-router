@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%lib\cli.js" %*
set "CGR_EXIT=%ERRORLEVEL%"
rem Double-clicked (no arguments): keep the window open only if something went wrong.
if "%~1"=="" if not "%CGR_EXIT%"=="0" pause
exit /b %CGR_EXIT%
