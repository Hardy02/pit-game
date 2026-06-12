@echo off
REM ============================================================================
REM  One-time setup: lets friends on your Wi-Fi reach the PIT server (port 3000).
REM  Double-click this file and click "Yes" on the Windows permission prompt.
REM  The rule is scoped to your LOCAL network only (LocalSubnet) for safety.
REM ============================================================================

REM --- Re-launch elevated (as Administrator) if we aren't already ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator permission...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   Adding firewall rule: PIT Game (TCP 3000), local network only...
echo.

REM Remove any old copy first so re-running doesn't pile up duplicates.
netsh advfirewall firewall delete rule name="PIT Game (TCP 3000)" >nul 2>&1

netsh advfirewall firewall add rule name="PIT Game (TCP 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any remoteip=LocalSubnet

if %errorlevel% equ 0 (
  echo.
  echo   Done. Friends on the same Wi-Fi can now reach your server at:
  echo       http://192.168.0.229:3000
  echo.
  echo   You can close this window.
) else (
  echo.
  echo   Something went wrong adding the rule.
)
echo.
pause
