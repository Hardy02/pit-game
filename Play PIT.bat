@echo off
setlocal
title PIT Server
cd /d "%~dp0"

REM --- Locate Node: prefer PATH, fall back to the standard install folder ---
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=%ProgramFiles%\nodejs\node.exe"

if not exist "%NODE%" if "%NODE%"=="node" goto :run
if not exist "%NODE%" (
  echo.
  echo   Node.js was not found.
  echo   Install it from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

:run
echo.
echo   Starting PIT multiplayer server...
echo   A browser tab will open at http://localhost:3000
echo.
echo   Keep this window open while playing.
echo   Close it (or press Ctrl+C) to stop the server.
echo.

REM Open the browser a moment after the server has started (runs in parallel).
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

REM Run the server in this window so its logs are visible and closing stops it.
"%NODE%" server.js

echo.
echo   Server stopped.
pause
