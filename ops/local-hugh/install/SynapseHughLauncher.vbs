' Запасной скрытый запускатель на случай, если WinExe не удалось собрать.
' Запуск: wscript.exe //B //Nologo SynapseHughLauncher.vbs "<node.exe>" "<main.js>" "<config.json>"
' Окно не показывается (второй аргумент Run = 0), ожидание завершения включено, код выхода
' node.exe возвращается планировщику. Один экземпляр обеспечивают MultipleInstances=IgnoreNew
' в задаче и файл-замок самого worker.
Option Explicit
Dim shell, args, command, code
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count < 3 Then WScript.Quit 2
command = """" & args(0) & """ """ & args(1) & """ """ & args(2) & """"
code = shell.Run(command, 0, True)
WScript.Quit code
