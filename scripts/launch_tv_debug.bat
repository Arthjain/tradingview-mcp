@echo off
setlocal

REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

pushd "%~dp0.."
node "src\cli\index.js" launch --port %PORT%
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
