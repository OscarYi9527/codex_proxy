' Claude Code Model Proxy - Silent Startup Script
' Place shortcut in Windows Startup folder for auto-launch on boot

Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

proxyDir = WshShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\proxy"
logFile = proxyDir & "\proxy.log"
pidFile = proxyDir & "\.proxy.pid"

' Check if already running via port
Set netstat = WshShell.Exec("netstat -ano")
output = netstat.StdOut.ReadAll
If InStr(output, ":47891") > 0 And InStr(output, "LISTENING") > 0 Then
    ' Already running, nothing to do
    WScript.Quit 0
End If

' Clean up stale PID file
If FSO.FileExists(pidFile) Then
    FSO.DeleteFile pidFile
End If

' Start proxy hidden
WshShell.Run "node """ & proxyDir & "\server.js"" > """ & logFile & """ 2>&1", 0, False
