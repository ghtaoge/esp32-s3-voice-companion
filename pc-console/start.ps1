param(
    [int]$Port = 8766,
    [string]$AsrHost = '',
    [int]$AsrPort = 8765,
    [string]$DeviceId = 'esp32-s3',
    [string]$Address = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw '请先在项目根目录运行 setup.ps1，创建Python环境。'
}
$consoleTemp = Join-Path $projectRoot '.downloads\build-temp'
New-Item -ItemType Directory -Path $consoleTemp -Force | Out-Null
$env:TEMP = $consoleTemp
$env:TMP = $consoleTemp
$consoleArgs = @((Join-Path $PSScriptRoot 'server.py'), '--port', $Port, '--asr-port', $AsrPort, '--device-id', $DeviceId)
if ($AsrHost) { $consoleArgs += @('--asr-host', $AsrHost) }
if ($Address) { $consoleArgs += @('--advertise', $Address) }
& $pythonPath @consoleArgs
exit $LASTEXITCODE
