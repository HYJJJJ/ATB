@echo off
cd /d "%~dp0"
set "ATB_DATA_DIR=%~dp0"
node server/index.js
pause
