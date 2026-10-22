$ErrorActionPreference = 'Stop'
$baiRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $baiRoot
$baiVersion = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
$baiTauriConfig = Get-Content src-tauri/tauri.conf.json -Raw -Encoding UTF8 | ConvertFrom-Json
$baiTauriVersion = $baiTauriConfig.version
$baiProductName = $baiTauriConfig.productName
if ($baiVersion -ne $baiTauriVersion) { throw 'Frontend and desktop versions differ.' }
& pnpm tauri build --bundles nsis --config src-tauri/tauri.release.conf.json
if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
$baiSource = Join-Path $baiRoot ".local-data\cargo-ui-review\release\bundle\nsis\${baiProductName}_${baiVersion}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $baiSource)) { throw 'Installer missing.' }
$baiDelivery = Join-Path $baiRoot "releases\$baiVersion"
New-Item -ItemType Directory -Path $baiDelivery -Force | Out-Null
$baiTarget = Join-Path $baiDelivery "${baiProductName}_${baiVersion}.exe"
if (Test-Path -LiteralPath $baiTarget) {
    $baiArchive = Join-Path $baiDelivery (Get-Date -Format 'yyyyMMdd-HHmmss')
    New-Item -ItemType Directory -Path $baiArchive | Out-Null
    Copy-Item -LiteralPath $baiTarget -Destination $baiArchive
    if ((Get-FileHash -LiteralPath $baiTarget).Hash -ne (Get-FileHash -LiteralPath (Join-Path $baiArchive (Split-Path $baiTarget -Leaf))).Hash) { throw 'Previous installer archive verification failed.' }
}
Copy-Item -LiteralPath $baiSource -Destination $baiTarget -Force
$baiHash = (Get-FileHash -LiteralPath $baiTarget -Algorithm SHA256).Hash
if ($baiHash -ne (Get-FileHash -LiteralPath $baiSource -Algorithm SHA256).Hash) { throw 'Installer copy hash mismatch.' }
[System.IO.File]::WriteAllText((Join-Path $baiDelivery 'SHA256SUMS.txt'), "$baiHash  $(Split-Path $baiTarget -Leaf)`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "Installer: $baiTarget"
Write-Output "SHA256: $baiHash"
