@echo off
cd /d "%~dp0"
set "ATB_DATA_DIR=%~dp0"
for /f "delims=" %%V in ('node -p "require('./package.json').version.replaceAll('.', '')"') do set "ATB_RELEASE_VERSION=%%V"
if exist "release-atb-%ATB_RELEASE_VERSION%\full\win-unpacked\ATB.exe" (
  start "" "release-atb-%ATB_RELEASE_VERSION%\full\win-unpacked\ATB.exe"
  exit /b
)
call npm run desktop
if errorlevel 1 pause
