@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "$port = $env:PORT; if (-not $port) { $port = 3000 }; $url = 'http://localhost:' + $port; try { $h = Invoke-RestMethod ($url + '/api/health') -TimeoutSec 1; if ($h.ok -and $h.tickRate -eq 30) { Start-Process $url; exit 0 } } catch {}; exit 1"
if not errorlevel 1 exit /b
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" 2>nul
if errorlevel 1 (echo Node.js 22 or newer is required. & pause & exit /b 1)
node -e "require('socket.io')" 2>nul
if errorlevel 1 (
  call npm ci --no-audit --no-fund
  if errorlevel 1 (echo Dependency installation failed. Check your network. & pause & exit /b 1)
)
node server.mjs --open
if errorlevel 1 pause
