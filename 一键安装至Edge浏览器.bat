@echo off
pushd "%~dp0"
echo ========================================================
echo   Microsoft Edge Full Page Screenshot Extension Helper
echo ========================================================
echo Opening edge://extensions in Microsoft Edge...
start msedge edge://extensions
echo.
echo Installation Steps for Microsoft Edge:
echo 1. In Edge, look at the LEFT SIDEBAR and enable "Developer mode" toggle.
echo 2. Click "Load unpacked" button (top-left or toolbar).
echo 3. Select this folder in the dialog:
echo    %CD%
echo.
echo Done! Pin the extension icon to your Edge toolbar and enjoy 1-click full-page screenshots!
echo ========================================================
echo.
pause
