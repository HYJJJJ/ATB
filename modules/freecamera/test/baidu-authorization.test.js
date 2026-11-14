import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/authorize-baidu.ps1', import.meta.url));
// A wrong token request, plaintext persistence or an error replacing prior credentials must fail this test.
test('Baidu setup exchanges a code only at the fixed endpoint, encrypts tokens and preserves credentials on failure', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-baidu-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = path.join(directory, 'verify.ps1');
  await writeFile(harness, `param($ScriptPath, $Directory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
trap { $Error | Select-Object -First 3 | ForEach-Object { [Console]::Error.WriteLine($_.Exception.Message + ' ' + $_.ScriptStackTrace) }; exit 1 }
. $ScriptPath -LibraryOnly
$script:Requests=0
$script:Failure=$false
$script:Incomplete=$false
function Invoke-RestMethod {
  param($Uri,$Method,$Body,$TimeoutSec,$MaximumRedirection)
  $script:Requests++
  if ($Uri -ne 'https://openapi.baidu.com/oauth/2.0/token' -or $Method -ne 'Post' -or $MaximumRedirection -ne 0 -or $TimeoutSec -gt 20) { throw 'wrong request boundary' }
  if ($Body.grant_type -ne 'authorization_code' -or $Body.client_id -ne 'fake-app' -or $Body.client_secret -ne 'fake-secret' -or $Body.code -ne 'fake-code' -or $Body.redirect_uri -ne 'oob') { throw 'wrong OAuth form' }
  if ($script:Failure) { throw 'provider echoed fake-secret fake-code fake-access fake-refresh' }
  if ($script:Incomplete) { return @{access_token='fake-access';expires_in=2592000;scope='basic netdisk'} }
  return @{access_token='fake-access';refresh_token='fake-refresh';expires_in=2592000;scope='basic netdisk'}
}
$vault=Join-Path $Directory 'vault'
$result=Save-AtbBaiduAuthorization -AppKey 'fake-app' -SecretKey 'fake-secret' -Code 'fake-code' -VaultDirectory $vault
if ($result.status -ne 'authorized' -or $result.recordingEnabled -ne $false -or $result.privacySpaceVerified -ne $false) { throw 'wrong completion state' }
$file=Join-Path $vault 'baidu-netdisk.credential.xml'
$raw=Get-Content -LiteralPath $file -Raw
if ($raw -match 'fake-secret|fake-code|fake-access|fake-refresh') { throw 'plaintext credential persisted' }
$secure=Import-Clixml -LiteralPath $file
$json=[System.Net.NetworkCredential]::new('', $secure).Password
$stored=$json|ConvertFrom-Json
if ($stored.appKey -ne 'fake-app' -or $stored.secretKey -ne 'fake-secret' -or $stored.accessToken -ne 'fake-access' -or $stored.refreshToken -ne 'fake-refresh' -or $stored.code) { throw 'encrypted roundtrip lost data or retained code' }
if ($stored.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -or $stored.scope -ne 'basic netdisk') { throw 'token lifetime lost' }
if (-not (Get-Acl -LiteralPath $vault).AreAccessRulesProtected) { throw 'vault ACL inheritance not disabled' }
$before=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
foreach($case in @('empty','provider','incomplete')) {
  $script:Failure=($case -eq 'provider');$script:Incomplete=($case -eq 'incomplete')
  $code='fake-code';if($case -eq 'empty'){$code=''}
  $failed=$false
  try { Save-AtbBaiduAuthorization -AppKey 'fake-app' -SecretKey 'fake-secret' -Code $code -VaultDirectory $vault | Out-Null } catch {
    $failed=$true
    if ($_.Exception.Message -match 'fake-secret|fake-code|fake-access|fake-refresh') { throw 'provider secret leaked in error' }
  }
  if(-not $failed){throw 'failed input accepted'}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $before){throw 'failed exchange overwrote successful credentials'}
}
if($script:Requests -ne 3){throw 'unexpected retry or empty input sent upstream'}
$script:Failure=$false;$script:Incomplete=$false
Save-AtbBaiduAuthorization -AppKey 'fake-app' -SecretKey 'fake-secret' -Code 'fake-code' -VaultDirectory $vault | Out-Null
if(Get-ChildItem -LiteralPath $vault -Filter '*.tmp'){throw 'credential temp file leaked'}
$status=Get-Content -LiteralPath (Join-Path $vault 'baidu-netdisk.status.json') -Raw
if($status -match 'fake-secret|fake-code|fake-access|fake-refresh'){throw 'public status leaked credentials'}
Write-Output 'AUTHORIZATION_CHECKS_PASS'
`, 'utf8');
  const result = await new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-ScriptPath', script, '-Directory', directory], { windowsHide: true, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /AUTHORIZATION_CHECKS_PASS/);
  const status = JSON.parse(await readFile(path.join(directory, 'vault/baidu-netdisk.status.json'), 'utf8'));
  assert.equal(status.status, 'authorized'); assert.equal(status.privacySpaceVerified, false); assert.equal(status.recordingEnabled, false);
});
