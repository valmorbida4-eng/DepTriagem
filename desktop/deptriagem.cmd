@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\DepTriagem.exe" "%~dp0app.asar\build\electron\cli.js" %*
exit /b %ERRORLEVEL%
