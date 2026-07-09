Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")

proxyDir = Fso.GetParentFolderName(WScript.ScriptFullName)
scriptFile = proxyDir & "\src\server.js"
logFile = proxyDir & "\codex-proxy.log"
errorFile = proxyDir & "\codex-proxy.error.log"

inner = "node """ & scriptFile & """ > """ & logFile & """ 2> """ & errorFile & """"
command = "cmd /c """ & inner & """"
WshShell.Run command, 0, False
