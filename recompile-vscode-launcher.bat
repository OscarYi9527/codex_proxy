@echo off
title Codex VS Code Launcher - Recompile
echo Close ALL VS Code windows first (the launcher .exe must not be running), then press any key.
pause >nul
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-vscode-codex-compat.ps1" -InstallDir "%USERPROFILE%\.codex-local-multi-proxy" -UpdateSettings
echo.
pause
