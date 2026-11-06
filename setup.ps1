param(
    [string]$Python = 'py',
    [string]$IndexUrl = 'https://pypi.org/simple',
    [switch]$SkipModels,
    [switch]$Dev
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskTemp = Join-Path $PSScriptRoot '.downloads\tmp'
$taskPipCache = Join-Path $PSScriptRoot '.downloads\pip-cache'
New-Item -ItemType Directory -Path $taskTemp,$taskPipCache -Force | Out-Null
$savedTemp = $env:TEMP
$savedTmp = $env:TMP
$savedCache = $env:PIP_CACHE_DIR
try {
    # Keep installation artifacts on this project's drive, without deleting or
    # changing another project's caches or the user's global Python installation.
    $env:TEMP = $taskTemp
    $env:TMP = $taskTemp
    $env:PIP_CACHE_DIR = $taskPipCache
    if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
        if ($Python -eq 'py') { & $Python -3.12 -m venv .venv }
        else { & $Python -m venv .venv }
        if ($LASTEXITCODE -ne 0) { throw 'Creating Python 3.12 environment failed. Supply -Python with a working Python 3.12 executable.' }
    }
    $venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    & $venvPython -c "import sys; assert (3,11) <= sys.version_info[:2] < (3,13), 'Use Python 3.11 or 3.12'"
    if ($LASTEXITCODE -ne 0) { throw 'Python version check failed.' }
    $package = if ($Dev) { '.[dev]' } else { '.' }
    & $venvPython -m pip install --upgrade 'pip>=25.2,<27' --retries 3 --timeout 60 --index-url $IndexUrl
    if ($LASTEXITCODE -ne 0) { throw 'pip bootstrap failed.' }
    $constraints = @()
    if (Test-Path -LiteralPath 'requirements.lock.txt') { $constraints = @('-c','requirements.lock.txt') }
    & $venvPython -m pip install --resume-retries 0 --retries 3 --timeout 60 --index-url $IndexUrl @constraints -e $package
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; retry setup or choose another trusted PyPI mirror with -IndexUrl.' }
    & $venvPython -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency consistency check failed.' }
    if (-not $SkipModels) {
        & $venvPython tools/download_models.py
        if ($LASTEXITCODE -ne 0) { throw 'Model download failed; rerun tools/download_models.py to resume.' }
    }
    Write-Host 'Setup complete. Run .\pair.ps1 and .\start.ps1.'
} finally {
    $env:TEMP = $savedTemp
    $env:TMP = $savedTmp
    $env:PIP_CACHE_DIR = $savedCache
}
