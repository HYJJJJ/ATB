@echo off
cd /d "%~dp0"
set "ATB_DATA_DIR=%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [ATB] Preview dependencies are missing. Run npm ci, npm ci --prefix modules/assistant, then node node_modules/electron/install.js in this folder.
  pause
  exit /b 1
)
echo [ATB] Starting the latest local source preview.
call npm run desktop
if errorlevel 1 pause
