const path = require('node:path');
const childProcess = require('node:child_process');

// Service names and commands are fixed here. The page cannot supply commands,
// executable paths or service configuration. Only the discovered client is used.
const startServiceScript = `
$ErrorActionPreference = 'Stop'
$rdService = Get-Service -Name 'RustDesk' -ErrorAction Stop
if ($rdService.Status -eq 'StopPending') {
  $rdService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(15))
  $rdService.Refresh()
}
if ($rdService.Status -eq 'StartPending') {
  $rdService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(15))
  $rdService.Refresh()
}
if ($rdService.Status -ne 'Running') {
  Set-Service -Name 'RustDesk' -StartupType Automatic -ErrorAction Stop
  if ($rdService.Status -eq 'Paused') { Resume-Service -Name 'RustDesk' -ErrorAction Stop }
  else { Start-Service -Name 'RustDesk' -ErrorAction Stop }
  $rdService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(15))
}
`;
const encode = value => Buffer.from(value, 'utf16le').toString('base64');
function serviceScript(executable) {
  const clientLiteral = "'" + executable.replaceAll("'", "''") + "'";
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rdClient = ${clientLiteral}
$rdStartCode = '${encode(startServiceScript)}'
try {
  $rdService = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
  if ($null -ne $rdService -and $rdService.Status -eq 'Running') {
    Write-Output '{"state":"running","changed":false}'
    exit 0
  }
  if ($null -eq $rdService) {
    # The official Run service action registers the service. Do this only when
    # absent: repeating --install-service would replace a running service.
    Start-Process -FilePath $rdClient -ArgumentList '--install-service' -WindowStyle Hidden -ErrorAction Stop | Out-Null
  } else {
    try {
      & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($rdStartCode))))
    } catch {
      $rdPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      if ($rdPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw }
      # Keep the whole ATB application unelevated. Windows asks only for the
      # fixed service-start operation, and a declined prompt is a failure.
      $rdHelper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $rdStartCode) -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop
      if (-not $rdHelper.WaitForExit(45000)) { throw 'Service authorization timed out' }
      if ($rdHelper.ExitCode -ne 0) { throw 'Service startup was not allowed' }
    }
  }
  $rdDeadline = [DateTime]::UtcNow.AddSeconds(40)
  do {
    $rdService = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
    if ($null -ne $rdService -and $rdService.Status -eq 'Running') {
      Write-Output '{"state":"running","changed":true}'
      exit 0
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $rdDeadline)
  throw 'Service did not become running'
} catch {
  # Do not expose native errors, local configuration or process output to pages.
  [Console]::Error.WriteLine('RustDesk service startup failed or was cancelled')
  exit 1
}
`;
}
function ensureWindowsService(executable) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!/^[a-z]:\\/i.test(systemRoot)) return Promise.reject(Error('无法定位 Windows 服务管理程序'));
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const failure = () => Error('无法自动启动 RustDesk 本机服务。若 Windows 提示管理员授权，请允许后重试；仍失败时请检查客户端安装。');
  return new Promise((resolve, reject) => {
    childProcess.execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(serviceScript(executable))],
      { shell: false, windowsHide: true, timeout: 85000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(failure()); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (result.state !== 'running' || typeof result.changed !== 'boolean') throw Error();
          resolve(result);
        } catch { reject(failure()); }
      });
  });
}
module.exports = { ensureWindowsService, serviceScript };