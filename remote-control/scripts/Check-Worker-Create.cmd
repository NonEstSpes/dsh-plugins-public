@echo off
setlocal DisableDelayedExpansion
if "%~3"=="" goto usage
if not "%~4"=="" goto usage
if not exist "%~1" goto failed
if not exist "%~2" goto failed
echo Read-only check of ONE explicitly identified create operation on the WORKER PC.
echo No app requests, state writes, lock changes or retries are performed.
"%~1" "%~dp0diagnose-create.mjs" --journal "%~2" --request-id "%~3"
if errorlevel 1 goto failed
echo Review the JSON locally before sharing. Do NOT send configuration files.
exit /b 0
:usage
echo Usage: Check-Worker-Create.cmd "ABSOLUTE_NODE_EXE" "ABSOLUTE_WORKER_JOURNAL" "ORIGINAL_REQUEST_ID" 1>&2
exit /b 1
:failed
echo Diagnostic stopped. Do not guess paths, create another session or delete locks. 1>&2
exit /b 1
