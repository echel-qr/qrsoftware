@echo off
setlocal
cd /d "%~dp0"
title Echel - Agent Installer
color 0F
echo.
echo ECHEL - PRINT CONNECT
echo Windows Agent Setup
echo.
echo [1/4] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo Python is required. Install it from python.org and select Add Python to PATH.
    start "" https://www.python.org/downloads/
    pause
    exit /b 1
)
echo [2/4] Installing the printing and desktop panel components...
python -m pip install requests pywin32 Pillow PyPDF2 pycryptodome pystray pywebview --quiet
if errorlevel 1 (
    echo Installation failed. Check your internet connection and run this installer again.
    pause
    exit /b 1
)
echo [3/4] Checking SumatraPDF...
if not exist "%ProgramFiles%\SumatraPDF\SumatraPDF.exe" (
    winget install SumatraPDF.SumatraPDF --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 echo Install SumatraPDF from https://www.sumatrapdfreader.org before printing.
)
echo [4/4] Creating the Echel launcher...
> RUN_AGENT.bat echo @echo off
>> RUN_AGENT.bat echo cd /d "%%~dp0"
>> RUN_AGENT.bat echo start "" pythonw print_agent.py
choice /c YN /m "Start Echel automatically when Windows starts?"
if errorlevel 2 goto ready
> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EchelPrint.bat" echo @echo off
>> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EchelPrint.bat" echo cd /d "%~dp0"
>> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EchelPrint.bat" echo start "" pythonw print_agent.py
:ready
echo.
echo Setup complete. Use RUN_AGENT.bat to open Echel.
echo Select your printers in the Echel panel and keep the agent running while your shop is open.
choice /c YN /m "Start Echel now?"
if errorlevel 2 exit /b 0
start "" pythonw print_agent.py