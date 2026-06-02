Option Explicit
Dim shell, fso, dir, http, i

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName) & "\backend"

If Not fso.FolderExists(dir) Then
    MsgBox "Khong tim thay thu muc backend!" & vbCrLf & dir, 16, "Unicorn CRM"
    WScript.Quit
End If

' Kiem tra Node.js
If shell.Run("cmd /c node --version", 0, True) <> 0 Then
    MsgBox "Chua cai Node.js! Tai tai: https://nodejs.org", 16, "Unicorn CRM"
    WScript.Quit
End If

' Kill tat ca node.exe (don gian, chac chan)
shell.Run "cmd /c taskkill /F /IM node.exe", 0, True
WScript.Sleep 1500

' Khoi dong server moi
shell.CurrentDirectory = dir
shell.Run "node server.js", 1, False

' Cho server san sang (toi da 20 giay)
For i = 1 To 20
    WScript.Sleep 1000
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    On Error Resume Next
    http.Open "GET", "http://localhost:3000/", False
    http.SetTimeouts 800, 800, 800, 800
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
        On Error GoTo 0
        shell.Run "http://localhost:3000"
        WScript.Quit
    End If
    On Error GoTo 0
Next

MsgBox "Server khong khoi dong duoc." & vbCrLf & _
       "Bam vao cua so node.exe tren taskbar de xem loi.", 48, "Unicorn CRM"
