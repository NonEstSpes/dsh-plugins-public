@echo off
setlocal DisableDelayedExpansion
if not defined DSH_DESKTOP_EXE set "DSH_DESKTOP_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%DSH_DESKTOP_EXE%" (
  echo Installed Desktop executable not found. Set DSH_DESKTOP_EXE to its approved absolute path. 1>&2
  exit /b 1
)
for %%I in ("%DSH_DESKTOP_EXE%") do set "DSH_APP_DIR=%%~dpI"
set "ELECTRON_RUN_AS_NODE=1"
"%DSH_DESKTOP_EXE%" --expose-internals "%~dp0controller-repair-offline.mjs" %* --desktop-exe "%DSH_DESKTOP_EXE%" --runtime-dir "%DSH_APP_DIR%resources\app.asar\dsh"
exit /b %errorlevel%
