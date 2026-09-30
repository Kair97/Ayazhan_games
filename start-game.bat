@echo off
"%SystemRoot%\System32\chcp.com" 65001 >nul
title Бәйге · Түрік қағанаты
cd /d "%~dp0"

rem Right after installing Node.js the PATH may not be refreshed yet: also look in the default install folder.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
"%SystemRoot%\System32\where.exe" node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"
if errorlevel 1 goto oldnode

if not exist "node_modules\qrcode\" (
  echo.
  echo   Бірінші іске қосу: қажетті файлдар жүктелуде. 1-2 минут күтіңіз...
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto noinstall
)

set OPEN_BROWSER=1
node server.js
echo.
pause
exit /b 0

:nonode
echo.
echo   Node.js бағдарламасы табылмады.
echo   Ашылған сайттан LTS нұсқасын жүктеп орнатыңыз, сосын осы файлды қайта ашыңыз.
echo.
start "" https://nodejs.org/
pause
exit /b 1

:oldnode
echo.
echo   Node.js нұсқасы тым ескі. https://nodejs.org сайтынан жаңа LTS нұсқасын орнатыңыз.
echo.
start "" https://nodejs.org/
pause
exit /b 1

:noinstall
echo.
echo   Файлдарды жүктеу сәтсіз аяқталды. Интернетке қосылып, осы файлды қайта ашыңыз.
echo.
pause
exit /b 1
