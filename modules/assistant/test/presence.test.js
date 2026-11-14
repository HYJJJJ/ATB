import test from 'node:test';
import assert from 'node:assert/strict';
import { ArrivalTracker, matchFace, validateEnrollment } from '../public/presence-state.js';

const face = offset => Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10 + offset);
test('face matching keeps poor, unknown and ambiguous observations unknown', () => {
  const enrolled = [face(0), face(.005), face(-.005)];
  assert.equal(matchFace(face(.001), enrolled), true);
  assert.equal(matchFace(face(.2), enrolled), false);
  assert.equal(matchFace([NaN], enrolled), false);
  assert.throws(() => validateEnrollment([face(0), face(.2), face(0)]), /同一人/);
  assert.throws(() => validateEnrollment([face(0)]), /3/);
  assert.throws(() => validateEnrollment([Array(128).fill(0), face(0), face(0)]));
});
test('arrival requires multiple fresh frames and short occlusion cannot greet twice', () => {
  const tracker = new ArrivalTracker({ confirmMs: 2000, absenceMs: 60000, cooldownMs: 300000 });
  assert.equal(tracker.observe(true, 0), false);
  assert.equal(tracker.observe(true, 1000), false);
  assert.equal(tracker.observe(true, 2000), true);
  assert.equal(tracker.observe(true, 3000), false);
  tracker.observe(false, 4000); tracker.observe(false, 8000);
  assert.equal(tracker.observe(true, 9000), false);
});
test('outages never prove departure; fresh absence and cooldown allow a later arrival', () => {
  const t = new ArrivalTracker({ confirmMs: 2000, absenceMs: 5000, cooldownMs: 10000 });
  t.observe(true, 0); t.observe(true, 1000); assert.equal(t.observe(true, 2000), true);
  t.observe(false, 3000); t.unavailable();
  assert.equal(t.observe(true, 60000), false);
  for (let at = 61000; at <= 68000; at += 1000) t.observe(false, at);
  t.observe(true, 69000); t.observe(true, 70000); assert.equal(t.observe(true, 71000), true);
});
test('sparse frames, stale timestamps and interrupted confirmation cannot establish arrival', () => {
  const t = new ArrivalTracker();
  t.observe(true, 1000); t.observe(true, 10000); assert.equal(t.observe(true, 11000), false);
  t.observe(false, 12000); t.observe(true, 13000); t.observe(true, 14000);
  assert.equal(t.observe(true, 14000), false);
  t.unavailable(); assert.equal(t.observe(true, 15000), false);
});
