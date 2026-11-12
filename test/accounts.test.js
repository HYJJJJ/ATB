import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountStore } from '../server/accounts.js';

test('administrator credentials persist as a salted hash and sessions expire or can be revoked', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freecamera-account-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'account.json'); let now = 1000;
  const accounts = await AccountStore.load(filename, { now: () => now, sessionMs: 100 });
  assert.equal(accounts.configured, false);
  await assert.rejects(accounts.setup('admin', null), /文本/);
  await accounts.setup('admin', 'test-camera-password');
  assert.equal(accounts.configured, true);
  assert.equal((await readFile(filename, 'utf8')).includes('test-camera-password'), false);
  await assert.rejects(accounts.setup('another', 'different-password'), /已/);
  assert.equal(await accounts.login('admin', 'incorrect-password'), null);
  assert.equal(await accounts.login('missing', 'test-camera-password'), null);
  const session = await accounts.login('admin', 'test-camera-password');
  assert.deepEqual(accounts.session(session.token)?.user, { username: 'admin', role: 'admin' });
  assert.equal(accounts.session('bad'), null);
  accounts.logout(session.token); assert.equal(accounts.session(session.token), null);
  const fresh = await accounts.login('admin', 'test-camera-password'); now += 101;
  assert.equal(accounts.session(fresh.token), null);
  const loaded = await AccountStore.load(filename); assert.equal(loaded.configured, true);
  assert.ok(await loaded.login('admin', 'test-camera-password'));
});

test('administrator credentials accept short, Unicode, whitespace, long and empty values without policy restrictions', async () => {
  for (const [username, password] of [['中', '1'], [' 家里 👀 ', ' '], ['a'.repeat(129), 'p'.repeat(129)], ['', '']]) {
    const accounts = new AccountStore(); await accounts.setup(username, password);
    const session = await accounts.login(username, password);
    assert.equal(session?.user.username, username);
    assert.equal(await accounts.login(username, `${password}x`), null);
  }
});

test('concurrent first-account requests cannot overwrite the administrator', async () => {
  const accounts = new AccountStore();
  const results = await Promise.allSettled([accounts.setup('first', 'first-password'), accounts.setup('second', 'second-password')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(await accounts.login('first', 'first-password'));
  assert.equal(await accounts.login('second', 'second-password'), null);
});

test('unexpired administrator sessions survive service handoff, use hashed tokens on disk and persist logout revocation', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'freecamera-session-resume-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'account.json');let now=1000;
  let accounts=await AccountStore.load(filename,{now:()=>now,sessionMs:100});await accounts.setup('admin','1');
  const session=await accounts.login('admin','1');
  accounts=await AccountStore.load(filename,{now:()=>now,sessionMs:100});
  assert.equal(accounts.session(session.token)?.user.username,'admin');
  assert.equal((await readFile(path.join(dir,'account-sessions.json'),'utf8')).includes(session.token),false);
  accounts.logout(session.token);await accounts.pending;
  accounts=await AccountStore.load(filename,{now:()=>now,sessionMs:100});assert.equal(accounts.session(session.token),null);
  const expiring=await accounts.login('admin','1');now+=101;
  accounts=await AccountStore.load(filename,{now:()=>now,sessionMs:100});assert.equal(accounts.session(expiring.token),null);
});
