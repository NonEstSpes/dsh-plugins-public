@echo off
setlocal DisableDelayedExpansion
set "WORKER_SETUP_NODE="
if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "WORKER_SETUP_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined WORKER_SETUP_NODE for %%N in (node.exe) do set "WORKER_SETUP_NODE=%%~$PATH:N"
if not defined WORKER_SETUP_NODE goto missing_node
"%WORKER_SETUP_NODE%" "%~dp0worker-setup.mjs" %*
set "WORKER_SETUP_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %WORKER_SETUP_EXIT%
:missing_node
echo Node.js 22 or newer is required. No administrator permissions are needed.
if "%~1"=="" pause
exit /b 1
