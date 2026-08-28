import { pool } from './db.js';

const DEVIN_API = process.env.DEVIN_API_BASE ?? 'https://api.devin.ai';
const ACTIVE_STATUSES = new Set(['running', 'claimed', 'resuming', 'new']);

async function devinFetch(apiKey, path) {
  const res = await fetch(`${DEVIN_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Devin API ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

export async function listSessions(apiKey, orgId, sinceDate) {
  const sessions = [];
  let after = null;
  const createdAfter = Math.floor(sinceDate.getTime() / 1000);
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      first: '100',
      created_after: String(createdAfter),
    });
    if (after) params.set('after', after);
    const data = await devinFetch(
      apiKey,
      `/v3/organizations/${encodeURIComponent(orgId)}/sessions?${params}`
    );
    sessions.push(...(data.items ?? []));
    if (!data.has_next_page || !data.end_cursor) break;
    after = data.end_cursor;
  }
  return sessions;
}

export async function countMessages(apiKey, orgId, sessionId) {
  let count = 0;
  let after = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ first: '200' });
    if (after) params.set('after', after);
    const data = await devinFetch(
      apiKey,
      `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/messages?${params}`
    );
    if (page === 0 && typeof data.total === 'number') return data.total;
    count += data.items?.length ?? 0;
    if (!data.has_next_page || !data.end_cursor) break;
    after = data.end_cursor;
  }
  return count;
}

export function isActive(status) {
  return ACTIVE_STATUSES.has(String(status ?? '').toLowerCase());
}

export function aggregateSessions(sessions) {
  let active = 0;
  let prsOpen = 0;
  let prsMerged = 0;
  let acus = 0;
  for (const session of sessions) {
    if (isActive(session.status)) active++;
    acus += Number(session.acus_consumed || 0);
    for (const pr of session.pull_requests ?? []) {
      prsOpen++;
      if (pr.pr_state === 'merged') prsMerged++;
    }
  }
  return {
    sessions: sessions.length,
    active,
    prsOpen,
    prsMerged,
    acus: Number(acus.toFixed(1)),
  };
}

export async function fetchTeamMetrics(apiKey, orgId, sinceDate) {
  const sessions = await listSessions(apiKey, orgId, sinceDate);
  let msgs = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const batch = sessions.slice(i, i + CONCURRENCY);
    const counts = await Promise.allSettled(
      batch.map((session) => countMessages(apiKey, orgId, session.session_id))
    );
    counts.forEach((result) => {
      if (result.status === 'fulfilled') msgs += result.value;
    });
  }
  return { ...aggregateSessions(sessions), msgs };
}

export async function pollOnce() {
  const { rows } = await pool.query(
    `SELECT t.id, t.devin_org_id, t.devin_api_key, t.created_at AS team_created_at,
            e.start_at, e.end_at
       FROM teams t JOIN events e ON e.id = t.event_id
      WHERE t.devin_org_id IS NOT NULL AND t.devin_org_id <> ''
        AND t.devin_api_key IS NOT NULL AND t.devin_api_key <> ''
        AND (e.end_at IS NULL OR e.end_at > now() - interval '1 hour')`
  );
  for (const t of rows) {
    try {
      const since = t.start_at || t.team_created_at;
      const metrics = await fetchTeamMetrics(t.devin_api_key, t.devin_org_id, since);
      await pool.query(
        `UPDATE teams SET devin_sessions = $1, devin_active = $2, devin_msgs = $3,
                devin_prs_open = $4, devin_prs_merged = $5, devin_acus = $6,
                devin_checked_at = now(), devin_status = 'connected'
          WHERE id = $7`,
        [
          metrics.sessions,
          metrics.active,
          metrics.msgs,
          metrics.prsOpen,
          metrics.prsMerged,
          metrics.acus,
          t.id,
        ]
      );
    } catch (err) {
      console.error('devin poll failed for team', t.id, err.message);
      await pool.query("UPDATE teams SET devin_status = 'error' WHERE id = $1", [t.id]);
    }
  }
}

export function startDevinPoller() {
  const intervalMs = 60_000;
  pollOnce().catch((e) => console.error('devin poll', e.message));
  setInterval(() => pollOnce().catch((e) => console.error('devin poll', e.message)), intervalMs);
  console.log(`devin poller every ${intervalMs / 1000}s`);
}
