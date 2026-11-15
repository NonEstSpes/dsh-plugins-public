@echo off
rem Start the local relay on loopback using the DSH installation runtime and the existing private pairing config.
setlocal DisableDelayedExpansion
set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo DSH runtime Node not found. 1>&2
  exit /b 1
)
cd /d "%~dp0.."
if not exist ".private\relay.json" (
  echo Relay configuration .private\relay.json is missing. 1>&2
  exit /b 1
)
"%NODE%" relay\cli.mjs .private\relay.json
exit /b %errorlevel%
