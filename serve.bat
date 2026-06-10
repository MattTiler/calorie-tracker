@echo off
REM Double-click this file to run Calorie Tracker locally.
cd /d "%~dp0"
echo.
echo  Calorie Tracker is starting...
echo  Open this in your browser:  http://localhost:8000
echo  (Press Ctrl+C in this window to stop.)
echo.
start "" http://localhost:8000/
py -m http.server 8000
