@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo 正在启动 License Admin 本地服务器...
echo.
node serve-admin.js
pause
