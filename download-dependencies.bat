@echo off
REM Fetch every dependency without building anything.
REM Same contract as build.bat: fresh-machine capable, idempotent, silent mode.
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\bootstrap.ps1"
exit /b %ERRORLEVEL%
