param([int]$Port = 8765, [int]$AsrThreads = 3, [switch]$NoEmotion)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) { throw 'Run setup.ps1 first.' }
$arguments = @('-m','voice_companion.cli','serve','--port',"$Port",'--asr-threads',"$AsrThreads")
if ($NoEmotion) { $arguments += '--no-emotion' }
& $venvPython @arguments
exit $LASTEXITCODE
