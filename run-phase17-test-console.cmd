@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  ELIX Phase 17 Test Console - 17A Preview + 17B Placement
echo ============================================================
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found in PATH.
  echo Install/enable the repository's pnpm version, then run this launcher again.
  pause
  exit /b 1
)

call pnpm demo:phase17
set "ELIX_EXIT=%ERRORLEVEL%"

if not "%ELIX_EXIT%"=="0" (
  echo.
  echo [ERROR] Phase 17 Test Console exited with code %ELIX_EXIT%.
  pause
)

exit /b %ELIX_EXIT%
