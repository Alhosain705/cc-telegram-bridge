Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-BridgeLifecyclePaths {
    param([Parameter(Mandatory = $true)][string]$InstallDir)

    $dataDir = Join-Path $InstallDir 'data'
    return [pscustomobject]@{
        DataDir = $dataDir
        ChildPid = Join-Path $dataDir 'bridge.pid'
        HostPid = Join-Path $dataDir 'bridge-host.pid'
        Lock = Join-Path $dataDir 'bridge-host.lock'
        Stop = Join-Path $dataDir 'bridge.stop'
        Restart = Join-Path $dataDir 'bridge.restart'
        Ready = Join-Path $dataDir 'bridge.ready'
        Node = Join-Path $InstallDir 'runtime\node\node.exe'
        HostScript = Join-Path $InstallDir 'launcher\bridge-host.ps1'
    }
}

function Get-BridgeInstallTransactionPaths {
    param([Parameter(Mandatory = $true)][string]$InstallDir)

    return [pscustomobject]@{
        Journal = "$InstallDir.install-journal.json"
        Backup = "$InstallDir.rollback"
    }
}

function Write-BridgeInstallJournal {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$State
    )

    $temporary = "$Path.$PID.tmp"
    $State.updatedAt = [datetime]::UtcNow.ToString('o')
    [System.IO.File]::WriteAllText(
        $temporary,
        (($State | ConvertTo-Json -Depth 5) + "`r`n"),
        (New-Object System.Text.UTF8Encoding($false))
    )
    if (Test-Path -LiteralPath $Path) {
        $previous = "$Path.previous"
        [System.IO.File]::Replace($temporary, $Path, $previous)
        Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
    }
    else {
        [System.IO.File]::Move($temporary, $Path)
    }
}

function Enter-BridgeLauncherLock {
    param([string]$Name = 'Local\CC-Telegram-Bridge-Launcher')

    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($false, $Name, [ref]$createdNew)
    try {
        $acquired = $mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) {
        $mutex.Dispose()
        return $null
    }
    return (, $mutex)
}

function Test-BridgeProcessPath {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return $false
    }
    try {
        $actual = [System.IO.Path]::GetFullPath($process.Path)
        $expected = [System.IO.Path]::GetFullPath($ExpectedPath)
        return [string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

function Test-BridgeHostProcess {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedScript
    )

    try {
        $record = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if (-not $record) {
            return $false
        }
        $commandLine = [string]$record.CommandLine
        $script = [System.IO.Path]::GetFullPath($ExpectedScript)
        return $commandLine.IndexOf($script, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    catch {
        return $false
    }
}

function Test-BridgeLockReleased {
    param([Parameter(Mandatory = $true)][string]$LockPath)

    if (-not (Test-Path -LiteralPath $LockPath)) {
        return $true
    }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $LockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        return $true
    }
    catch [System.IO.IOException] {
        return $false
    }
    finally {
        if ($stream) {
            $stream.Dispose()
        }
    }
}

function Get-PidFromFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $value = [System.IO.File]::ReadAllText($Path).Trim()
        if ($value -match '^\d+$') {
            return [int]$value
        }
    }
    catch {
        return $null
    }
    return $null
}

function Wait-BridgeStopped {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [int]$TimeoutSeconds = 20
    )

    $paths = Get-BridgeLifecyclePaths $InstallDir
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $hostPid = Get-PidFromFile $paths.HostPid
        $childPid = Get-PidFromFile $paths.ChildPid
        $hostAlive = $hostPid -and
            (Test-BridgeHostProcess -ProcessId $hostPid -ExpectedScript $paths.HostScript)
        $childAlive = $childPid -and
            (Test-BridgeProcessPath -ProcessId $childPid -ExpectedPath $paths.Node)
        if ($hostPid -and -not $hostAlive) {
            Remove-Item -LiteralPath $paths.HostPid -Force -ErrorAction SilentlyContinue
        }
        if ($childPid -and -not $childAlive) {
            Remove-Item -LiteralPath $paths.ChildPid -Force -ErrorAction SilentlyContinue
        }
        if (-not $hostAlive -and -not $childAlive -and (Test-BridgeLockReleased $paths.Lock)) {
            Remove-Item -LiteralPath $paths.HostPid, $paths.ChildPid -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $paths.Ready -Force -ErrorAction SilentlyContinue
            return $true
        }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    return $false
}

function Stop-BridgeInstance {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [int]$TimeoutSeconds = 20
    )

    $paths = Get-BridgeLifecyclePaths $InstallDir
    New-Item -ItemType Directory -Force -Path $paths.DataDir | Out-Null
    [System.IO.File]::WriteAllText(
        $paths.Stop,
        [datetime]::UtcNow.ToString('o'),
        (New-Object System.Text.UTF8Encoding($false))
    )

    if (Wait-BridgeStopped -InstallDir $InstallDir -TimeoutSeconds $TimeoutSeconds) {
        return $true
    }

    $childPid = Get-PidFromFile $paths.ChildPid
    if ($childPid -and (Test-BridgeProcessPath -ProcessId $childPid -ExpectedPath $paths.Node)) {
        $killer = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') `
            -ArgumentList @('/PID', [string]$childPid, '/T', '/F') `
            -WindowStyle Hidden `
            -Wait `
            -PassThru
        if ($killer.ExitCode -notin @(0, 128)) {
            throw 'bridge_child_stop_failed'
        }
    }

    $hostPid = Get-PidFromFile $paths.HostPid
    if ($hostPid -and (Test-BridgeHostProcess -ProcessId $hostPid -ExpectedScript $paths.HostScript)) {
        Stop-Process -Id $hostPid -Force -ErrorAction Stop
    }

    if (-not (Wait-BridgeStopped -InstallDir $InstallDir -TimeoutSeconds 5)) {
        throw 'bridge_stop_timeout'
    }
    return $true
}

function Copy-BridgeStateSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [Parameter(Mandatory = $true)][string]$StageDir
    )

    $sourceData = Join-Path $InstallDir 'data'
    if (-not (Test-Path -LiteralPath $sourceData -PathType Container)) {
        return
    }
    $paths = Get-BridgeLifecyclePaths $InstallDir
    if (-not (Test-BridgeLockReleased $paths.Lock)) {
        throw 'bridge_lock_not_released_before_snapshot'
    }

    $snapshot = Join-Path $StageDir "data.snapshot-$PID"
    $destination = Join-Path $StageDir 'data'
    if (Test-Path -LiteralPath $snapshot) {
        Remove-Item -LiteralPath $snapshot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $snapshot | Out-Null
    $excluded = @(
        'bridge.pid', 'bridge-host.pid', 'bridge-host.lock',
        'bridge.stop', 'bridge.restart', 'bridge.ready'
    )
    Get-ChildItem -LiteralPath $sourceData -Force | Where-Object {
        $excluded -notcontains $_.Name
    } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $snapshot -Recurse -Force
    }
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    Move-Item -LiteralPath $snapshot -Destination $destination
}

function Invoke-BridgeInstallSwap {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [Parameter(Mandatory = $true)][string]$StageDir,
        [switch]$FailAfterOldMove
    )

    $transactionPaths = Get-BridgeInstallTransactionPaths $InstallDir
    $BackupDir = $transactionPaths.Backup
    if (-not (Test-Path -LiteralPath $StageDir -PathType Container)) {
        throw 'install_stage_missing'
    }
    $installFullPath = [System.IO.Path]::GetFullPath($InstallDir)
    $stageFullPath = [System.IO.Path]::GetFullPath($StageDir)
    if (-not $stageFullPath.StartsWith("$installFullPath.stage-",
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'install_stage_path_invalid'
    }
    if ((Test-Path -LiteralPath $BackupDir) -or
        (Test-Path -LiteralPath $transactionPaths.Journal)) {
        throw 'install_transaction_pending_recovery'
    }

    $hadExistingInstall = Test-Path -LiteralPath $InstallDir -PathType Container
    $journal = @{
        version = 1
        phase = 'prepared'
        installDir = $installFullPath
        stageDir = $stageFullPath
        backupDir = [System.IO.Path]::GetFullPath($BackupDir)
        hadExistingInstall = [bool]$hadExistingInstall
    }
    Write-BridgeInstallJournal -Path $transactionPaths.Journal -State $journal
    try {
        if ($hadExistingInstall) {
            Stop-BridgeInstance -InstallDir $InstallDir | Out-Null
            Copy-BridgeStateSnapshot -InstallDir $InstallDir -StageDir $StageDir
            $journal.phase = 'before_old_move'
            Write-BridgeInstallJournal -Path $transactionPaths.Journal -State $journal
            Move-Item -LiteralPath $InstallDir -Destination $BackupDir
            $journal.phase = 'old_moved'
            Write-BridgeInstallJournal -Path $transactionPaths.Journal -State $journal
            if ($FailAfterOldMove) {
                throw 'synthetic_activation_failure'
            }
        }
        $journal.phase = 'before_new_activation'
        Write-BridgeInstallJournal -Path $transactionPaths.Journal -State $journal
        Move-Item -LiteralPath $StageDir -Destination $InstallDir
        $journal.phase = 'new_activated'
        Write-BridgeInstallJournal -Path $transactionPaths.Journal -State $journal
        return [pscustomobject]@{
            HadExistingInstall = $hadExistingInstall
            OldInstallMoved = $hadExistingInstall
            NewInstallActivated = $true
            JournalPath = $transactionPaths.Journal
            BackupDir = $BackupDir
        }
    }
    catch {
        $failure = $_
        Restore-BridgeInstallTransaction -InstallDir $InstallDir | Out-Null
        throw $failure
    }
}

function Restore-BridgeInstallTransaction {
    param([Parameter(Mandatory = $true)][string]$InstallDir)

    $paths = Get-BridgeInstallTransactionPaths $InstallDir
    $journal = $null
    if (Test-Path -LiteralPath $paths.Journal -PathType Leaf) {
        try {
            $journal = Get-Content -LiteralPath $paths.Journal -Raw -Encoding UTF8 | ConvertFrom-Json
        }
        catch {
            if ((Test-Path -LiteralPath $paths.Backup -PathType Container) -and
                -not (Test-Path -LiteralPath $InstallDir)) {
                Move-Item -LiteralPath $paths.Backup -Destination $InstallDir
                Remove-Item -LiteralPath $paths.Journal -Force -ErrorAction SilentlyContinue
                return $true
            }
            throw 'install_journal_invalid'
        }
    }
    $backupDir = if ($journal -and $journal.backupDir) {
        [string]$journal.backupDir
    }
    else {
        $paths.Backup
    }
    $stageDir = if ($journal -and $journal.stageDir) {
        [string]$journal.stageDir
    }
    else {
        $null
    }
    $hadExistingInstall = [bool]($journal -and $journal.hadExistingInstall)
    if (-not $journal -and -not (Test-Path -LiteralPath $backupDir)) {
        return $false
    }
    if ($journal) {
        $expectedInstall = [System.IO.Path]::GetFullPath($InstallDir)
        $expectedBackup = [System.IO.Path]::GetFullPath($paths.Backup)
        $journalInstall = [System.IO.Path]::GetFullPath([string]$journal.installDir)
        $journalBackup = [System.IO.Path]::GetFullPath($backupDir)
        $journalStage = [System.IO.Path]::GetFullPath($stageDir)
        if (-not [string]::Equals($expectedInstall, $journalInstall,
                [System.StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($expectedBackup, $journalBackup,
                [System.StringComparison]::OrdinalIgnoreCase) -or
            -not $journalStage.StartsWith("$expectedInstall.stage-",
                [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'install_journal_paths_invalid'
        }
    }

    if (Test-Path -LiteralPath $backupDir -PathType Container) {
        if (Test-Path -LiteralPath $InstallDir) {
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
        }
        Move-Item -LiteralPath $backupDir -Destination $InstallDir
    }
    elseif ($journal -and -not $hadExistingInstall -and
        (Test-Path -LiteralPath $InstallDir)) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
    }
    if ($stageDir -and (Test-Path -LiteralPath $stageDir)) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force
    }
    Remove-Item -LiteralPath $paths.Journal -Force -ErrorAction SilentlyContinue
    return $true
}

function Complete-BridgeInstallTransaction {
    param([Parameter(Mandatory = $true)][string]$InstallDir)

    $paths = Get-BridgeInstallTransactionPaths $InstallDir
    if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
        throw 'install_commit_missing_active_install'
    }
    if (Test-Path -LiteralPath $paths.Backup) {
        Remove-Item -LiteralPath $paths.Backup -Recurse -Force
    }
    Remove-Item -LiteralPath $paths.Journal -Force -ErrorAction SilentlyContinue
}

function Test-BridgeReady {
    param([Parameter(Mandatory = $true)][string]$InstallDir)

    $paths = Get-BridgeLifecyclePaths $InstallDir
    $childPid = Get-PidFromFile $paths.ChildPid
    $hostPid = Get-PidFromFile $paths.HostPid
    if (-not $childPid -or -not $hostPid -or
        -not (Test-BridgeProcessPath -ProcessId $childPid -ExpectedPath $paths.Node) -or
        -not (Test-BridgeHostProcess -ProcessId $hostPid -ExpectedScript $paths.HostScript) -or
        -not (Test-Path -LiteralPath $paths.Ready -PathType Leaf)) {
        return $false
    }
    try {
        $ready = Get-Content -LiteralPath $paths.Ready -Raw -Encoding UTF8 | ConvertFrom-Json
        return [int]$ready.pid -eq $childPid
    }
    catch {
        return $false
    }
}

function Uninstall-BridgeInstance {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [Parameter(Mandatory = $true)][string]$StartupShortcutPath
    )

    Stop-BridgeInstance -InstallDir $InstallDir | Out-Null
    if (Test-Path -LiteralPath $StartupShortcutPath) {
        Remove-Item -LiteralPath $StartupShortcutPath -Force
    }
}

Export-ModuleMember -Function @(
    'Complete-BridgeInstallTransaction',
    'Copy-BridgeStateSnapshot',
    'Enter-BridgeLauncherLock',
    'Get-BridgeLifecyclePaths',
    'Get-BridgeInstallTransactionPaths',
    'Invoke-BridgeInstallSwap',
    'Restore-BridgeInstallTransaction',
    'Stop-BridgeInstance',
    'Test-BridgeLockReleased',
    'Test-BridgeReady',
    'Uninstall-BridgeInstance',
    'Wait-BridgeStopped'
)
