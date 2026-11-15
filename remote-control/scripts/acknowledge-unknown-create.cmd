@echo off
setlocal DisableDelayedExpansion
if not defined DSH_DESKTOP_EXE set "DSH_DESKTOP_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%DSH_DESKTOP_EXE%" (
  echo Approved installed signed Desktop executable not found. Nothing changed. 1>&2
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%DSH_DESKTOP_EXE%" --expose-internals "%~dp0acknowledge-unknown-create.mjs" %* --desktop-exe "%DSH_DESKTOP_EXE%"
exit /b %errorlevel%
