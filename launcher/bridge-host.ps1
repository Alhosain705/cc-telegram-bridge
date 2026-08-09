Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $launcherDir
$nodePath = Join-Path $appDir 'runtime\node\node.exe'
$entryPath = Join-Path $appDir 'index.js'
$dataDir = Join-Path $appDir 'data'
$logsDir = Join-Path $appDir 'logs'
$pidPath = Join-Path $dataDir 'bridge.pid'
$hostPidPath = Join-Path $dataDir 'bridge-host.pid'
$lockPath = Join-Path $dataDir 'bridge-host.lock'
$stopPath = Join-Path $dataDir 'bridge.stop'
$restartPath = Join-Path $dataDir 'bridge.restart'
$stateCorruptionMarkerPath = Join-Path $dataDir 'state.json.corrupt-marker'
$readyPath = Join-Path $dataDir 'bridge.ready'
$stateCorruptionExitCode = 78
$lockStream = $null
$ownsLock = $false
$ownsPid = $false
$ownsHostPid = $false
$process = $null

function Remove-FileVerified {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$FailureCode,
        [int]$Attempts = 10,
        [int]$DelayMilliseconds = 100
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    $lastMessage = 'marker_still_present'
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        }
        catch {
            $lastMessage = $_.Exception.Message
        }
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return
        }
        if ($attempt -lt $Attempts) {
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
    throw "${FailureCode}: $lastMessage"
}

function Get-RestartMarkerPid {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $marker = ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        throw "restart_marker_read_failed: $($_.Exception.Message)"
    }
    $markerPid = [long]0
    if ($null -eq $marker.pid -or
        -not [long]::TryParse([string]$marker.pid, [ref]$markerPid) -or
        $markerPid -le 0) {
        return $null
    }
    return $markerPid
}

try {
    New-Item -ItemType Directory -Force -Path $dataDir, $logsDir | Out-Null
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $ownsLock = $true
    [System.IO.File]::WriteAllText(
        $hostPidPath,
        [string]$PID,
        (New-Object System.Text.UTF8Encoding($false))
    )
    $ownsHostPid = $true

    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw 'portable_node_missing'
    }
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        throw 'bridge_entry_missing'
    }
    Remove-FileVerified -Path $restartPath -FailureCode 'stale_restart_marker_remove_failed'

    $stdoutPath = Join-Path $logsDir 'bridge-out.log'
    $stderrPath = Join-Path $logsDir 'bridge-error.log'
    $restartTimes = New-Object System.Collections.Generic.List[datetime]
    while ($true) {
        if (Test-Path -LiteralPath $stopPath) {
            exit 0
        }
        if (Test-Path -LiteralPath $stateCorruptionMarkerPath -PathType Leaf) {
            exit $stateCorruptionExitCode
        }
        foreach ($logPath in @($stdoutPath, $stderrPath)) {
            if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
                $rotatedPath = "$logPath.1"
                if (Test-Path -LiteralPath $rotatedPath) {
                    Remove-Item -LiteralPath $rotatedPath -Force
                }
                Move-Item -LiteralPath $logPath -Destination $rotatedPath
            }
        }
        Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
        $process = Start-Process -FilePath $nodePath `
            -ArgumentList @($entryPath) `
            -WorkingDirectory $appDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -PassThru

        [System.IO.File]::WriteAllText(
            $pidPath,
            [string]$process.Id,
            (New-Object System.Text.UTF8Encoding($false))
        )
        $ownsPid = $true
        while (-not $process.WaitForExit(250)) {
            if (Test-Path -LiteralPath $stopPath) {
                $taskKill = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') `
                    -ArgumentList @('/PID', [string]$process.Id, '/T', '/F') `
                    -WindowStyle Hidden `
                    -Wait `
                    -PassThru
                if ($taskKill.ExitCode -notin @(0, 128)) {
                    throw 'bridge_child_stop_failed'
                }
                $process.WaitForExit()
                exit 0
            }
        }
        if (Test-Path -LiteralPath $stopPath) {
            exit 0
        }
        if (Test-Path -LiteralPath $stateCorruptionMarkerPath -PathType Leaf) {
            exit $stateCorruptionExitCode
        }
        if (Test-Path -LiteralPath $restartPath -PathType Leaf) {
            $restartMarkerPid = Get-RestartMarkerPid -Path $restartPath
            $restartMatchesChild = $null -ne $restartMarkerPid -and
                $restartMarkerPid -eq [long]$process.Id
            $removeFailureCode = if ($restartMatchesChild) {
                'restart_marker_consume_failed'
            }
            else {
                'stale_restart_marker_remove_failed'
            }
            Remove-FileVerified -Path $restartPath -FailureCode $removeFailureCode
            if ($restartMatchesChild) {
                continue
            }
        }
        $cutoff = [datetime]::UtcNow.AddMinutes(-5)
        @($restartTimes | Where-Object { $_ -lt $cutoff }) | ForEach-Object { [void]$restartTimes.Remove($_) }
        if ($restartTimes.Count -ge 5) {
            throw 'bridge_crash_loop_stopped'
        }
        $restartTimes.Add([datetime]::UtcNow)
        $restartDeadline = [datetime]::UtcNow.AddSeconds(
            [math]::Min(30, [math]::Pow(2, $restartTimes.Count))
        )
        while ([datetime]::UtcNow -lt $restartDeadline) {
            if (Test-Path -LiteralPath $stopPath) {
                exit 0
            }
            Start-Sleep -Milliseconds 200
        }
    }
}
catch {
    $fallbackLog = Join-Path $logsDir 'host-error.log'
    try {
        [System.IO.File]::AppendAllText(
            $fallbackLog,
            "$(Get-Date -Format o) $($_.Exception.Message)`r`n",
            (New-Object System.Text.UTF8Encoding($false))
        )
    }
    catch {
        [System.Diagnostics.Debug]::WriteLine($_.Exception.Message)
    }
    exit 1
}
finally {
    if ($ownsPid -and $ownsLock -and (Test-Path -LiteralPath $pidPath)) {
        $ownedPid = [System.IO.File]::ReadAllText($pidPath).Trim()
        if ($process -and $ownedPid -eq [string]$process.Id) {
            Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        }
    }
    if ($ownsHostPid -and (Test-Path -LiteralPath $hostPidPath)) {
        $ownedHostPid = [System.IO.File]::ReadAllText($hostPidPath).Trim()
        if ($ownedHostPid -eq [string]$PID) {
            Remove-Item -LiteralPath $hostPidPath -Force -ErrorAction SilentlyContinue
        }
    }
    if ($ownsLock -and $lockStream) {
        $lockStream.Dispose()
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}
