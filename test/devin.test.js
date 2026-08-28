import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSessions, isActive } from '../src/devin.js';

test('aggregateSessions counts sessions, activity, PRs, and ACUs', () => {
  assert.deepEqual(
    aggregateSessions([
      {
        status: 'running',
        acus_consumed: 1.25,
        pull_requests: [{ pr_state: 'open' }, { pr_state: 'merged' }],
      },
      {
        status: 'finished',
        acus_consumed: 2.31,
        pull_requests: [{ pr_state: null }],
      },
      {
        status: 'CLAIMED',
        pull_requests: [],
      },
    ]),
    { sessions: 3, active: 2, prsOpen: 3, prsMerged: 1, acus: 3.6 }
  );
});

test('aggregateSessions handles missing ACUs and empty lists', () => {
  assert.deepEqual(aggregateSessions([]), {
    sessions: 0,
    active: 0,
    prsOpen: 0,
    prsMerged: 0,
    acus: 0,
  });
  assert.deepEqual(
    aggregateSessions([{ status: 'new', pull_requests: null }]),
    { sessions: 1, active: 1, prsOpen: 0, prsMerged: 0, acus: 0 }
  );
});

test('isActive recognizes Devin active statuses case-insensitively', () => {
  for (const status of ['running', 'claimed', 'resuming', 'new', 'RUNNING', 'Claimed']) {
    assert.equal(isActive(status), true);
  }
  for (const status of ['finished', 'error', '', null, undefined]) {
    assert.equal(isActive(status), false);
  }
});
