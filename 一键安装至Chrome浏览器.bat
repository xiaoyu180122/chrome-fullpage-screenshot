@echo off
pushd "%~dp0"
echo ========================================================
echo   Google Chrome Full Page Screenshot Extension Helper
echo ========================================================
echo Opening chrome://extensions in Google Chrome...
start chrome chrome://extensions
echo.
echo Installation Steps for Google Chrome:
echo 1. In Chrome, enable "Developer mode" (top-right toggle).
echo 2. Click "Load unpacked" button (top-left).
echo 3. Select this folder in the dialog:
echo    %CD%
echo.
echo Done! Pin the extension icon to your Chrome toolbar and enjoy 1-click full-page screenshots!
echo ========================================================
echo.
pause
