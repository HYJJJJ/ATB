[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port=8443,[ValidateRange(0,65535)][int]$TurnPort=0,[ValidateRange(1,65535)][int]$SetupPort=8080)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请在以管理员身份运行的 PowerShell 中执行此脚本。' }
$adapter=Get-NetAdapter -Name 'Tailscale' -ErrorAction Stop
if (!$TurnPort) { $TurnPort=if ($Port -eq 65535) {65534} else {$Port+1} }
foreach ($protocol in @('TCP','UDP')) {
  $ruleName="FreeCamera-Tailscale-$protocol-$Port"
  if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName "FreeCamera Tailscale $protocol $Port" -Direction Inbound -Action Allow -Protocol $protocol -LocalPort $Port -RemoteAddress '100.64.0.0/10' -InterfaceAlias $adapter.Name -Profile Any | Out-Null
  }
}
foreach ($tcpPort in @($TurnPort,$SetupPort)) {
  $ruleName="FreeCamera-Tailscale-TCP-$tcpPort"
  if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName "FreeCamera Tailscale TCP $tcpPort" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $tcpPort -RemoteAddress '100.64.0.0/10' -InterfaceAlias $adapter.Name -Profile Any | Out-Null
  }
}
Write-Output "已允许 Tailscale 网络访问 FreeCamera HTTPS/STUN $Port、视频转发 TCP $TurnPort、安装引导 TCP $SetupPort。"
