@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Company-Service.ps1" -Action Open
if errorlevel 1 pause
