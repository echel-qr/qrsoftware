@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Configure-Echel.ps1"
set "ECHEL_CONFIG_RESULT=%ERRORLEVEL%"
pause
exit /b %ECHEL_CONFIG_RESULT%
