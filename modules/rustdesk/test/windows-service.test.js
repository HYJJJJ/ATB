import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { serviceScript } = require('../desktop/windows-service.cjs');
const run = promisify(execFile);

// Real Windows PowerShell executes the production script. These process-local
// functions replace service cmdlets, so tests never modify a real service.
function fixture(state, cancelInstall = false) {
  return String.raw`
Add-Type -AssemblyName System.ServiceProcess
$global:rdEvents = [Collections.Generic.List[string]]::new()
$global:rdFixtureState = '${state}'
function New-FixtureService {
  $item = [PSCustomObject]@{ Status = $global:rdFixtureState; StartType = 'Manual' }
  $item | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
  $item | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value { param($status, $timeout) $this.Status = $status.ToString() }
  return $item
}
$global:rdFixtureService = New-FixtureService
function Get-Service {
  [CmdletBinding()] param($Name)
  if ($Name -ne 'RustDesk') { throw 'Unexpected service' }
  if ($global:rdFixtureState -eq 'Missing') { return $null }
  return $global:rdFixtureService
}
function Set-Service {
  [CmdletBinding()] param($Name, $StartupType)
  if ($Name -ne 'RustDesk' -or $StartupType -ne 'Automatic') { throw 'Unexpected setting' }
  $global:rdEvents.Add('automatic')
  $global:rdFixtureService.StartType = 'Automatic'
}
function Start-Service {
  [CmdletBinding()] param($Name)
  if ($Name -ne 'RustDesk') { throw 'Unexpected start' }
  $global:rdEvents.Add('start')
  $global:rdFixtureService.Status = 'Running'
}
function Resume-Service {
  [CmdletBinding()] param($Name)
  if ($Name -ne 'RustDesk') { throw 'Unexpected resume' }
  $global:rdEvents.Add('resume')
  $global:rdFixtureService.Status = 'Running'
}
function Start-Process {
  [CmdletBinding()] param($FilePath, $ArgumentList, $WindowStyle, $Verb, [switch]$PassThru)
  if (${cancelInstall ? '$true' : '$false'}) { throw 'private-native-error-not-for-pages' }
  if ($ArgumentList -ne '--install-service' -or $WindowStyle -ne 'Hidden' -or $Verb) { throw 'Unexpected process launch' }
  if ($FilePath -ne 'C:\Apps\O''Brien & $dir\RustDesk.exe') { throw 'Client path was evaluated instead of preserved' }
  $global:rdEvents.Add('official-install')
  $global:rdFixtureState = 'Running'
  $global:rdFixtureService = New-FixtureService
}
function Write-Output {
  param($InputObject)
  $result = ConvertFrom-Json $InputObject
  $result | Add-Member -NotePropertyName events -NotePropertyValue @($global:rdEvents.ToArray())
  Microsoft.PowerShell.Utility\Write-Output (ConvertTo-Json -InputObject $result -Compress)
}
`;
}
async function execute(state, cancelInstall = false) {
  const script = fixture(state, cancelInstall) + serviceScript("C:\\Apps\\O'Brien & $dir\\RustDesk.exe");
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  return JSON.parse(result.stdout.trim());
}

test('running Windows service is read only and never reinstalled or restarted', { skip: process.platform !== 'win32' }, async () => {
  assert.deepEqual(await execute('Running'), { state: 'running', changed: false, events: [] });
});
test('stopped Windows service becomes automatic and starts before reporting readiness', { skip: process.platform !== 'win32' }, async () => {
  assert.deepEqual(await execute('Stopped'), { state: 'running', changed: true, events: ['automatic', 'start'] });
});
test('paused Windows service resumes without recreating the service', { skip: process.platform !== 'win32' }, async () => {
  assert.deepEqual(await execute('Paused'), { state: 'running', changed: true, events: ['automatic', 'resume'] });
});
test('missing Windows service uses only the official fixed install argument and literal client path', { skip: process.platform !== 'win32' }, async () => {
  assert.deepEqual(await execute('Missing'), { state: 'running', changed: true, events: ['official-install'] });
});
test('cancelled service installation fails without returning readiness or private error details', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(execute('Missing', true), error => error.code === 1 && /RustDesk service startup failed or was cancelled/.test(error.stderr) && !error.stderr.includes('private-native-error'));
});