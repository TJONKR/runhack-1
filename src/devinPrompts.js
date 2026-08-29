import { eventConfig, eventStatus, pool } from './db.js';

const DEVIN_API = process.env.DEVIN_API_BASE ?? 'https://api.devin.ai';
const GAP_LOOKBACK_MS = 10 * 60 * 1000;

async function devinFetch(apiKey, path, params = {}) {
  const query = new URLSearchParams(params);
  const url = `${DEVIN_API}${path}${query.toString() ? `?${query}` : ''}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Devin API ${path} -> ${response.status}`);
  }
  return response.json();
}

export async function listSessions(apiKey, orgId, sinceMs) {
  const sessions = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const params = {
      first: '100',
      created_after: String(Math.floor(sinceMs / 1000)),
    };
    if (after) params.after = after;
    const body = await devinFetch(
      apiKey,
      `/v3/organizations/${encodeURIComponent(orgId)}/sessions`,
      params
    );
    sessions.push(...(Array.isArray(body.items) ? body.items : []));
    if (!body.has_next_page || !body.end_cursor) break;
    after = body.end_cursor;
  }
  return sessions;
}

export async function listSessionMessages(apiKey, orgId, sessionId) {
  const messages = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const params = { first: '200' };
    if (after) params.after = after;
    const body = await devinFetch(
      apiKey,
      `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      params
    );
    messages.push(...(Array.isArray(body.items) ? body.items : []));
    if (!body.has_next_page || !body.end_cursor) break;
    after = body.end_cursor;
  }
  return messages;
}

/** Convert official v3 SessionMessage user messages to matchable timestamps. */
export function extractUserPrompts(sessionId, messages) {
  const id = String(sessionId);
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.source === 'user' && Number.isInteger(message.created_at))
    .map((message) => ({ at: message.created_at * 1000, session_id: id }));
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function promptKey(prompt) {
  const at = timestampMs(prompt?.at);
  const sessionId = prompt?.session_id == null ? '' : String(prompt.session_id);
  return at == null || !sessionId ? null : `${at}:${sessionId}`;
}

/** Return new, deduplicated user prompts that fall within any supplied gap. */
export function matchPromptsToGaps(prompts, gaps, existingLog = []) {
  const seen = new Set((Array.isArray(existingLog) ? existingLog : []).map(promptKey).filter(Boolean));
  const matches = [];
  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    const at = timestampMs(prompt?.at);
    const key = promptKey(prompt);
    if (at == null || !key || seen.has(key)) continue;
    const insideGap = (Array.isArray(gaps) ? gaps : []).some((gap) => {
      const started = timestampMs(gap?.started_at ?? gap?.start);
      const ended = gap?.ended_at ?? gap?.end;
      const endedMs = ended == null ? Infinity : timestampMs(ended);
      return started != null && endedMs != null && at >= started && at <= endedMs;
    });
    if (!insideGap) continue;
    seen.add(key);
    matches.push({ at: new Date(at).toISOString(), session_id: String(prompt.session_id) });
  }
  return matches;
}

async function pollTeamPrompts(team, gaps) {
  const starts = gaps
    .map((gap) => timestampMs(gap.started_at))
    .filter((at) => at != null);
  if (!starts.length) return;
  const sinceMs = Math.min(Date.now() - GAP_LOOKBACK_MS, ...starts);
  const sessions = await listSessions(team.devin_api_key, team.devin_org_id, sinceMs);
  const prompts = [];
  const sessionList = sessions.filter((session) => session?.session_id);
  for (let i = 0; i < sessionList.length; i += 5) {
    const batch = sessionList.slice(i, i + 5);
    const messages = await Promise.all(
      batch.map(async (session) => ({
        sessionId: session.session_id,
        messages: await listSessionMessages(team.devin_api_key, team.devin_org_id, session.session_id),
      }))
    );
    for (const result of messages) prompts.push(...extractUserPrompts(result.sessionId, result.messages));
  }

  for (const gap of gaps) {
    const matches = matchPromptsToGaps(prompts, [gap], gap.prompt_log);
    if (!matches.length) continue;
    await pool.query(
      `UPDATE infractions
          SET prompt_count = prompt_count + $1,
              prompt_log = COALESCE(prompt_log, '[]'::jsonb) || $2::jsonb
        WHERE id = $3`,
      [matches.length, JSON.stringify(matches), gap.id]
    );
  }
}

async function pollOnce() {
  const { rows: events } = await pool.query('SELECT * FROM events');
  for (const event of events) {
    if (!eventConfig(event).idleMonitor || eventStatus(event) !== 'live') continue;
    const { rows: teams } = await pool.query(
      `SELECT id, devin_org_id, devin_api_key
         FROM teams
        WHERE event_id = $1
          AND devin_org_id IS NOT NULL AND devin_org_id <> ''
          AND devin_api_key IS NOT NULL AND devin_api_key <> ''`,
      [event.id]
    );
    for (const team of teams) {
      const { rows: gaps } = await pool.query(
        `SELECT id, started_at, ended_at, prompt_log
           FROM infractions
          WHERE event_id = $1 AND team_id = $2 AND NOT dismissed
            AND (ended_at IS NULL OR ended_at >= now() - interval '10 minutes')
          ORDER BY started_at`,
        [event.id, team.id]
      );
      if (!gaps.length) continue;
      try {
        await pollTeamPrompts(team, gaps);
      } catch (err) {
        console.error(`devin prompt poll team ${team.id}:`, err.message);
      }
    }
  }
}

export function startDevinPromptPoller(intervalMs = 60_000) {
  const run = () => pollOnce().catch((err) => console.error('devin prompt poller:', err.message));
  console.log(`Devin prompt poller: every ${Math.round(intervalMs / 1000)}s`);
  run();
  setInterval(run, intervalMs);
}
