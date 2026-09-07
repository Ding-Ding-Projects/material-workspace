@echo off
REM Produce the unsigned Squirrel.Windows installer.
REM
REM This builds the artifact a person downloads and installs, through the same
REM packaging path CI uses, so a locally built installer and a released one are
REM the same thing rather than two things that resemble each other.
REM
REM Code signing is permanently out of scope. The installer is unsigned and
REM this script says so rather than leaving you to discover it from a warning.
REM
REM It never publishes, tags, or creates a release. Building and shipping are
REM different actions with different authority.
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "SILENT="
if /I "%~1"=="/s" set "SILENT=1"
if /I "%~1"=="--silent" set "SILENT=1"
if /I "%MATERIAL_WORKSPACE_SILENT%"=="1" set "SILENT=1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\bootstrap.ps1"
if errorlevel 1 (
  echo [installer] dependency bootstrap failed. Nothing was built.
  exit /b 1
)

call npm --prefix "%SCRIPT_DIR%." run package
if errorlevel 1 (
  echo [installer] packaging failed.
  exit /b 1
)
exit /b 0
