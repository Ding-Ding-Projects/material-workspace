@echo off
REM Material Workspace one-click build.
REM
REM Designed for a completely fresh Windows install: no runtime, no SDK, no
REM package manager, no build tools. It obtains every dependency itself, builds
REM the real artifact, and only then offers to launch it.
REM
REM   build.bat            build, then ask whether to launch
REM   build.bat --run      build, then launch without asking
REM   build.bat /s         silent: no prompts, no pause, non-zero on failure
REM   build.bat /s --run   silent, and launch after a successful build
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "SILENT="
set "RUN_AFTER="

:parse
if "%~1"=="" goto parsed
if /I "%~1"=="/s" set "SILENT=1"
if /I "%~1"=="--silent" set "SILENT=1"
if /I "%~1"=="/run" set "RUN_AFTER=1"
if /I "%~1"=="--run" set "RUN_AFTER=1"
shift
goto parse
:parsed

if /I "%SILENT%"=="" if /I "%MATERIAL_WORKSPACE_SILENT%"=="1" set "SILENT=1"
if /I "%RUN_AFTER_BUILD%"=="1" set "RUN_AFTER=1"

set "SILENT_ARG="
if defined SILENT set "SILENT_ARG=-Silent"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\bootstrap.ps1" %SILENT_ARG%
if errorlevel 1 (
  echo [build] dependency bootstrap failed. Nothing was built.
  exit /b 1
)

call npm --prefix "%SCRIPT_DIR%." run build
if errorlevel 1 (
  echo [build] the build failed. The previous output was not replaced.
  exit /b 1
)

if defined RUN_AFTER goto launch
if defined SILENT exit /b 0
choice /C YN /N /M "Launch Material Workspace now? [Y/N] "
if errorlevel 2 exit /b 0

:launch
call npx --prefix "%SCRIPT_DIR%." electron "%SCRIPT_DIR%."
exit /b %ERRORLEVEL%
