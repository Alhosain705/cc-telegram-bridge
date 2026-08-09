Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.Security

function Convert-ArabicDigits {
    param([AllowEmptyString()][string]$Value)

    $map = @{
        ([char]0x0660) = '0'; ([char]0x0661) = '1'; ([char]0x0662) = '2'
        ([char]0x0663) = '3'; ([char]0x0664) = '4'; ([char]0x0665) = '5'
        ([char]0x0666) = '6'; ([char]0x0667) = '7'; ([char]0x0668) = '8'
        ([char]0x0669) = '9'; ([char]0x06F0) = '0'; ([char]0x06F1) = '1'
        ([char]0x06F2) = '2'; ([char]0x06F3) = '3'; ([char]0x06F4) = '4'
        ([char]0x06F5) = '5'; ([char]0x06F6) = '6'; ([char]0x06F7) = '7'
        ([char]0x06F8) = '8'; ([char]0x06F9) = '9'
    }
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in ([string]$Value).ToCharArray()) {
        if ($map.ContainsKey($character)) {
            [void]$builder.Append($map[$character])
        }
        else {
            [void]$builder.Append($character)
        }
    }
    return $builder.ToString()
}

function Normalize-BotToken {
    param([AllowEmptyString()][string]$Value)

    $clean = Convert-ArabicDigits ([string]$Value)
    $clean = $clean.Replace([char]0x00A0, ' ')
    foreach ($codePoint in @(0x061C, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF)) {
        $clean = $clean.Replace(([char]$codePoint).ToString(), [string]::Empty)
    }
    $clean = $clean.Trim().Trim([char[]]@('"', "'", [char]0x2018, [char]0x2019, [char]0x201C, [char]0x201D))
    $urlMatch = [regex]::Match(
        $clean,
        '(?i)^(?:https?://)?api\.telegram\.org/bot(?<token>[^/?#\s]+)(?:[/?#].*)?$'
    )
    if ($urlMatch.Success) {
        $clean = $urlMatch.Groups['token'].Value
    }
    if ($clean.StartsWith('bot', [System.StringComparison]::OrdinalIgnoreCase)) {
        $clean = $clean.Substring(3)
    }
    return $clean.Trim()
}

function Test-BotTokenShape {
    param([AllowEmptyString()][string]$Value)
    return [regex]::IsMatch([string]$Value, '^\d{5,16}:[A-Za-z0-9_-]{30,}$')
}

function New-PairingCode {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 4
        $limit = [uint32]::MaxValue - ([uint32]::MaxValue % 900000)
        do {
            $rng.GetBytes($bytes)
            $number = [System.BitConverter]::ToUInt32($bytes, 0)
        } while ($number -ge $limit)
        return [string](100000 + ($number % 900000))
    }
    finally {
        $rng.Dispose()
    }
}

function Protect-CurrentUserSecret {
    param([Parameter(Mandatory = $true)][string]$Value)
    $plain = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $plain,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Convert]::ToBase64String($protected)
}

function Unprotect-CurrentUserSecret {
    param([Parameter(Mandatory = $true)][string]$Value)
    $protected = [Convert]::FromBase64String($Value)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [System.Text.Encoding]::UTF8.GetString($plain)
}

function Parse-EnvContent {
    param([AllowEmptyString()][string]$Content)

    $result = @{}
    $normalized = ([string]$Content).TrimStart([char]0xFEFF)
    foreach ($sourceLine in ($normalized -split "`r?`n")) {
        $line = $sourceLine.Trim()
        if (-not $line -or $line.StartsWith('#', [System.StringComparison]::Ordinal)) {
            continue
        }
        $match = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
        if (-not $match.Success) {
            throw "invalid_env_line:$sourceLine"
        }
        $key = $match.Groups[1].Value
        $value = $match.Groups[2].Value.Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $result[$key] = $value
    }
    return $result
}

function Format-EnvContent {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Values
    )

    $orderedKeys = @(
        'TELEGRAM_BOT_TOKEN_DPAPI',
        'TELEGRAM_OWNER_IDS',
        'TELEGRAM_BOT_USERNAME',
        'CLAUDE_WORKDIR',
        'CLAUDE_BIN',
        'CLAUDE_TIMEOUT_MINUTES',
        'CLAUDE_ALLOW_API_BILLING'
    )
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($key in $orderedKeys) {
        $value = if ($Values.ContainsKey($key)) { [string]$Values[$key] } else { '' }
        if ($value.IndexOfAny([char[]]"`r`n") -ge 0) {
            throw "invalid_env_value:$key"
        }
        $lines.Add("$key=$value")
    }
    return ($lines -join "`r`n") + "`r`n"
}

function Write-EnvFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Values
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = "$Path.$PID.tmp"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporary, (Format-EnvContent $Values), $encoding)
    if (Test-Path -LiteralPath $Path) {
        [System.IO.File]::Replace($temporary, $Path, $null)
    }
    else {
        [System.IO.File]::Move($temporary, $Path)
    }
}

function Read-EnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return Parse-EnvContent $content
}

function Initialize-BridgeState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OwnerId,
        [ValidateSet('safe', 'free')][string]$Permission = 'safe',
        [long]$UpdateOffset = 0,
        [AllowEmptyString()][string]$PairingCode = ''
    )

    $state = @{
        pairedUsers = @()
        permissions = @{}
        models = @{}
        sessions = @{}
        sessionGenerations = @{}
        updateOffset = [long]0
        processedUpdates = @()
        pairingAttempts = @{}
        restartRequest = $null
        outbox = @()
        outboxDeadLetters = @()
    }
    if (Test-Path -LiteralPath $Path) {
        try {
            if (-not (Test-BridgeStateFile -Path $Path)) {
                throw 'state_schema_rejected_by_runtime'
            }
            $loaded = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($loaded.pairedUsers) { $state.pairedUsers = @($loaded.pairedUsers | ForEach-Object { [string]$_ }) }
            if ($loaded.permissions) {
                foreach ($property in $loaded.permissions.PSObject.Properties) {
                    $state.permissions[$property.Name] = [string]$property.Value
                }
            }
            if ($loaded.models) {
                foreach ($property in $loaded.models.PSObject.Properties) {
                    $state.models[$property.Name] = [string]$property.Value
                }
            }
            if ($loaded.sessions) {
                foreach ($property in $loaded.sessions.PSObject.Properties) {
                    $state.sessions[$property.Name] = [string]$property.Value
                }
            }
            if ($loaded.sessionGenerations) {
                foreach ($property in $loaded.sessionGenerations.PSObject.Properties) {
                    $state.sessionGenerations[$property.Name] = [long]$property.Value
                }
            }
            if ($null -ne $loaded.updateOffset) { $state.updateOffset = [long]$loaded.updateOffset }
            if ($loaded.processedUpdates) { $state.processedUpdates = @($loaded.processedUpdates | ForEach-Object { [string]$_ }) }
            if ($loaded.pairingAttempts) {
                foreach ($property in $loaded.pairingAttempts.PSObject.Properties) {
                    $state.pairingAttempts[$property.Name] = @($property.Value)
                }
            }
            if ($loaded.restartRequest) {
                $state.restartRequest = $loaded.restartRequest
            }
            if ($loaded.outbox) { $state.outbox = @($loaded.outbox) }
            if ($loaded.outboxDeadLetters) { $state.outboxDeadLetters = @($loaded.outboxDeadLetters) }
        }
        catch {
            throw "invalid_state_file:$($_.Exception.Message)"
        }
    }
    if ($state.pairedUsers -notcontains [string]$OwnerId) {
        $state.pairedUsers += [string]$OwnerId
    }
    $state.permissions[[string]$OwnerId] = $Permission
    $state.updateOffset = [math]::Max([long]$state.updateOffset, $UpdateOffset)
    if ($PairingCode) {
        $state.pairing = @{
            code = $PairingCode
            expiresAt = [datetime]::UtcNow.AddMinutes(10).ToString('o')
            used = $true
            usedAt = [datetime]::UtcNow.ToString('o')
            usedBy = [string]$OwnerId
        }
    }
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = "$Path.$PID.tmp"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $json = $state | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($temporary, "$json`r`n", $encoding)
    $backup = "$Path.bak"
    if (Test-Path -LiteralPath $Path) {
        [System.IO.File]::Replace($temporary, $Path, $backup)
    }
    else {
        [System.IO.File]::Move($temporary, $Path)
        Copy-Item -LiteralPath $Path -Destination $backup -Force
    }
}

function Test-BridgeStateFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $installDir = Split-Path -Parent (Split-Path -Parent $Path)
    $portableNode = Join-Path $installDir 'runtime\node\node.exe'
    $node = if (Test-Path -LiteralPath $portableNode -PathType Leaf) {
        $portableNode
    }
    else {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($command) { $command.Source } else { $null }
    }
    $installedValidator = Join-Path $installDir 'launcher\state-validator.js'
    $validator = if (Test-Path -LiteralPath $installedValidator -PathType Leaf) {
        $installedValidator
    }
    else {
        Join-Path $PSScriptRoot 'state-validator.js'
    }
    if (-not $node -or -not (Test-Path -LiteralPath $validator -PathType Leaf)) {
        throw 'state_validator_runtime_missing'
    }
    & $node $validator $Path 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Invoke-WithClaudeEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$AllowlistPath,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    $allowedNames = Get-Content -LiteralPath $AllowlistPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $allowed = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $allowedNames) {
        [void]$allowed.Add([string]$name)
    }
    $snapshot = @{}
    Get-ChildItem Env: | ForEach-Object {
        $snapshot[$_.Name] = $_.Value
    }
    try {
        Get-ChildItem Env: | Where-Object { -not $allowed.Contains($_.Name) } | ForEach-Object {
            Remove-Item -LiteralPath "Env:$($_.Name)" -ErrorAction SilentlyContinue
        }
        return & $Action
    }
    finally {
        Get-ChildItem Env: | ForEach-Object {
            Remove-Item -LiteralPath "Env:$($_.Name)" -ErrorAction SilentlyContinue
        }
        foreach ($entry in $snapshot.GetEnumerator()) {
            Set-Item -LiteralPath "Env:$($entry.Key)" -Value ([string]$entry.Value)
        }
    }
}

function Restore-BridgeStateBackup {
    param([Parameter(Mandatory = $true)][string]$Path)

    $backup = "$Path.bak"
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
        throw 'state_backup_missing'
    }
    if (-not (Test-BridgeStateFile -Path $backup)) {
        throw 'state_backup_invalid:state_backup_schema_invalid'
    }
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = "$Path.$PID.restore.tmp"
    Copy-Item -LiteralPath $backup -Destination $temporary -Force

    $marker = "$Path.corrupt-marker"
    $clearedMarker = $null
    if (Test-Path -LiteralPath $marker) {
        $clearedMarker = "$marker.cleared-$([datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))"
        try {
            Move-Item -LiteralPath $marker -Destination $clearedMarker -ErrorAction Stop
        }
        catch {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            throw "state_corruption_marker_clear_failed:$($_.Exception.Message)"
        }
        if (Test-Path -LiteralPath $marker) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            throw 'state_corruption_marker_clear_failed:marker_still_present'
        }
    }

    try {
        if (Test-Path -LiteralPath $Path) {
            $quarantine = "$Path.corrupt-$([datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))"
            [System.IO.File]::Replace($temporary, $Path, $quarantine)
        }
        else {
            [System.IO.File]::Move($temporary, $Path)
        }
    }
    catch {
        $restoreError = $_.Exception
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        if ($clearedMarker -and
            (Test-Path -LiteralPath $clearedMarker) -and
            -not (Test-Path -LiteralPath $marker)) {
            try {
                Move-Item -LiteralPath $clearedMarker -Destination $marker -ErrorAction Stop
            }
            catch {
                throw "state_restore_failed_marker_rollback_failed:$($restoreError.Message);$($_.Exception.Message)"
            }
        }
        throw $restoreError
    }
    return $Path
}

Export-ModuleMember -Function @(
    'Convert-ArabicDigits',
    'Normalize-BotToken',
    'Test-BotTokenShape',
    'New-PairingCode',
    'Protect-CurrentUserSecret',
    'Unprotect-CurrentUserSecret',
    'Parse-EnvContent',
    'Format-EnvContent',
    'Invoke-WithClaudeEnvironment',
    'Write-EnvFile',
    'Read-EnvFile',
    'Initialize-BridgeState',
    'Test-BridgeStateFile',
    'Restore-BridgeStateBackup'
)
