param([string]$Address = '', [int]$Port = 8765)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) { throw 'Run setup.ps1 first.' }
$arguments = @('-m','voice_companion.cli','pair','--port',"$Port")
if ($Address) { $arguments += @('--advertise',$Address) }
& $venvPython @arguments
if ($LASTEXITCODE -ne 0) { throw 'Pairing file creation failed.' }
