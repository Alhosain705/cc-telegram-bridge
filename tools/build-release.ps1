param(
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64',
    [string]$NodeVersion = '24.18.0',
    [string]$OutputDirectory = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$distDir = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    Join-Path $repoDir 'dist'
} else {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
$workDir = Join-Path $env:TEMP "cc-telegram-bridge-release-$PID"
$nodeArchiveName = "node-v$NodeVersion-win-$Architecture.zip"
$nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"
$archivePath = Join-Path $workDir $nodeArchiveName
$checksumsPath = Join-Path $workDir 'SHASUMS256.txt'
$extractDir = Join-Path $workDir 'node-extract'
$stageDir = Join-Path $workDir "cc-telegram-bridge-win-$Architecture"
$releaseName = "cc-telegram-bridge-0.1.3-win-$Architecture.zip"
$releasePath = Join-Path $distDir $releaseName
$manifestPath = Join-Path $distDir "$releaseName.sha256"
Import-Module (Join-Path $repoDir 'tools\DeterministicZip.psm1') -Force

try {
    New-Item -ItemType Directory -Force -Path $workDir, $extractDir, $stageDir, $distDir | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/$nodeArchiveName" -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/SHASUMS256.txt" -OutFile $checksumsPath

    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object {
        $_ -match "\s$([regex]::Escape($nodeArchiveName))$"
    } | Select-Object -First 1
    if (-not $checksumLine) {
        throw 'node_checksum_entry_missing'
    }
    $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($expectedHash, $actualHash, [System.StringComparison]::Ordinal)) {
        throw 'node_archive_checksum_mismatch'
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
    $nodeSource = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $nodeSource) {
        throw 'node_archive_layout_invalid'
    }

    $rootFiles = @(
        '.env.example', '.gitattributes', '.gitignore', 'CREDITS.md', 'LICENSE',
        'MANUAL.html', 'README.md', 'SECURITY.md', 'THIRD-PARTY-REVIEW.md',
        'START.cmd', 'index.js', 'package.json'
    )
    foreach ($file in $rootFiles) {
        Copy-Item -LiteralPath (Join-Path $repoDir $file) -Destination $stageDir -Force
    }
    foreach ($directory in @('src', 'launcher')) {
        Copy-Item -LiteralPath (Join-Path $repoDir $directory) -Destination $stageDir -Recurse -Force
    }

    $runtimeDir = Join-Path $stageDir 'runtime\node'
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Copy-Item -Path (Join-Path $nodeSource.FullName '*') -Destination $runtimeDir -Recurse -Force
    [System.IO.File]::WriteAllText(
        (Join-Path $stageDir 'runtime\.runtime-arch'),
        $Architecture,
        (New-Object System.Text.UTF8Encoding($false))
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $stageDir 'runtime\.runtime-version'),
        $NodeVersion,
        (New-Object System.Text.UTF8Encoding($false))
    )

    if (Test-Path -LiteralPath $releasePath) {
        Remove-Item -LiteralPath $releasePath -Force
    }
    New-DeterministicZip -SourceDirectory $stageDir -DestinationPath $releasePath
    $releaseHash = (Get-FileHash -LiteralPath $releasePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $releasePath).Length
    [System.IO.File]::WriteAllText(
        $manifestPath,
        "$releaseHash *$releaseName`r`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Output "RELEASE=$releasePath"
    Write-Output "MANIFEST=$manifestPath"
    Write-Output "SIZE_BYTES=$size"
    Write-Output "SHA256=$releaseHash"
    Write-Output "NODE_VERSION=$NodeVersion"
    Write-Output "NODE_ARCHITECTURE=$Architecture"
}
finally {
    if (Test-Path -LiteralPath $workDir) {
        Remove-Item -LiteralPath $workDir -Recurse -Force
    }
}
