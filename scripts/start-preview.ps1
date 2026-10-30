param(
    [switch]$Worker,
    [ValidatePattern('^desktop(?:-[0-9]+)*\.log$')]
    [string]$LogName
)
$ErrorActionPreference = 'Stop'
$previewRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $previewRoot
$env:BAI_DATA_DIR = if ($env:BAI_PREVIEW_DATA_DIR) { $env:BAI_PREVIEW_DATA_DIR } else { Join-Path $previewRoot '.local-data\preview-runtime' }
$env:BAI_BACKEND_PORT = '8790'
$env:BAI_BACKEND_URL = 'http://127.0.0.1:8790'
$env:BAI_FRONTEND_ORIGIN = 'http://127.0.0.1:5190'
# Keep preview binaries separate from static checks and any older running build.
# This changes only compiler output; the preview identity and data stay stable.
$env:CARGO_TARGET_DIR = Join-Path $previewRoot '.local-data\cargo-preview'
New-Item -ItemType Directory -Path $env:BAI_DATA_DIR -Force | Out-Null
$previewLogName = if ($LogName) { $LogName } else { 'desktop-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '.log' }
$previewLog = Join-Path $env:BAI_DATA_DIR $previewLogName
$previewExecutable = Join-Path $env:CARGO_TARGET_DIR 'debug\bai-agent.exe'
if ($Worker) {
    Set-Content -LiteralPath (Join-Path $env:BAI_DATA_DIR 'latest-preview-log.txt') -Value $previewLogName -Encoding UTF8
    $previewPnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $previewCommandLine = '""{0}" desktop:preview > "{1}" 2>&1"' -f $previewPnpm, $previewLog
    & $env:ComSpec /d /s /c $previewCommandLine
    exit $LASTEXITCODE
}
$previewRunning = Get-Process -Name 'bai-agent' -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $previewExecutable
}
if ($previewRunning) {
    # This is the interactive app: let its single-instance handler restore it.
    # Hidden applies a startup window state which can minimize the existing window.
    Start-Process -FilePath $previewExecutable -WindowStyle Normal
    exit 0
}
foreach ($previewCommand in @('pnpm.cmd', 'cargo', 'node')) {
    if (-not (Get-Command $previewCommand -ErrorAction SilentlyContinue)) { throw "Missing command: $previewCommand" }
}
if (-not (Test-Path -LiteralPath (Join-Path $previewRoot 'backend\.venv\Scripts\python.exe'))) {
    throw 'Backend environment missing. Run uv sync --project backend --frozen first.'
}
$previewPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$previewScript = Join-Path $PSScriptRoot 'start-preview.ps1'
$previewWorker = Start-Process -FilePath $previewPowerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $previewScript + '"'), '-Worker', '-LogName', $previewLogName) -WorkingDirectory $previewRoot -WindowStyle Hidden -PassThru
$previewDeadline = [DateTime]::UtcNow.AddMinutes(10)
while ([DateTime]::UtcNow -lt $previewDeadline) {
    $previewWindow = Get-Process -Name 'bai-agent' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $previewExecutable -and $_.MainWindowHandle -ne 0
    }
    if ($previewWindow) { exit 0 }
    $previewWorker.Refresh()
    if ($previewWorker.HasExited) {
        if (Test-Path -LiteralPath $previewLog) { Get-Content -LiteralPath $previewLog -Tail 25 | Write-Host }
        throw "Preview failed to start. See $previewLog"
    }
    Start-Sleep -Milliseconds 400
}
throw "Preview window did not open. See $previewLog"
