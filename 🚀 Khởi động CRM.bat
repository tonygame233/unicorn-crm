@echo off
title Unicorn CRM
chcp 65001 >nul
echo.
echo  ================================
echo    UNICORN CRM - DANG KHOI DONG
echo  ================================
echo.

cd /d "%~dp0backend"

where node >nul 2>nul
if errorlevel 1 (
    echo  [LOI] Chua cai Node.js! Tai tai: https://nodejs.org
    pause
    exit
)

echo  [1] Dang khoi dong server...
start "Unicorn CRM Server" /min cmd /k "node server.js"

echo  [2] Cho server san sang...
timeout /t 3 /nobreak >nul

echo  [3] Mo trinh duyet...
start "" "http://localhost:3000"

echo.
echo  CRM dang chay tai: http://localhost:3000
echo  Dang nhap: admin@unicorn.com / 123456
echo.
echo  De tat server: dong cua so "Unicorn CRM Server" tren taskbar
echo.
pause >nul
