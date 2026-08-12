@echo off
setlocal
title ANGEL - nodo di emergenza

rem ─────────────────────────────────────────────────────────────
rem  Avvia il sorvegliante del nodo di emergenza.
rem
rem  Il lavoro vero lo fa sorveglia.ps1: questo file esiste perche' su Windows
rem  un .bat si apre con doppio clic e uno script PowerShell no — di norma la
rem  policy di esecuzione lo blocca, e chi ha il server giu' non ha voglia di
rem  scoprire come si sbloccano gli script.
rem
rem  Uso:
rem    angel-emergenza.bat            menu interattivo
rem    angel-emergenza.bat /auto      sorveglianza continua, senza domande
rem    angel-emergenza.bat /stato     un solo controllo e chiude
rem ─────────────────────────────────────────────────────────────

cd /d "%~dp0"

rem Docker serve solo per accendere il nodo, non per controllare se il server
rem risponde: si avvisa e si prosegue, invece di bloccare chi sta ancora
rem preparando la cartella.
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ATTENZIONE: Docker non risulta installato.
  echo   Il controllo del server funziona lo stesso, ma il nodo di emergenza
  echo   non potra' partire finche' non installi Docker Desktop:
  echo   https://www.docker.com/products/docker-desktop/
  echo.
)

if not exist "docker-compose.emergenza.local.yml" if not exist "docker-compose.emergenza.yml" (
  echo.
  echo   Manca il file docker-compose in questa cartella.
  echo.
  pause
  exit /b 1
)

rem -ExecutionPolicy Bypass vale per questo solo processo: non cambia nulla
rem nelle impostazioni del sistema.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sorveglia.ps1" %*

if errorlevel 1 pause
endlocal
