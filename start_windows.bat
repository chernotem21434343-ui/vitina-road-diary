@echo off
setlocal
for /f "usebackq tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
.venv\Scripts\waitress-serve.exe --listen=127.0.0.1:8787 --call app:create_app
