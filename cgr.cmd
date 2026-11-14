@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%lib\cli.js" %*
exit /b %ERRORLEVEL%
