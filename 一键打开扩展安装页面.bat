@echo off
pushd "%~dp0"
echo ========================================================
echo   Chrome Full Page Screenshot Extension Installer Helper
echo ========================================================
echo Opening chrome://extensions in Chrome...
start chrome chrome://extensions
echo.
echo Installation Steps:
echo 1. In Chrome, enable "Developer mode" (top-right toggle).
echo 2. Click "Load unpacked" button (top-left).
echo 3. Select this folder in the dialog:
echo    %CD%
echo.
echo Done! Pin the extension icon to your toolbar and enjoy 1-click full-page screenshots!
echo ========================================================
echo.
pause
