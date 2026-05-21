$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'))
$ShortcutPath = Join-Path $DesktopPath "Antigravity Remote.lnk"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
# Target cmd.exe running the batch file so Windows allows pinning it to the taskbar!
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/c C:\Users\thiag\.gemini\antigravity\scratch\antigravity-remote\iniciar-remote.bat"
$Shortcut.WorkingDirectory = "C:\Users\thiag\.gemini\antigravity\scratch\antigravity-remote"
$Shortcut.Description = "Iniciar Antigravity Remote Control"
$Shortcut.IconLocation = "C:\Users\thiag\.gemini\antigravity\scratch\antigravity-remote\logo.ico"
$Shortcut.Save()

Write-Host "¡Acceso directo creado con éxito en el Escritorio!"
