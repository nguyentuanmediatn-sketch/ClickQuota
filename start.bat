@echo off
setlocal
chcp 65001 >nul 2>&1
title ClickQuota
cd /d "%~dp0"

echo ========================================================
echo   ClickQuota - ClickUp AI standalone provider
echo ========================================================

rem ---- 1. Node.js ----
where node >nul 2>&1
if not errorlevel 1 goto have_node
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
where node >nul 2>&1
if errorlevel 1 goto no_node

:have_node
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=15)?0:1)"
if errorlevel 1 goto old_node
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v

rem ---- 2. Dependencies ----
if exist "node_modules\gpt-tokenizer\package.json" goto deps_ok
where npm >nul 2>&1
if errorlevel 1 goto no_npm
echo [.] First run on this machine: installing dependencies, please wait
if exist "package-lock.json" goto use_ci
call npm install --omit=dev --ignore-scripts
if errorlevel 1 goto npm_fail
goto deps_check
:use_ci
call npm ci --omit=dev --ignore-scripts
if errorlevel 1 goto npm_fail
:deps_check
if not exist "node_modules\gpt-tokenizer\package.json" goto npm_fail
:deps_ok

rem ---- 3. State directory ----
if not exist ".state" mkdir ".state"

rem ---- 4. Effective host and port (.env is loaded by node below) ----
echo.
echo   Admin UI : http://127.0.0.1:4310/admin  (default port, override in .env)
echo   Health   : http://127.0.0.1:4310/health
echo   The real address is printed by the server below.
echo   Press Ctrl+C to stop.
echo.

node --env-file-if-exists=.env src/index.mjs
set "RC=%ERRORLEVEL%"
echo.
echo [!] ClickQuota stopped with exit code %RC%
pause
exit /b %RC%

:no_node
echo [X] Node.js was not found. Install Node.js 22.15 or newer from https://nodejs.org/ and run start.bat again.
pause
exit /b 1

:old_node
for /f "delims=" %%v in ('node -v') do echo [X] Node.js %%v is too old. ClickQuota needs 22.15 or newer. Download: https://nodejs.org/
pause
exit /b 1

:no_npm
echo [X] node_modules is missing and npm was not found. Reinstall Node.js with npm included, or copy the node_modules folder.
pause
exit /b 1

:npm_fail
echo [X] Dependency installation failed. Check the network connection and the npm output above.
pause
exit /b 1
