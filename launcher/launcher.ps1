param(
    [string]$UiSmokeTestPath = '',
    [string]$InstallSmokeTestPath = '',
    [switch]$StateRestoreSmokeTest,
    [switch]$PreflightSmokeTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceDir = Split-Path -Parent $launcherDir
$coreModule = Join-Path $launcherDir 'Launcher.Core.psm1'
$lifecycleModule = Join-Path $launcherDir 'Bridge.Lifecycle.psm1'
Import-Module $coreModule -Force -DisableNameChecking
Import-Module $lifecycleModule -Force -DisableNameChecking

$installDir = Join-Path $env:LOCALAPPDATA 'cc-telegram-bridge'
$installedEnvPath = Join-Path $installDir '.env'
$installedStatePath = Join-Path $installDir 'data\state.json'
$installedPidPath = Join-Path $installDir 'data\bridge.pid'
$installedStopPath = Join-Path $installDir 'data\bridge.stop'
$pairingStatePath = Join-Path $env:LOCALAPPDATA 'cc-telegram-bridge-pairing.json'
$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'CC Telegram Bridge.lnk'
$portableNodePath = Join-Path $sourceDir 'runtime\node\node.exe'
$pairTimer = New-Object System.Windows.Forms.Timer
$pairTimer.Interval = 1500
$script:PairCode = ''
$script:PairDeadline = [datetime]::MinValue
$script:PairAttempts = 0
$script:PairOffset = 0
$script:ValidatedToken = ''
$script:BotUsername = ''
$script:LauncherMutex = $null

function Write-PairingState {
    param([Parameter(Mandatory = $true)][hashtable]$State)
    $temporary = "$pairingStatePath.$PID.tmp"
    $json = $State | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText(
        $temporary,
        "$json`r`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    if (Test-Path -LiteralPath $pairingStatePath) {
        [System.IO.File]::Replace($temporary, $pairingStatePath, $null)
    }
    else {
        [System.IO.File]::Move($temporary, $pairingStatePath)
    }
    & (Join-Path $env:WINDIR 'System32\icacls.exe') $pairingStatePath /inheritance:r /grant:r "${env:USERNAME}:(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'pairing_state_acl_failed' }
}

function Read-PairingState {
    if (-not (Test-Path -LiteralPath $pairingStatePath -PathType Leaf)) {
        throw 'pairing_state_missing'
    }
    return [System.IO.File]::ReadAllText($pairingStatePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Show-ArabicError {
    param(
        [string]$Problem,
        [string]$Solution
    )
    [System.Windows.Forms.MessageBox]::Show(
        "$Problem`r`n`r`nالحل: $Solution",
        'تعذّر إكمال الخطوة',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button1,
        [System.Windows.Forms.MessageBoxOptions]::RtlReading
    ) | Out-Null
}

function Show-ArabicInfo {
    param(
        [string]$Title,
        [string]$Message
    )
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        $Title,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button1,
        [System.Windows.Forms.MessageBoxOptions]::RtlReading
    ) | Out-Null
}

$script:LauncherMutex = Enter-BridgeLauncherLock
if (-not $script:LauncherMutex) {
    Show-ArabicInfo 'الإعداد مفتوح' 'فيه نافذة إعداد ثانية شغّالة الآن. اقفلها أول ثم افتح START.cmd من جديد.'
    exit 0
}
try {
    [void](Restore-BridgeInstallTransaction -InstallDir $installDir)
}
catch {
    Show-ArabicError 'تعذّر إكمال استعادة تحديث سابق.' 'لا تحذف مجلد التثبيت أو ملف install-journal. اضغط «تشخيص» بعد إغلاق هذه الرسالة.'
    exit 1
}

function Set-UiStatus {
    param(
        [string]$Message,
        [System.Drawing.Color]$Color = [System.Drawing.Color]::FromArgb(45, 55, 72)
    )
    $statusLabel.ForeColor = $Color
    $statusLabel.Text = $Message
    [System.Windows.Forms.Application]::DoEvents()
}

function Get-OsArchitectureName {
    try {
        $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {
        $architecture = [string]$env:PROCESSOR_ARCHITECTURE
    }
    if ($architecture -match 'ARM64') { return 'arm64' }
    if ($architecture -match 'X64|AMD64') { return 'x64' }
    return $architecture.ToLowerInvariant()
}

function Test-InternetConnection {
    try {
        $request = [System.Net.WebRequest]::Create('https://api.telegram.org')
        $request.Method = 'HEAD'
        $request.Timeout = 8000
        $response = $request.GetResponse()
        $response.Close()
        return $true
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $_.Exception.Response.Close()
            return $true
        }
        return $false
    }
}

function Invoke-Preflight {
    $errors = New-Object System.Collections.Generic.List[string]
    $warnings = New-Object System.Collections.Generic.List[string]

    $version = [Environment]::OSVersion.Version
    if ($version.Major -lt 10) {
        $errors.Add('هذا الإصدار يحتاج ويندوز 10 أو 11.')
    }
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
        $errors.Add('سياسة الجهاز تمنع نافذة الإعداد (PowerShell ConstrainedLanguage).')
    }
    foreach ($scope in @('MachinePolicy', 'UserPolicy')) {
        $policy = Get-ExecutionPolicy -Scope $scope
        if ($policy -in @('AllSigned', 'Restricted')) {
            $errors.Add("سياسة PowerShell المفروضة على الجهاز ($scope = $policy) تمنع تشغيل الحزمة.")
        }
    }

    $architecture = Get-OsArchitectureName
    $markerPath = Join-Path $sourceDir 'runtime\.runtime-arch'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        $errors.Add('بيئة Node المحمولة غير موجودة داخل الحزمة. نزّل حزمة الإصدار الكاملة، وليس ملفات المصدر.')
    }
    else {
        $packageArchitecture = [System.IO.File]::ReadAllText($markerPath).Trim().ToLowerInvariant()
        if (-not [string]::Equals($architecture, $packageArchitecture, [System.StringComparison]::Ordinal)) {
            $errors.Add("هذه الحزمة لمعمارية $packageArchitecture، لكن جهازك $architecture. نزّل الحزمة المطابقة.")
        }
    }
    if (-not (Test-Path -LiteralPath $portableNodePath -PathType Leaf)) {
        $errors.Add('ملف Node المحمول ناقص من الحزمة. أعد تنزيل الملف المضغوط وافتحه من جديد.')
    }
    else {
        try {
            $nodeVersion = (& $portableNodePath --version 2>$null)
            if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
                $errors.Add('بيئة Node المحمولة موجودة لكنها لا تعمل على هذا الجهاز.')
            }
            elseif ([int]$Matches[1] -lt 20 -or ([int]$Matches[1] -eq 20 -and [int]$Matches[2] -lt 12)) {
                $errors.Add("إصدار Node داخل الحزمة قديم ($nodeVersion).")
            }
        }
        catch {
            $errors.Add('تعذّر تشغيل Node المحمول. قد يكون Smart App Control أو برنامج الحماية قد منعه.')
        }
    }

    $localDrive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($env:LOCALAPPDATA).Substring(0, 1))
    if ($localDrive.Free -lt 500MB) {
        $errors.Add('المساحة الحرة أقل من 500 ميجابايت. فرّغ مساحة ثم أعد المحاولة.')
    }
    if (-not (Test-InternetConnection)) {
        $errors.Add('لا يوجد اتصال بالإنترنت. اتصل بالشبكة ثم أعد المحاولة.')
    }

    $smartAppStatePath = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
    try {
        $smartAppState = (Get-ItemProperty -LiteralPath $smartAppStatePath -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState
        if ($smartAppState -eq 1) {
            $warnings.Add('Smart App Control ظاهر بوضع مفروض؛ قد يمنع ملفات PowerShell. لن نطلب منك تعطيله.')
        }
    }
    catch {
        [System.Diagnostics.Debug]::WriteLine($_.Exception.Message)
    }

    return [pscustomobject]@{
        Errors = $errors
        Warnings = $warnings
    }
}

function Get-TelegramErrorMessage {
    param([System.Management.Automation.ErrorRecord]$Record)

    $statusCode = 0
    try {
        $statusCode = [int]$Record.Exception.Response.StatusCode
    }
    catch {
        [System.Diagnostics.Debug]::WriteLine($_.Exception.Message)
    }
    $body = [string]$Record.ErrorDetails.Message
    if ($statusCode -eq 401) {
        return 'رمز البوت غير صحيح أو ألغاه بوت فاذر. انسخ رمزاً جديداً والصقه كاملاً.'
    }
    if ($statusCode -eq 404) {
        return 'رمز البوت فيه غالباً رابط كامل أو حرف مخفي من النسخ. انسخ الرمز نفسه من بوت فاذر، وليس رابط API.'
    }
    if ($statusCode -eq 429) {
        return 'تيليجرام طلب الانتظار بسبب كثرة المحاولات. انتظر دقيقة ثم جرّب.'
    }
    if ($body -match 'Unauthorized') {
        return 'رمز البوت مرفوض من تيليجرام. أنشئ رمزاً جديداً من بوت فاذر.'
    }
    return 'ما قدرت أوصل إلى تيليجرام. تأكد من الإنترنت وأن الشبكة ما تحجب Telegram API ثم أعد المحاولة.'
}

function Invoke-TelegramGet {
    param(
        [string]$Token,
        [string]$Method,
        [hashtable]$Query = @{},
        [int]$TimeoutSec = 10
    )

    $builder = New-Object System.UriBuilder("https://api.telegram.org/bot$Token/$Method")
    if ($Query.Count) {
        $pairs = foreach ($key in $Query.Keys) {
            '{0}={1}' -f [uri]::EscapeDataString([string]$key), [uri]::EscapeDataString([string]$Query[$key])
        }
        $builder.Query = $pairs -join '&'
    }
    return Invoke-RestMethod -UseBasicParsing -Method Get -Uri $builder.Uri.AbsoluteUri -TimeoutSec $TimeoutSec
}

function Invoke-TelegramPost {
    param(
        [string]$Token,
        [string]$Method,
        [hashtable]$Body
    )
    return Invoke-RestMethod -UseBasicParsing -Method Post `
        -Uri "https://api.telegram.org/bot$Token/$Method" `
        -Body $Body `
        -TimeoutSec 10
}

function Stop-InstalledBridge {
    Stop-BridgeInstance -InstallDir $installDir | Out-Null
}

function Copy-DirectoryContents {
    param(
        [string]$Source,
        [string]$Destination
    )
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Install-ApplicationFiles {
    param(
        [string]$SourceRoot = $sourceDir,
        [string]$DestinationRoot = $installDir
    )
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    $rootFiles = @(
        '.env.example', '.gitattributes', '.gitignore', 'CREDITS.md', 'LICENSE',
        'README.md', 'SECURITY.md', 'THIRD-PARTY-REVIEW.md', 'START.cmd',
        'index.js', 'package.json'
    )
    foreach ($file in $rootFiles) {
        Copy-Item -LiteralPath (Join-Path $SourceRoot $file) -Destination $DestinationRoot -Force
    }
    foreach ($directory in @('src', 'launcher', 'runtime')) {
        Copy-DirectoryContents -Source (Join-Path $SourceRoot $directory) -Destination (Join-Path $DestinationRoot $directory)
    }
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $DestinationRoot 'data'), `
        (Join-Path $DestinationRoot 'logs'), `
        (Join-Path $DestinationRoot 'workspace') | Out-Null
    Get-ChildItem -LiteralPath $DestinationRoot -Recurse -File -ErrorAction Stop | Unblock-File -ErrorAction Stop
}

function Register-StartupShortcut {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupShortcutPath)
    $shortcut.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
    $shortcut.Arguments = '"' + (Join-Path $installDir 'launcher\start-bridge.vbs') + '"'
    $shortcut.WorkingDirectory = $installDir
    $shortcut.Description = 'CC Telegram Bridge'
    $shortcut.Save()
    if (-not (Test-Path -LiteralPath $startupShortcutPath -PathType Leaf)) {
        throw 'startup_shortcut_not_created'
    }
}

function Start-InstalledBridge {
    $vbsPath = Join-Path $installDir 'launcher\start-bridge.vbs'
    Remove-Item -LiteralPath $installedStopPath -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
        -ArgumentList @("""$vbsPath""") `
        -WindowStyle Hidden | Out-Null
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    $stableSince = $null
    do {
        Start-Sleep -Milliseconds 500
        if (Test-BridgeReady -InstallDir $installDir) {
            if (-not $stableSince) {
                $stableSince = [datetime]::UtcNow
            }
            elseif (([datetime]::UtcNow - $stableSince).TotalSeconds -ge 2) {
                return $true
            }
        }
        else {
            $stableSince = $null
        }
    } while ([datetime]::UtcNow -lt $deadline)
    return $false
}

function Get-ClaudeSpec {
    param(
        [string]$RootDir,
        [AllowEmptyString()][string]$PreferredPath = ''
    )

    $nodePath = Join-Path $RootDir 'runtime\node\node.exe'
    $resolverPath = Join-Path $RootDir 'launcher\claude-path.js'
    if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $resolverPath)) {
        return $null
    }
    $arguments = @($resolverPath)
    if ($PreferredPath) {
        $arguments += $PreferredPath
    }
    $output = & $nodePath $arguments 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) {
        return $null
    }
    try {
        return ($output -join '') | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Invoke-ClaudeCommand {
    param(
        [pscustomobject]$Spec,
        [string[]]$Arguments
    )
    $allArguments = @()
    if ($Spec.prefixArgs) { $allArguments += @($Spec.prefixArgs) }
    $allArguments += $Arguments
    $policyPath = Join-Path $(if (Test-Path -LiteralPath $installDir) { $installDir } else { $sourceDir }) 'launcher\claude-env-allowlist.json'
    return Invoke-WithClaudeEnvironment -AllowlistPath $policyPath -Action {
        $output = & ([string]$Spec.command) $allArguments 2>&1
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = ($output -join "`r`n")
        }
    }
}

function Start-ClaudeVisible {
    param(
        [pscustomobject]$Spec,
        [string[]]$Arguments
    )
    $allArguments = @()
    if ($Spec.prefixArgs) { $allArguments += @($Spec.prefixArgs) }
    $allArguments += $Arguments
    $quoted = foreach ($argument in $allArguments) {
        '"' + ([string]$argument).Replace('"', '\"') + '"'
    }
    $policyPath = Join-Path $(if (Test-Path -LiteralPath $installDir) { $installDir } else { $sourceDir }) 'launcher\claude-env-allowlist.json'
    $process = Invoke-WithClaudeEnvironment -AllowlistPath $policyPath -Action {
        Start-Process -FilePath ([string]$Spec.command) `
            -ArgumentList ($quoted -join ' ') `
            -WorkingDirectory $installDir `
            -Wait `
            -PassThru
    }
    return $process.ExitCode
}

function Ensure-ClaudeReady {
    Set-UiStatus 'أتأكد من وجود كلود كود وتسجيل الدخول…'
    $spec = Get-ClaudeSpec $installDir
    if (-not $spec) {
        $answer = [System.Windows.Forms.MessageBox]::Show(
            "كلود كود غير مثبت.`r`n`r`nإذا وافقت، بننزّل وننفّذ مثبّت أنثروبك الرسمي من:`r`nhttps://claude.ai/install.ps1`r`n`r`nالتنصيب الأصلي يحدّث كلود كود تلقائياً في الخلفية عشان تصلك إصلاحات الأمان والميزات. الجسر نفسه ما يحدّث نفسه ولا يسحب كوداً.",
            'تثبيت كلود كود',
            [System.Windows.Forms.MessageBoxButtons]::OKCancel,
            [System.Windows.Forms.MessageBoxIcon]::Information,
            [System.Windows.Forms.MessageBoxDefaultButton]::Button1,
            [System.Windows.Forms.MessageBoxOptions]::RtlReading
        )
        if ($answer -ne [System.Windows.Forms.DialogResult]::OK) {
            throw 'claude_install_cancelled'
        }
        $script:ClaudeInstallAttempted = $true
        $installCommand = '$ProgressPreference=''SilentlyContinue''; Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression'
        $installer = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $installCommand) `
            -Wait `
            -PassThru
        if ($installer.ExitCode -ne 0) {
            throw 'claude_install_failed_manual'
        }
        $nativeClaudePath = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
        $spec = Get-ClaudeSpec -RootDir $installDir -PreferredPath $nativeClaudePath
        if (-not $spec) {
            throw 'claude_not_found_after_install'
        }
    }

    $status = Invoke-ClaudeCommand -Spec $spec -Arguments @('auth', 'status')
    if ($status.ExitCode -ne 0) {
        Show-ArabicInfo 'تسجيل الدخول' 'بتفتح نافذة كلود كود الآن. كمّل تسجيل الدخول في المتصفح، وبعدها النافذة تقفل ونكمل تلقائياً.'
        [void](Start-ClaudeVisible -Spec $spec -Arguments @('auth', 'login'))
        $status = Invoke-ClaudeCommand -Spec $spec -Arguments @('auth', 'status')
        if ($status.ExitCode -ne 0) {
            throw 'claude_authentication_incomplete'
        }
    }
    return $spec
}

function Get-SelectedPermission {
    if ($freeRadio.Checked) { return 'free' }
    return 'safe'
}

function Complete-Setup {
    param(
        [string]$OwnerId
    )
    $stageDir = "$installDir.stage-$PID"
    $hadExistingInstall = Test-Path -LiteralPath $installDir
    $hadStartupShortcut = Test-Path -LiteralPath $startupShortcutPath
    $script:ClaudeInstallAttempted = $false
    try {
        Set-UiStatus 'أنقل الملفات إلى مكانها الدائم…'
        if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
        Install-ApplicationFiles -SourceRoot $sourceDir -DestinationRoot $stageDir
        [void](Invoke-BridgeInstallSwap -InstallDir $installDir -StageDir $stageDir)
        $claudeSpec = Ensure-ClaudeReady

        $permission = Get-SelectedPermission
        $envValues = @{
            TELEGRAM_BOT_TOKEN_DPAPI = Protect-CurrentUserSecret $script:ValidatedToken
            TELEGRAM_OWNER_IDS = $OwnerId
            TELEGRAM_BOT_USERNAME = $script:BotUsername
            CLAUDE_WORKDIR = 'workspace'
            CLAUDE_BIN = [string]$claudeSpec.source
            CLAUDE_TIMEOUT_MINUTES = '45'
            CLAUDE_ALLOW_API_BILLING = '0'
        }
        Write-EnvFile -Path $installedEnvPath -Values $envValues
        & (Join-Path $env:WINDIR 'System32\icacls.exe') $installedEnvPath /inheritance:r /grant:r "${env:USERNAME}:(M)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'config_acl_failed' }
        Initialize-BridgeState -Path $installedStatePath -OwnerId $OwnerId -Permission $permission `
            -UpdateOffset $script:PairOffset -PairingCode $script:PairCode
        Remove-Item -LiteralPath $pairingStatePath -Force -ErrorAction SilentlyContinue

        Set-UiStatus 'أسجّل التشغيل التلقائي عند تسجيل الدخول…'
        Register-StartupShortcut
        if (-not (Start-InstalledBridge)) {
            throw 'bridge_did_not_start'
        }

        $permissionText = if ($permission -eq 'free') { 'العمل بحرية' } else { 'الوضع الآمن' }
        $readyText = "✅ جاهز! الربط شغّال على جهازك الآن.`n🔐 الصلاحيات: $permissionText.`n💡 أرسل أي رسالة لهذا البوت عشان تبدأ."
        $readyResult = Invoke-TelegramPost -Token $script:ValidatedToken -Method 'sendMessage' -Body @{
            chat_id = $OwnerId
            text = $readyText
        }
        if (-not $readyResult.ok) {
            throw 'telegram_ready_message_failed'
        }
        Complete-BridgeInstallTransaction -InstallDir $installDir
        $pairCodeLabel.Text = '✅ جاهز'
        Set-UiStatus '✅ تم التثبيت والربط والتشغيل بنجاح.' ([System.Drawing.Color]::FromArgb(22, 126, 76))
        Show-ArabicInfo 'تم بنجاح' "مساعدك شغّال الآن، وأرسل لك رسالة إثبات في تيليجرام.`r`n`r`nملاحظة صادقة: التشغيل التلقائي يبدأ عند تسجيل دخولك لويندوز، وليس قبل تسجيل الدخول."
        $verifyButton.Enabled = $true
        $tokenTextBox.Enabled = $true
    }
    catch {
        if (Test-Path -LiteralPath $installDir -PathType Container) {
            Stop-InstalledBridge
        }
        [void](Restore-BridgeInstallTransaction -InstallDir $installDir)
        if (Test-Path -LiteralPath $stageDir) {
            Remove-Item -LiteralPath $stageDir -Recurse -Force
        }
        if (-not $hadStartupShortcut -and (Test-Path -LiteralPath $startupShortcutPath)) {
            Remove-Item -LiteralPath $startupShortcutPath -Force
        }
        if ($hadExistingInstall -and $hadStartupShortcut) {
            [void](Start-InstalledBridge)
        }
        $verifyButton.Enabled = $true
        $tokenTextBox.Enabled = $true
        $problem = switch -Regex ($_.Exception.Message) {
            'claude_install_cancelled' { 'أوقفت تثبيت كلود كود، لذلك ما اكتمل الربط.'; break }
            'claude_install_failed_manual|claude_not_found_after_install' { 'تعذّر تثبيت كلود كود من المصدر الرسمي. ثبّته يدوياً من https://claude.ai/install.ps1 ثم افتح START.cmd من جديد.'; break }
            'claude_authentication_incomplete' { 'تسجيل الدخول إلى كلود ما اكتمل.'; break }
            'bridge_did_not_start' { 'نُسخت الملفات لكن الجسر ما بدأ خلال 15 ثانية.'; break }
            default { 'تعذّر إكمال التثبيت.' }
        }
        if ($script:ClaudeInstallAttempted) {
            $problem += ' أعدنا ملفات الجسر السابقة، لكن تثبيت Claude Code الخارجي قد يبقى لأنه برنامج مستقل.'
        }
        Show-ArabicError $problem 'اضغط «تشخيص» لمعرفة الخطوة المتوقفة، ثم عالجها وأعد المحاولة. ملفاتك وإعداداتك السابقة لم تُحذف.'
        Set-UiStatus 'توقف التثبيت بأمان. اضغط «تشخيص» للمساعدة.' ([System.Drawing.Color]::FromArgb(176, 55, 55))
    }
    finally {
        if (Test-Path -LiteralPath $stageDir) {
            Remove-Item -LiteralPath $stageDir -Recurse -Force
        }
    }
}

function Start-PairingWait {
    try {
        $deleteResult = Invoke-TelegramPost -Token $script:ValidatedToken -Method 'deleteWebhook' -Body @{
            drop_pending_updates = 'true'
        }
        if (-not $deleteResult.ok) {
            throw 'delete_webhook_failed'
        }
        $script:PairOffset = 0
        $script:PairAttempts = 0
        $script:PairDeadline = [datetime]::UtcNow.AddMinutes(10)
        Write-PairingState @{
            code = $script:PairCode
            expiresAt = $script:PairDeadline.ToString('o')
            used = $false
            attempts = 0
            offset = [long]0
        }
        $pairTimer.Start()
    }
    catch {
        $verifyButton.Enabled = $true
        $tokenTextBox.Enabled = $true
        Show-ArabicError 'رمز البوت صحيح، لكن تعذّر تجهيز استقبال كود الربط.' (Get-TelegramErrorMessage $_)
    }
}

$pairTimer.Add_Tick({
    $pairTimer.Stop()
    try {
        $pairingState = Read-PairingState
        $script:PairDeadline = [datetime]::Parse(
            [string]$pairingState.expiresAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $script:PairOffset = [long]$pairingState.offset
        $script:PairAttempts = [int]$pairingState.attempts
        if ([bool]$pairingState.used -or [datetime]::UtcNow -ge $script:PairDeadline) {
            throw 'pairing_expired'
        }
        $updates = Invoke-TelegramGet -Token $script:ValidatedToken -Method 'getUpdates' -Query @{
            offset = $script:PairOffset
            timeout = 0
            allowed_updates = '["message"]'
        } -TimeoutSec 8
        if (-not $updates.ok) {
            throw 'telegram_updates_not_ok'
        }
        foreach ($update in @($updates.result)) {
            $script:PairOffset = [math]::Max($script:PairOffset, ([int64]$update.update_id + 1))
            $pairingState.offset = [long]$script:PairOffset
            if (-not $update.message -or $null -eq $update.message.text) {
                Write-PairingState @{
                    code = [string]$pairingState.code
                    expiresAt = [string]$pairingState.expiresAt
                    used = [bool]$pairingState.used
                    attempts = [int]$pairingState.attempts
                    offset = [long]$pairingState.offset
                }
                continue
            }
            $text = [string]$update.message.text
            if ([string]::Equals($text, [string]$pairingState.code, [System.StringComparison]::Ordinal)) {
                $ownerId = [string][int64]$update.message.from.id
                $pairingState.used = $true
                Write-PairingState @{
                    code = [string]$pairingState.code
                    expiresAt = [string]$pairingState.expiresAt
                    used = $true
                    attempts = [int]$pairingState.attempts
                    offset = [long]$pairingState.offset
                    usedBy = $ownerId
                    usedAt = [datetime]::UtcNow.ToString('o')
                }
                $confirmation = Invoke-TelegramGet -Token $script:ValidatedToken -Method 'getUpdates' -Query @{
                    offset = $script:PairOffset
                    timeout = 0
                    allowed_updates = '["message"]'
                } -TimeoutSec 8
                if (-not $confirmation.ok) {
                    throw 'pairing_confirmation_failed'
                }
                Complete-Setup -OwnerId $ownerId
                return
            }
            $script:PairAttempts++
            $pairingState.attempts = [int]$script:PairAttempts
            Write-PairingState @{
                code = [string]$pairingState.code
                expiresAt = [string]$pairingState.expiresAt
                used = [bool]$pairingState.used
                attempts = [int]$pairingState.attempts
                offset = [long]$pairingState.offset
            }
            if ($script:PairAttempts -ge 5) {
                throw 'pairing_attempts_exceeded'
            }
        }
        $pairTimer.Start()
    }
    catch {
        if ($_.Exception.Message -eq 'pairing_expired') {
            Show-ArabicError 'انتهت مهلة كود الربط بعد 10 دقائق.' 'اضغط «تحقّق وابدأ الربط» لتوليد كود جديد.'
        }
        elseif ($_.Exception.Message -eq 'pairing_attempts_exceeded') {
            Show-ArabicError 'وصلت 5 رسائل غير مطابقة، فألغيت كود الربط لحماية البوت.' 'اضغط «تحقّق وابدأ الربط» لتوليد كود جديد، ثم أرسل الأرقام كما تظهر بدون مسافات.'
        }
        else {
            Show-ArabicError 'تعذّر انتظار كود الربط من تيليجرام.' (Get-TelegramErrorMessage $_)
        }
        $verifyButton.Enabled = $true
        $tokenTextBox.Enabled = $true
        $pairCodeLabel.Text = '------'
        Set-UiStatus 'توقف انتظار الربط بأمان. تقدر تعيد المحاولة.' ([System.Drawing.Color]::FromArgb(176, 55, 55))
    }
})

function Start-TokenValidation {
    $cleanToken = Normalize-BotToken $tokenTextBox.Text
    $tokenTextBox.Text = $cleanToken
    if (-not (Test-BotTokenShape $cleanToken)) {
        Show-ArabicError 'رمز البوت ناقص أو شكله غير صحيح.' 'انسخ رمز البوت نفسه من بوت فاذر. البرنامج ينظف الرابط والحروف المخفية والأرقام العربية تلقائياً.'
        return
    }
    $verifyButton.Enabled = $false
    $tokenTextBox.Enabled = $false
    Set-UiStatus 'أتأكد من الرمز مع تيليجرام…'
    try {
        $result = Invoke-TelegramGet -Token $cleanToken -Method 'getMe' -TimeoutSec 10
        if (-not $result.ok -or -not $result.result -or -not $result.result.username) {
            throw 'telegram_getme_not_ok'
        }
        $script:ValidatedToken = $cleanToken
        $script:BotUsername = [string]$result.result.username
        $botNameLabel.Text = "✅ اسم بوتك: @$($script:BotUsername)"
        $script:PairCode = New-PairingCode
        $pairCodeLabel.Text = $script:PairCode
        Set-UiStatus 'افتح بوتك في تيليجرام وأرسل له الأرقام الظاهرة. الكود صالح 10 دقائق.' ([System.Drawing.Color]::FromArgb(22, 126, 76))
        Start-PairingWait
    }
    catch {
        $verifyButton.Enabled = $true
        $tokenTextBox.Enabled = $true
        Set-UiStatus 'الرمز ما اجتاز التحقق.' ([System.Drawing.Color]::FromArgb(176, 55, 55))
        Show-ArabicError 'ما قدرت أتحقق من رمز البوت.' (Get-TelegramErrorMessage $_)
    }
}

function Get-DiagnosticReport {
    $lines = New-Object System.Collections.Generic.List[string]
    $token = Normalize-BotToken $tokenTextBox.Text
    if (-not $token -and (Test-Path -LiteralPath $installedEnvPath)) {
        try {
            $installedValues = Read-EnvFile $installedEnvPath
            if ($installedValues.TELEGRAM_BOT_TOKEN_DPAPI) {
                $token = Unprotect-CurrentUserSecret ([string]$installedValues.TELEGRAM_BOT_TOKEN_DPAPI)
            }
        }
        catch {
            $lines.Add('❌ ملف الإعداد موجود لكنه غير مقروء. أعد فتح النافذة واحفظ الرمز من جديد.')
        }
    }
    if (Test-BotTokenShape $token) {
        try {
            $bot = Invoke-TelegramGet -Token $token -Method 'getMe' -TimeoutSec 10
            if ($bot.ok) { $lines.Add("✅ رمز البوت صالح: @$($bot.result.username)") }
            else { $lines.Add('❌ تيليجرام رفض رمز البوت. انسخ رمزاً جديداً من بوت فاذر.') }
        }
        catch {
            $lines.Add('❌ تعذّر فحص رمز البوت. تأكد من الإنترنت أو أعد إنشاء الرمز.')
        }
    }
    else {
        $lines.Add('❌ رمز البوت غير موجود أو شكله غير صحيح.')
    }

    $spec = Get-ClaudeSpec $(if (Test-Path -LiteralPath $installDir) { $installDir } else { $sourceDir })
    if ($spec) {
        $auth = Invoke-ClaudeCommand -Spec $spec -Arguments @('auth', 'status')
        if ($auth.ExitCode -eq 0) {
            $lines.Add('✅ كلود كود موجود ومسجّل الدخول.')
        }
        else {
            $lines.Add('⚠️ كلود كود موجود لكنه يحتاج تسجيل دخول. أعد التثبيت وكمل نافذة الدخول.')
        }
    }
    else {
        $lines.Add('❌ كلود كود غير موجود. شغّل الإعداد وسيقودك لتثبيته.')
    }

    if (Test-Path -LiteralPath $installedEnvPath) {
        try {
            $values = Read-EnvFile $installedEnvPath
            if ([string]$values.TELEGRAM_OWNER_IDS -match '^\d+$') {
                $lines.Add('✅ رقمك موجود في قائمة السماح.')
            }
            else {
                $lines.Add('❌ قائمة السماح ناقصة. أعد خطوة الربط.')
            }
        }
        catch {
            $lines.Add('❌ ملف الإعداد تالف. أعد خطوة الربط بدون حذف مجلد data.')
        }
    }
    else {
        $lines.Add('⚠️ ما فيه إعداد محفوظ حتى الآن.')
    }

    $stateBackupPath = "$installedStatePath.bak"
    $corruptionMarkerPath = "$installedStatePath.corrupt-marker"
    $stateReadErrorPath = "$installedStatePath.read-error.json"
    $corruptState = Get-ChildItem -LiteralPath (Split-Path -Parent $installedStatePath) `
        -Filter 'state.json.corrupt-*' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (Test-Path -LiteralPath $stateReadErrorPath -PathType Leaf) {
        $lines.Add('⚠️ تعذّرت قراءة ملف الحالة مؤقتاً، ولم نصنّفه تالفاً. أغلق مؤقتاً برنامج النسخ الاحتياطي أو الفهرسة أو الحماية، انتظر دقيقة، ثم أغلق الإعداد وافتح START.cmd من جديد.')
    }
    if ($corruptState -or (Test-Path -LiteralPath $corruptionMarkerPath)) {
        if (Test-Path -LiteralPath $stateBackupPath -PathType Leaf) {
            $lines.Add('❌ ملف الحالة تالف ومعزول. اضغط «استعادة الحالة» للرجوع إلى آخر نسخة سليمة.')
        }
        else {
            $lines.Add('❌ ملف الحالة تالف ومعزول، وما لقيت نسخة احتياطية قابلة للاستعادة.')
        }
    }
    elseif (Test-Path -LiteralPath $stateBackupPath -PathType Leaf) {
        $lines.Add('✅ توجد نسخة احتياطية محلية من الحالة.')
    }

    $running = $false
    if (Test-Path -LiteralPath $installedPidPath) {
        $pidText = [System.IO.File]::ReadAllText($installedPidPath).Trim()
        if ($pidText -match '^\d+$') {
            $running = $null -ne (Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue)
        }
    }
    if ($running) { $lines.Add('✅ الجسر يعمل الآن.') }
    else { $lines.Add('❌ الجسر غير شغّال. أعد تشغيل الإعداد أو سجّل خروجاً ودخولاً لويندوز.') }

    if (Test-Path -LiteralPath $startupShortcutPath) {
        $lines.Add('✅ التشغيل التلقائي مسجّل عند تسجيل الدخول إلى ويندوز.')
    }
    else {
        $lines.Add('❌ التشغيل التلقائي غير مسجّل. أعد التثبيت.')
    }
    return $lines -join "`r`n"
}

function Invoke-StateBackupRestore {
    Stop-InstalledBridge
    [void](Restore-BridgeStateBackup -Path $installedStatePath)
    if (-not (Start-InstalledBridge)) {
        throw 'bridge_did_not_start_after_state_restore'
    }
}

function Restore-StateBackupLauncher {
    $backupPath = "$installedStatePath.bak"
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        Show-ArabicError 'ما لقيت نسخة احتياطية للحالة.' 'لا تحذف ملفات data. أعد الإعداد فقط إذا ما عندك نسخة سليمة.'
        return
    }
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "بنوقف الجسر ونستبدل الحالة الحالية بآخر نسخة احتياطية سليمة.`r`n`r`nقد ترجع خطوة واحدة للخلف في الجلسة أو الصندوق الصادر.",
        'استعادة الحالة',
        [System.Windows.Forms.MessageBoxButtons]::OKCancel,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2,
        [System.Windows.Forms.MessageBoxOptions]::RtlReading
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::OK) {
        return
    }
    try {
        Invoke-StateBackupRestore
        Show-ArabicInfo 'تمت الاستعادة' 'رجعت آخر نسخة سليمة من الحالة. احتفظنا بالملف التالف معزولاً داخل مجلد data للمراجعة.'
    }
    catch {
        $solution = switch -Regex ($_.Exception.Message) {
            'state_corruption_marker_clear_failed' {
                'تعذّر تحريك علامة التوقف من مجلد data. أغلق برنامج الحماية أو النسخ الاحتياطي مؤقتاً، ثم اضغط «استعادة الحالة» مرة ثانية. لن نعلن النجاح والعلامة باقية.'
                break
            }
            'bridge_did_not_start_after_state_restore' {
                'استعدنا الملف لكن الجسر لم يثبت أنه أقلع. افتح «تشخيص»، وعالج سبب الإقلاع، ثم أعد الاستعادة.'
                break
            }
            default {
                'لا تحذف مجلد data. افتح «تشخيص» وتأكد أن ملف state.json.bak موجود وسليم.'
            }
        }
        Show-ArabicError 'تعذّرت استعادة الحالة.' $solution
    }
}

function Uninstall-Launcher {
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "بوقف الجسر وأحذف التشغيل التلقائي فقط.`r`n`r`nما راح أحذف إعداداتك أو ذاكرتك أو ملفاتك.",
        'إلغاء التثبيت',
        [System.Windows.Forms.MessageBoxButtons]::OKCancel,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2,
        [System.Windows.Forms.MessageBoxOptions]::RtlReading
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::OK) {
        return
    }
    try {
        Uninstall-BridgeInstance -InstallDir $installDir -StartupShortcutPath $startupShortcutPath
        Show-ArabicInfo 'تم إلغاء التشغيل' "توقف الجسر وانحذف التشغيل التلقائي.`r`n`r`nملفاتك ما زالت هنا:`r`n$installDir`r`n`r`nاحذف المجلد بنفسك فقط إذا ما عاد تحتاج الإعدادات والذاكرة."
    }
    catch {
        Show-ArabicError 'تعذّر إيقاف الجسر أو حذف اختصار التشغيل.' 'أعد تشغيل الجهاز ثم افتح النافذة واضغط «إلغاء التثبيت» مرة ثانية. ملفاتك لم تُحذف.'
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ربط كلود كود بتيليجرام'
$form.Size = New-Object System.Drawing.Size(760, 650)
$form.MinimumSize = New-Object System.Drawing.Size(760, 650)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$form.RightToLeft = 'Yes'
$form.RightToLeftLayout = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(247, 249, 252)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = 'كلود في جيبك — إعداد مرة واحدة'
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$titleLabel.AutoSize = $false
$titleLabel.TextAlign = 'MiddleCenter'
$titleLabel.Location = New-Object System.Drawing.Point(25, 18)
$titleLabel.Size = New-Object System.Drawing.Size(695, 48)
$form.Controls.Add($titleLabel)

$introLabel = New-Object System.Windows.Forms.Label
$introLabel.Text = 'الصق رمز البوت من بوت فاذر. بنتأكد منه، ثم نعطيك كود ربط ترسله لبوتك عشان نعرف رقمك بأمان.'
$introLabel.Location = New-Object System.Drawing.Point(40, 75)
$introLabel.Size = New-Object System.Drawing.Size(665, 52)
$introLabel.TextAlign = 'MiddleCenter'
$form.Controls.Add($introLabel)

$tokenLabel = New-Object System.Windows.Forms.Label
$tokenLabel.Text = 'رمز البوت'
$tokenLabel.Location = New-Object System.Drawing.Point(565, 135)
$tokenLabel.Size = New-Object System.Drawing.Size(140, 28)
$form.Controls.Add($tokenLabel)

$tokenTextBox = New-Object System.Windows.Forms.TextBox
$tokenTextBox.Location = New-Object System.Drawing.Point(40, 166)
$tokenTextBox.Size = New-Object System.Drawing.Size(665, 32)
$tokenTextBox.RightToLeft = 'No'
$tokenTextBox.UseSystemPasswordChar = $true
$form.Controls.Add($tokenTextBox)

$showTokenCheck = New-Object System.Windows.Forms.CheckBox
$showTokenCheck.Text = 'إظهار الرمز'
$showTokenCheck.Location = New-Object System.Drawing.Point(585, 204)
$showTokenCheck.Size = New-Object System.Drawing.Size(120, 28)
$showTokenCheck.Add_CheckedChanged({
    $tokenTextBox.UseSystemPasswordChar = -not $showTokenCheck.Checked
})
$form.Controls.Add($showTokenCheck)

$botNameLabel = New-Object System.Windows.Forms.Label
$botNameLabel.Text = 'اسم البوت يظهر هنا بعد التحقق'
$botNameLabel.Location = New-Object System.Drawing.Point(40, 204)
$botNameLabel.Size = New-Object System.Drawing.Size(520, 28)
$botNameLabel.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 99)
$form.Controls.Add($botNameLabel)

$permissionGroup = New-Object System.Windows.Forms.GroupBox
$permissionGroup.Text = 'طريقة الصلاحيات'
$permissionGroup.Location = New-Object System.Drawing.Point(40, 242)
$permissionGroup.Size = New-Object System.Drawing.Size(665, 94)
$form.Controls.Add($permissionGroup)

$safeRadio = New-Object System.Windows.Forms.RadioButton
$safeRadio.Text = 'الوضع الآمن — كلود يبقى على موافقاته المعتادة (موصى به)'
$safeRadio.Location = New-Object System.Drawing.Point(25, 27)
$safeRadio.Size = New-Object System.Drawing.Size(610, 28)
$safeRadio.Checked = $true
$permissionGroup.Controls.Add($safeRadio)

$freeRadio = New-Object System.Windows.Forms.RadioButton
$freeRadio.Text = 'اشتغل بحرية — صلاحية كاملة، لجهاز مخصص فقط'
$freeRadio.Location = New-Object System.Drawing.Point(25, 57)
$freeRadio.Size = New-Object System.Drawing.Size(610, 28)
$permissionGroup.Controls.Add($freeRadio)

$verifyButton = New-Object System.Windows.Forms.Button
$verifyButton.Text = 'تحقّق وابدأ الربط'
$verifyButton.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$verifyButton.Location = New-Object System.Drawing.Point(465, 350)
$verifyButton.Size = New-Object System.Drawing.Size(240, 48)
$verifyButton.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
$verifyButton.ForeColor = [System.Drawing.Color]::White
$verifyButton.FlatStyle = 'Flat'
$verifyButton.Add_Click({ Start-TokenValidation })
$form.Controls.Add($verifyButton)

$botFatherButton = New-Object System.Windows.Forms.Button
$botFatherButton.Text = 'افتح بوت فاذر'
$botFatherButton.Location = New-Object System.Drawing.Point(40, 350)
$botFatherButton.Size = New-Object System.Drawing.Size(185, 48)
$botFatherButton.Add_Click({
    Start-Process 'https://t.me/BotFather'
})
$form.Controls.Add($botFatherButton)

$pairTitleLabel = New-Object System.Windows.Forms.Label
$pairTitleLabel.Text = 'كود الربط'
$pairTitleLabel.Location = New-Object System.Drawing.Point(580, 414)
$pairTitleLabel.Size = New-Object System.Drawing.Size(125, 28)
$form.Controls.Add($pairTitleLabel)

$pairCodeLabel = New-Object System.Windows.Forms.Label
$pairCodeLabel.Text = '------'
$pairCodeLabel.Font = New-Object System.Drawing.Font('Consolas', 30, [System.Drawing.FontStyle]::Bold)
$pairCodeLabel.Location = New-Object System.Drawing.Point(40, 440)
$pairCodeLabel.Size = New-Object System.Drawing.Size(665, 58)
$pairCodeLabel.TextAlign = 'MiddleCenter'
$pairCodeLabel.BackColor = [System.Drawing.Color]::White
$pairCodeLabel.BorderStyle = 'FixedSingle'
$form.Controls.Add($pairCodeLabel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = 'جاهز للتحقق. ما راح نحفظ شيء قبل نجاح الربط.'
$statusLabel.Location = New-Object System.Drawing.Point(40, 508)
$statusLabel.Size = New-Object System.Drawing.Size(665, 48)
$statusLabel.TextAlign = 'MiddleCenter'
$form.Controls.Add($statusLabel)

$diagnoseButton = New-Object System.Windows.Forms.Button
$diagnoseButton.Text = 'تشخيص'
$diagnoseButton.Location = New-Object System.Drawing.Point(550, 566)
$diagnoseButton.Size = New-Object System.Drawing.Size(155, 38)
$diagnoseButton.Add_Click({
    Show-ArabicInfo 'نتيجة التشخيص' (Get-DiagnosticReport)
})
$form.Controls.Add($diagnoseButton)

$editButton = New-Object System.Windows.Forms.Button
$editButton.Text = 'تعديل الإعدادات'
$editButton.Location = New-Object System.Drawing.Point(380, 566)
$editButton.Size = New-Object System.Drawing.Size(155, 38)
$editButton.Add_Click({
    if (-not (Test-Path -LiteralPath $installedEnvPath)) {
        Show-ArabicError 'ما فيه إعداد محفوظ حتى الآن.' 'الصق رمز البوت واضغط «تحقّق وابدأ الربط».'
        return
    }
    try {
        $values = Read-EnvFile $installedEnvPath
        $answer = [System.Windows.Forms.MessageBox]::Show(
            'رمز البوت مشفّر على القرص. هل تبي تفك تشفيره وتعرضه في الحقل الآن؟',
            'عرض رمز البوت',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning,
            [System.Windows.Forms.MessageBoxDefaultButton]::Button2,
            [System.Windows.Forms.MessageBoxOptions]::RtlReading
        )
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            $tokenTextBox.Text = Unprotect-CurrentUserSecret ([string]$values.TELEGRAM_BOT_TOKEN_DPAPI)
        }
        Set-UiStatus 'الإعداد موجود. الصق رمزاً جديداً أو وافق على عرضه ثم اضغط «تحقّق وابدأ الربط».'
    }
    catch {
        Show-ArabicError 'تعذّر قراءة ملف الإعداد الحالي.' 'لا تحذف مجلد data. الصق رمز البوت من جديد وأعد الربط لإصلاح ملف .env.'
    }
})
$form.Controls.Add($editButton)

$restoreButton = New-Object System.Windows.Forms.Button
$restoreButton.Text = 'استعادة الحالة'
$restoreButton.Location = New-Object System.Drawing.Point(210, 566)
$restoreButton.Size = New-Object System.Drawing.Size(155, 38)
$restoreButton.Add_Click({ Restore-StateBackupLauncher })
$form.Controls.Add($restoreButton)

$uninstallButton = New-Object System.Windows.Forms.Button
$uninstallButton.Text = 'إلغاء التثبيت'
$uninstallButton.Location = New-Object System.Drawing.Point(40, 566)
$uninstallButton.Size = New-Object System.Drawing.Size(155, 38)
$uninstallButton.Add_Click({ Uninstall-Launcher })
$form.Controls.Add($uninstallButton)

$form.Add_FormClosing({
    $pairTimer.Stop()
})

if ($PreflightSmokeTest) {
    $result = Invoke-Preflight
    Write-Output "PREFLIGHT_ERRORS=$($result.Errors.Count)"
    Write-Output "PREFLIGHT_WARNINGS=$($result.Warnings.Count)"
    foreach ($errorMessage in $result.Errors) {
        Write-Output "ERROR=$errorMessage"
    }
    foreach ($warningMessage in $result.Warnings) {
        Write-Output "WARNING=$warningMessage"
    }
    if ($result.Errors.Count -gt 0) { exit 1 }
    exit 0
}

if ($InstallSmokeTestPath) {
    $smokeRoot = [System.IO.Path]::GetFullPath($InstallSmokeTestPath)
    $allowedRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if (-not $smokeRoot.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'install_smoke_path_must_be_under_temp'
    }
    $installDir = $smokeRoot
    $startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'CC Telegram Bridge Smoke Test.lnk'
    try {
        Install-ApplicationFiles
        Register-StartupShortcut
        $installedNode = Join-Path $installDir 'runtime\node\node.exe'
        if (-not (Test-Path -LiteralPath $installedNode -PathType Leaf)) {
            throw 'install_smoke_node_missing'
        }
        $version = (& $installedNode --version)
        if ($LASTEXITCODE -ne 0 -or $version -ne 'v24.18.0') {
            throw 'install_smoke_node_failed'
        }
        if (-not (Test-Path -LiteralPath $startupShortcutPath -PathType Leaf)) {
            throw 'install_smoke_shortcut_missing'
        }
        Write-Output "INSTALL_SMOKE_OK=$installDir"
        Write-Output "NODE_VERSION=$version"
        Write-Output 'STARTUP_SHORTCUT_CREATED=True'
    }
    finally {
        Remove-Item -LiteralPath $startupShortcutPath -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

if ($StateRestoreSmokeTest) {
    Invoke-StateBackupRestore
    Write-Output "STATE_RESTORE_SMOKE_OK=$installDir"
    exit 0
}

if ($UiSmokeTestPath) {
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 800
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bitmap.Save($UiSmokeTestPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $form.Close()
    exit 0
}

$preflight = Invoke-Preflight
if ($preflight.Errors.Count -gt 0) {
    Show-ArabicError 'الجهاز ما اجتاز الفحص المسبق.' (($preflight.Errors -join "`r`n") + "`r`n`r`nما تغير أي ملف على جهازك.")
    exit 1
}
if ($preflight.Warnings.Count -gt 0) {
    Show-ArabicInfo 'تنبيه قبل البدء' ($preflight.Warnings -join "`r`n")
}

if (Test-Path -LiteralPath $installedEnvPath) {
    try {
        [void](Read-EnvFile $installedEnvPath)
        Set-UiStatus 'لقيت إعداداً سابقاً. الرمز المشفّر ما راح يظهر إلا بموافقتك من «تعديل الإعدادات».'
    }
    catch {
        Set-UiStatus 'ملف الإعداد السابق يحتاج إصلاح. الصق رمز البوت وأعد الربط.' ([System.Drawing.Color]::FromArgb(176, 55, 55))
    }
}

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
