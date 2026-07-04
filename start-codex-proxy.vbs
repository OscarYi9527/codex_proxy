Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")

proxyDir = Fso.GetParentFolderName(WScript.ScriptFullName)
scriptFile = proxyDir & "\codex-proxy.js"
logFile = proxyDir & "\codex-proxy.log"
errorFile = proxyDir & "\codex-proxy.error.log"

command = "node """ & scriptFile & """ > """ & logFile & """ 2> """ & errorFile & """"
WshShell.Run command, 0, False
