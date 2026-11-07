@echo off
REM ============================================================================
REM WG Voice Agent Playground — Windows 10/11 一键启动脚本 (支持 CMD / PowerShell)
REM ============================================================================
chcp 65001 >nul
setlocal

set PORT=8091
echo ============================================================
echo   WG Voice Agent Playground (v0.5) — Windows Launcher
echo   Author: 王果 (wangguode)
echo ============================================================

cd /d "%~dp0java-freeswitch-rtp-bridge"

if not exist "target\freeswitch-rtp-bridge-0.3.0.jar" (
    echo [1/2] Building WG Voice Gateway Java 17 Kernel...
    call mvn -B -q clean package -DskipTests
)

echo [2/2] Starting WG Voice Agent Playground at http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
java -jar target\freeswitch-rtp-bridge-0.3.0.jar --server.port=%PORT%
endlocal
