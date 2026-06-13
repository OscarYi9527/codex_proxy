@echo off
setlocal EnableDelayedExpansion
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString(\"N\").Substring(0,8)"') do set _SID=%%i
set ANTHROPIC_BASE_URL=http://127.0.0.1:47891/s/s!_SID!
claude %*
