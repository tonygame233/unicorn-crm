@echo off
chcp 65001 >nul
title Deploy Unicorn CRM

echo.
echo ==========================================
echo   UNICORN CRM - DEPLOY LEN CLOUDFLARE
echo ==========================================
echo.

:: [1] Copy HTML
echo [1/5] Copy frontend HTML...
if not exist "public" mkdir public
copy /Y "..\telegram_sales_crm_demo (2).html" "public\index.html" >nul
if errorlevel 1 (
    echo [LOI] Khong tim thay file HTML!
    pause
    exit
)
echo [OK] public\index.html da san sang

:: [2] Kiem tra Node.js
echo [2/5] Kiem tra Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo [LOI] Chua cai Node.js! Tai tai: https://nodejs.org
    pause
    exit
)
echo [OK] Node.js da co san

:: [3] Cai packages
echo [3/5] Cai packages...
call npm install
if errorlevel 1 (
    echo [LOI] npm install that bai!
    pause
    exit
)
echo [OK] Packages da cai

:: [4] Kiem tra wrangler (dung npx neu chua cai global)
echo [4/5] Kiem tra Wrangler...
where wrangler >nul 2>nul
if errorlevel 1 (
    echo Chua co wrangler global, dung npx...
    set WRANGLER=npx wrangler
) else (
    set WRANGLER=wrangler
)
echo [OK] Se dung: %WRANGLER%

:: [5] Kiem tra database_id
findstr /C:"REPLACE_WITH_YOUR_DB_ID" wrangler.toml >nul
if not errorlevel 1 (
    echo.
    echo ==========================================
    echo  LAN DAU DEPLOY: Can tao D1 database
    echo ==========================================
    echo.
    echo Dang tao D1 database...
    call %WRANGLER% d1 create unicorn-crm-db
    echo.
    echo ==========================================
    echo  BUOC TIEP THEO - Doc ky:
    echo ==========================================
    echo.
    echo  1. Nhin len phia tren tim dong:
    echo     database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    echo.
    echo  2. Mo file wrangler.toml
    echo.
    echo  3. Thay "REPLACE_WITH_YOUR_DB_ID"
    echo     bang database_id vua copy
    echo.
    echo  4. Chay lai deploy.bat nay
    echo.
    pause
    exit
)
echo [OK] D1 database da cau hinh

:: Khoi tao schema
echo Khoi tao bang trong D1...
call %WRANGLER% d1 execute unicorn-crm-db --remote --file=schema.sql
echo [OK] Schema da chay xong (loi neu bang da ton tai la binh thuong)

:: Deploy
echo [5/5] Dang deploy...
call %WRANGLER% deploy
if errorlevel 1 (
    echo [LOI] Deploy that bai!
    pause
    exit
)

echo.
echo ==========================================
echo  DEPLOY THANH CONG!
echo ==========================================
echo.
echo Truy cap CRM tai URL hien thi o phia tren
echo.
echo Dang nhap:
echo   admin@unicorn.com   / 123456
echo   sale@unicorn.com    / 123456
echo   support@unicorn.com / 123456
echo   mkt@unicorn.com     / 123456
echo.
echo LUU Y sau khi deploy:
echo - Vao Settings, them Channel voi bot token
echo - Bot se tu dong nhan tin nhan moi qua webhook
echo.
pause
