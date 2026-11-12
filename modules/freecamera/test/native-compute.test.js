import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeCompute } from '../desktop/compute.cjs';

test('native compute lease releases the real model when renderer heartbeats stop and rejects stale commands', async t => {
  const compute = new NativeCompute({ leaseMs: 1500 }); t.after(() => compute.close());
  const lease = await compute.open(); assert.equal(lease.available, true); assert.equal(compute.state.pid, null);
  const started = await compute.configure({ leaseId: lease.leaseId, enabled: true });
  assert.ok(started.pid); process.kill(started.pid, 0);
  const deadline = Date.now() + 4000;
  while (compute.state.pid !== null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.equal(compute.state.status, 'off'); assert.equal(compute.state.pid, null);
  assert.throws(() => process.kill(started.pid, 0));
  await assert.rejects(compute.configure({ leaseId: lease.leaseId, enabled: true }), /失效/);
});
