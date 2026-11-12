@echo off
cd /d "%~dp0"
set "ATB_DATA_DIR=%~dp0"
if exist "release-atb-060\full\win-unpacked\ATB.exe" (
  start "" "release-atb-060\full\win-unpacked\ATB.exe"
  exit /b
)
call npm run desktop
if errorlevel 1 pause
