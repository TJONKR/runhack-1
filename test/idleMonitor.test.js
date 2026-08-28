import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceCovers, stepTeam } from '../src/idleMonitor.js';

const cfg = { idleGraceS: 15, coverageStaleS: 35, idleSpeedMs: 1.5 };
const T0 = 1_000_000_000_000;

test('deviceCovers: fresh running fix covers, stale or slow does not', () => {
  assert.equal(deviceCovers({ at: T0 - 5_000, speedMs: 3 }, T0, cfg), true);
  assert.equal(deviceCovers({ at: T0 - 5_000, speedMs: 0.5 }, T0, cfg), false); // walking
  assert.equal(deviceCovers({ at: T0 - 60_000, speedMs: 3 }, T0, cfg), false); // stale
  assert.equal(deviceCovers({ at: T0 - 5_000, speedMs: null }, T0, cfg), true); // no speed: benefit of the doubt
  assert.equal(deviceCovers(null, T0, cfg), false);
  assert.equal(deviceCovers({}, T0, cfg), false);
});

test('infraction opens after the grace window, backdated to when grace ran out', () => {
  let s = { lastCoveredAt: null, openSince: null };
  ({ state: s } = stepTeam(s, true, T0, cfg));
  assert.equal(s.lastCoveredAt, T0);

  // 10s idle: still inside grace
  let r = stepTeam(s, false, T0 + 10_000, cfg);
  assert.equal(r.open, null);

  // 20s idle: opens, backdated to T0+15s
  r = stepTeam(s, false, T0 + 20_000, cfg);
  assert.equal(r.open, T0 + 15_000);
  assert.equal(r.state.openSince, T0 + 15_000);

  // still idle: no duplicate open
  const r2 = stepTeam(r.state, false, T0 + 30_000, cfg);
  assert.equal(r2.open, null);

  // coverage returns: closes now
  const r3 = stepTeam(r2.state, true, T0 + 40_000, cfg);
  assert.equal(r3.close, T0 + 40_000);
  assert.equal(r3.state.openSince, null);
  assert.equal(r3.state.lastCoveredAt, T0 + 40_000);
});

test('first sighting arms without punishing', () => {
  const r = stepTeam({ lastCoveredAt: null, openSince: null }, false, T0, cfg);
  assert.equal(r.open, null);
  assert.equal(r.state.lastCoveredAt, T0);
  // and only opens once grace elapses from that arming point
  const r2 = stepTeam(r.state, false, T0 + 16_000, cfg);
  assert.equal(r2.open, T0 + 15_000);
});
