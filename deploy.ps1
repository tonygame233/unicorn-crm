# ============================================
# UNICORN CRM - DEPLOY SCRIPT
# Double-click hoac chay trong PowerShell
# ============================================

Write-Host "========================================" -ForegroundColor Yellow
Write-Host "   UNICORN CRM - DEPLOY TO CLOUDFLARE" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

$workerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerDir = Join-Path $workerDir "worker"
$htmlSrc   = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "telegram_sales_crm_demo (2).html"
$htmlDest  = Join-Path $workerDir "public\index.html"

# 1. Copy frontend
Write-Host "[1/3] Copy frontend..." -ForegroundColor Cyan
Copy-Item $htmlSrc $htmlDest -Force
Write-Host "      OK: index.html updated" -ForegroundColor Green

# 2. Install deps neu chua co
Write-Host "[2/3] Check dependencies..." -ForegroundColor Cyan
Set-Location $workerDir
if (-not (Test-Path "node_modules")) {
    Write-Host "      Installing npm packages..." -ForegroundColor Yellow
    npm install --silent
}
Write-Host "      OK" -ForegroundColor Green

# 3. Deploy
Write-Host "[3/3] Deploying to Cloudflare Workers..." -ForegroundColor Cyan
Write-Host ""
npx wrangler deploy

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "   DONE! Kiem tra tai:" -ForegroundColor Green
Write-Host "   https://unicorn-crm.phuchuuhuynh203.workers.dev" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Nhan phim bat ky de dong..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
