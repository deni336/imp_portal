@echo off
setlocal
cd /d "%~dp0"
if not exist .venv (
    py -3 -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
pyinstaller --clean --noconfirm PIGPortalDesktop.spec
copy /Y pig_portal_config.ini dist\pig_portal_config.ini >nul
if not exist dist\data mkdir dist\data
if not exist dist\backups mkdir dist\backups
echo.
echo Build complete.
echo Copy these to the shared drive:
echo   dist\PIGPortalDesktop.exe
echo   dist\pig_portal_config.ini
echo   dist\data\
echo   dist\backups\
pause
