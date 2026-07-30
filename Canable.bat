@echo off
setlocal enabledelayedexpansion
title EBICS Canable - sterowanie serwerem
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [BLAD] Nie znaleziono Node.js w systemie.
  echo   Zainstaluj Node.js ^(https://nodejs.org^) i uruchom ponownie.
  echo.
  pause
  exit /b
)

:menu
cls
echo ==================================================
echo            EBICS Canable - serwer
echo ==================================================
call :status_line
echo.
echo   [1] Start serwera + otworz w przegladarce
echo   [2] Stop serwera
echo   [3] Restart serwera
echo   [4] Sprawdz status
echo   [5] Otworz w przegladarce
echo   [0] Wyjscie
echo.
set "choice="
set /p "choice=Wybierz numer i Enter: "

if "%choice%"=="1" goto do_start
if "%choice%"=="2" goto do_stop
if "%choice%"=="3" goto do_restart
if "%choice%"=="4" goto do_status
if "%choice%"=="5" goto do_open
if "%choice%"=="0" exit /b
goto menu

:do_start
call :isrunning
if "!RUNNING!"=="1" (
  echo   Serwer juz dziala.
) else (
  echo   Uruchamiam serwer...
  start "EBICS Canable Server" /min cmd /c "cd /d "%~dp0" && node server.js"
  timeout /t 2 /nobreak >nul
)
start "" http://localhost:8080
echo   Gotowe. Adres: http://localhost:8080
pause
goto menu

:do_stop
call :killport
echo   Serwer zatrzymany.
pause
goto menu

:do_restart
call :killport
timeout /t 1 /nobreak >nul
start "EBICS Canable Server" /min cmd /c "cd /d "%~dp0" && node server.js"
timeout /t 2 /nobreak >nul
echo   Serwer zrestartowany. Adres: http://localhost:8080
pause
goto menu

:do_status
call :status_line
pause
goto menu

:do_open
start "" http://localhost:8080
goto menu

:status_line
call :isrunning
if "!RUNNING!"=="1" (
  echo   STATUS: DZIALA  ^(http://localhost:8080^)
) else (
  echo   STATUS: zatrzymany
)
exit /b

:isrunning
set "RUNNING=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080 " ^| findstr "LISTENING"') do set "RUNNING=1"
exit /b

:killport
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
exit /b
