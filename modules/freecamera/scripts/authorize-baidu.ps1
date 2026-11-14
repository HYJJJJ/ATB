param(
    [switch]$LibraryOnly,
    [string]$AppKey = ''
)
$ErrorActionPreference = 'Stop'

function Save-AtbBaiduAuthorization {
    param([string]$AppKey, [string]$SecretKey, [string]$Code, [string]$VaultDirectory)
    $AppKey = $AppKey.Trim(); $SecretKey = $SecretKey.Trim(); $Code = $Code.Trim()
    if (-not $AppKey -or -not $SecretKey -or -not $Code -or $AppKey.Length -gt 256 -or $SecretKey.Length -gt 1024 -or $Code.Length -gt 2048) {
        throw '请填写正确的 AppKey、SecretKey 和授权码。'
    }
    if (-not $VaultDirectory) { $VaultDirectory = Join-Path $env:LOCALAPPDATA 'ATB\secrets' }
    $tokenResult = $null
    try {
        $tokenResult = Invoke-RestMethod -Uri 'https://openapi.baidu.com/oauth/2.0/token' -Method Post -Body @{
            grant_type = 'authorization_code'; client_id = $AppKey; client_secret = $SecretKey; code = $Code; redirect_uri = 'oob'
        } -TimeoutSec 20 -MaximumRedirection 0
    } catch {
        throw '百度授权兑换失败。请核对应用信息，并重新获取授权码；原有凭据未更改。'
    }
    $lifetime = 0L
    if ($tokenResult.error -or -not ($tokenResult.access_token -is [string]) -or -not $tokenResult.access_token -or
        -not ($tokenResult.refresh_token -is [string]) -or -not $tokenResult.refresh_token -or
        -not [long]::TryParse([string]$tokenResult.expires_in, [ref]$lifetime) -or $lifetime -le 0 -or $lifetime -gt 315360000) {
        throw '百度未返回完整的访问和续期凭据，请检查应用授权权限后重新授权；原有凭据未更改。'
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $credential = [ordered]@{
        version = 1; provider = 'baidu-netdisk'; appKey = $AppKey; secretKey = $SecretKey
        accessToken = $tokenResult.access_token; refreshToken = $tokenResult.refresh_token
        scope = [string]$tokenResult.scope; expiresAt = $now + $lifetime; authorizedAt = $now
    }
    $file = Join-Path $VaultDirectory 'baidu-netdisk.credential.xml'
    $temporary = Join-Path $VaultDirectory (([Guid]::NewGuid().ToString('N')) + '.tmp')
    try {
        [IO.Directory]::CreateDirectory($VaultDirectory) | Out-Null
        if ((Get-Item -LiteralPath $VaultDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe vault' }
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = Get-Acl -LiteralPath $VaultDirectory
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
        $acl.SetOwner($sid)
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($VaultDirectory), $acl)
        } else { [IO.Directory]::SetAccessControl($VaultDirectory, $acl) }
        $json = $credential | ConvertTo-Json -Compress
        $encrypted = ConvertTo-SecureString -String $json -AsPlainText -Force
        Export-Clixml -InputObject $encrypted -LiteralPath $temporary -Encoding UTF8
        if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, [System.Management.Automation.Language.NullString]::Value, $true) }
        else { [IO.File]::Move($temporary, $file) }
    } catch {
        throw '本机加密凭据保存失败，请检查当前用户的目录权限；不要把密钥发到聊天中。'
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        $json = $null; $encrypted = $null; $credential = $null; $tokenResult = $null; $SecretKey = $null; $Code = $null
    }
    $status = [ordered]@{
        status = 'authorized'; savedAt = $now; expiresAt = $now + $lifetime
        credentialProtection = 'windows-current-user-dpapi'; recordingEnabled = $false; privacySpaceVerified = $false
    }
    $statusPath = Join-Path $VaultDirectory 'baidu-netdisk.status.json'
    [IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    return $status
}

function Get-AtbBaiduAuthorizationUrl {
    param([string]$AppKey)
    if (-not $AppKey.Trim()) { throw '请先填写 AppKey。' }
    return 'https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=' + [Uri]::EscapeDataString($AppKey.Trim()) + '&redirect_uri=oob&scope=basic%2Cnetdisk&display=page'
}

if ($LibraryOnly) { return }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = 'ATB · 百度网盘授权'
$form.ClientSize = [Drawing.Size]::new(590, 490)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10)
$form.BackColor = [Drawing.Color]::FromArgb(20, 28, 43)
$form.ForeColor = [Drawing.Color]::FromArgb(224, 233, 249)

function Add-AtbLabel([string]$Text, [int]$Top, [int]$Height = 26) {
    $label = [Windows.Forms.Label]::new(); $label.Text = $Text
    $label.Location = [Drawing.Point]::new(24, $Top); $label.Size = [Drawing.Size]::new(542, $Height)
    $form.Controls.Add($label)
}
function Add-AtbInput([int]$Top, [bool]$Sensitive) {
    $inputBox = [Windows.Forms.TextBox]::new()
    $inputBox.Location = [Drawing.Point]::new(24, $Top); $inputBox.Size = [Drawing.Size]::new(542, 30)
    $inputBox.UseSystemPasswordChar = $Sensitive; $inputBox.MaxLength = 2048
    $inputBox.BackColor = [Drawing.Color]::FromArgb(34, 46, 66); $inputBox.ForeColor = $form.ForeColor
    $inputBox.BorderStyle = 'FixedSingle'; $form.Controls.Add($inputBox)
    return $inputBox
}
Add-AtbLabel '仅在本机填写。凭据由当前 Windows 用户加密保存。' 22
Add-AtbLabel 'AppKey' 65
$appInput = Add-AtbInput 94 $false; $appInput.Text = $AppKey
Add-AtbLabel 'SecretKey' 140
$secretInput = Add-AtbInput 169 $true
Add-AtbLabel '百度页面显示的授权码 code' 215
$codeInput = Add-AtbInput 244 $true

$authorize = [Windows.Forms.LinkLabel]::new()
$authorize.Text = '授权码过期或未复制？重新打开百度授权'
$authorize.Location = [Drawing.Point]::new(24, 291); $authorize.Size = [Drawing.Size]::new(540, 28)
$authorize.LinkColor = [Drawing.Color]::FromArgb(161, 188, 255)
$authorize.ActiveLinkColor = $authorize.LinkColor; $form.Controls.Add($authorize)
$authorize.Add_LinkClicked({
    try { Start-Process (Get-AtbBaiduAuthorizationUrl -AppKey $appInput.Text) }
    catch { $statusLabel.Text = '请先填写 AppKey，再打开授权页面。' }
})
$save = [Windows.Forms.Button]::new(); $save.Text = '保存并验证授权'
$save.Location = [Drawing.Point]::new(24, 333); $save.Size = [Drawing.Size]::new(260, 42)
$save.FlatStyle = 'Flat'; $save.BackColor = [Drawing.Color]::FromArgb(53, 77, 125)
$form.Controls.Add($save)
$statusLabel = [Windows.Forms.Label]::new(); $statusLabel.Location = [Drawing.Point]::new(24, 394)
$statusLabel.Size = [Drawing.Size]::new(542, 78)
$statusLabel.Text = '目标：隐私空间 /ATB/监控/。本窗口只完成授权，尚未开启录像或上传，隐私空间接口仍待验证。'
$form.Controls.Add($statusLabel)
$form.AcceptButton = $save
$save.Add_Click({
    $save.Enabled = $false; $authorize.Enabled = $false
    $statusLabel.Text = '正在向百度兑换授权并加密保存，请稍候…'
    $form.UseWaitCursor = $true; $form.Refresh()
    try {
        Save-AtbBaiduAuthorization -AppKey $appInput.Text -SecretKey $secretInput.Text -Code $codeInput.Text | Out-Null
        $secretInput.Clear(); $codeInput.Clear()
        $statusLabel.Text = '授权已验证并加密保存。可以关闭本窗口。录像上传尚未开启，隐私空间接口待进一步核实。'
    } catch { $statusLabel.Text = $_.Exception.Message }
    finally { $save.Enabled = $true; $authorize.Enabled = $true; $form.UseWaitCursor = $false }
})
$form.Add_FormClosed({ $secretInput.Clear(); $codeInput.Clear() })
# The hidden PowerShell console can pass its initial hidden show state to the first GUI window.
$form.Show(); $form.Hide(); $form.Show(); $form.Activate()
[Windows.Forms.Application]::Run($form)
$form.Dispose()
