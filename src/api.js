import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, eventConfig, eventStatus, teamScore } from './db.js';
import { parseRepo } from './github.js';
import { fetchSelf } from './devin.js';

const router = Router();

// Body values destined for integer columns: returns a safe int or null —
// never NaN/garbage that Postgres would throw on (see the /team/test crash).
function intOr(v, fallback = null) {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) < 2_000_000_000 ? n : fallback;
}


// Numeric id params must actually be numeric — otherwise Postgres throws on
// the integer cast (and a junk URL must never become a 500, let alone worse).
for (const p of ['teamId', 'deviceId']) {
  router.param(p, (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : res.status(404).json({ error: 'not found' })));
}

// Light per-IP limit on the public write endpoints (member/device creation,
// device activation) — enough to stop scripted spam without touching real use.
const writeBuckets = new Map();
function publicWriteLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let b = writeBuckets.get(ip);
  if (!b || now - b.start > 60_000) {
    b = { start: now, count: 0 };
    writeBuckets.set(ip, b);
  }
  if (++b.count > 30) return res.status(429).json({ error: 'slow down' });
  next();
}

// Public list of events for the landing page: PUBLISHED events only.
// Drafts stay reachable at their direct URLs (for private testing) but are
// never listed publicly; admins see everything in /admin.
router.get('/events', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY start_at DESC NULLS LAST, created_at DESC');
  res.json(
    rows
      .filter((e) => e.published)
      .map((e) => ({
        slug: e.slug,
        name: e.name,
        status: eventStatus(e),
        startAt: e.start_at,
        endAt: e.end_at,
      }))
  );
});

// Public event info for the join page: teams to pick from, no member data.
router.get('/:slug/info', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, slug, name FROM events WHERE slug = $1',
    [req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const teams = await pool.query(
    `SELECT id, name, (repo_url IS NOT NULL AND repo_url <> '') AS has_repo,
            (devin_api_key IS NOT NULL AND devin_api_key <> '') AS has_devin
       FROM teams WHERE event_id = $1 ORDER BY name`,
    [rows[0].id]
  );
  res.json({ slug: rows[0].slug, name: rows[0].name, teams: teams.rows });
});

// Register a person on a team (once — devices are registered separately).
router.post('/:slug/members', publicWriteLimit, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  const event = rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });

  const teamId = intOr(req.body.teamId);
  const { name } = req.body;
  if (!teamId || !name?.trim()) return res.status(400).json({ error: 'teamId and name required' });

  const team = await pool.query('SELECT id, devin_api_key FROM teams WHERE id = $1 AND event_id = $2', [
    teamId,
    event.id,
  ]);
  if (!team.rows[0]) return res.status(404).json({ error: 'no such team in this event' });

  const devinKey = typeof req.body.devinKey === 'string' ? req.body.devinKey.trim() : '';
  let devinOrgId = null;
  if (devinKey && !team.rows[0].devin_api_key) {
    try {
      const self = await fetchSelf(devinKey);
      devinOrgId = self.org_id;
    } catch {
      return res.status(400).json({ error: 'Devin API key rejected by api.devin.ai — check it and try again' });
    }
  }

  // First runner to supply a repo sets the team's; after that it's admin-only.
  const { repoUrl } = req.body;
  if (repoUrl) {
    if (!parseRepo(repoUrl)) return res.status(400).json({ error: 'repoUrl must be a github.com repo' });
    await pool.query(
      "UPDATE teams SET repo_url = $1 WHERE id = $2 AND (repo_url IS NULL OR repo_url = '')",
      [repoUrl.trim(), teamId]
    );
  }
  if (devinKey && !team.rows[0].devin_api_key) {
    await pool.query(
      `UPDATE teams SET devin_org_id = $1, devin_api_key = $2, devin_status = NULL
        WHERE id = $3 AND (devin_api_key IS NULL OR devin_api_key = '')`,
      [devinOrgId, devinKey, teamId]
    );
  }

  const m = await pool.query(
    'INSERT INTO members (event_id, team_id, name) VALUES ($1, $2, $3) RETURNING id',
    [event.id, teamId, name.trim()]
  );
  res.json({ memberId: m.rows[0].id });
});

// Register a tracking device for a team, optionally linked to a person.
// Returns the token that becomes Traccar's device identifier — pings with it
// map back to team (+ person) server-side.
router.post('/:slug/devices', publicWriteLimit, async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  const event = rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });
  const teamId = intOr(req.body.teamId);
  const memberId = req.body.memberId ? intOr(req.body.memberId) : null;
  const { name = null } = req.body;
  if (!teamId || (req.body.memberId && memberId == null)) return res.status(400).json({ error: 'numeric teamId (and memberId) required' });
  const team = await pool.query('SELECT id FROM teams WHERE id = $1 AND event_id = $2', [teamId, event.id]);
  if (!team.rows[0]) return res.status(404).json({ error: 'no such team in this event' });
  if (memberId) {
    const m = await pool.query('SELECT id FROM members WHERE id = $1 AND team_id = $2', [memberId, teamId]);
    if (!m.rows[0]) return res.status(404).json({ error: 'no such member on this team' });
  }
  const token = crypto.randomBytes(12).toString('base64url');
  await pool.query(
    'INSERT INTO devices (event_id, team_id, member_id, token, name) VALUES ($1, $2, $3, $4, $5)',
    [event.id, teamId, memberId, token, name?.trim() || null]
  );
  res.json({ token });
});

// Join-page poll: has the first Traccar fix landed yet?
router.get('/device/:token/status', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.activated_at, d.lap_count, d.last_fix, d.id = t.active_device_id AS is_active
       FROM devices d JOIN teams t ON t.id = d.team_id WHERE d.token = $1`,
    [req.params.token]
  );
  const d = rows[0];
  if (!d) return res.status(404).json({ error: 'unknown id' });
  res.json({
    activated: !!d.activated_at,
    active: !!d.is_active,
    laps: d.lap_count,
    lastFixAgoS: d.last_fix?.at ? Math.round((Date.now() - d.last_fix.at) / 1000) : null,
  });
});

// Make a device the team's scoring tracker (used at multi-phone handovers).
// Takes the device id, not the token: switching trackers is a visible,
// reversible action, but the token must stay ingest-only.
router.post('/devices/:deviceId/activate', publicWriteLimit, async (req, res) => {
  const { rows } = await pool.query('SELECT id, team_id FROM devices WHERE id = $1', [req.params.deviceId]);
  if (!rows[0]) return res.status(404).json({ error: 'unknown device' });
  await pool.query('UPDATE teams SET active_device_id = $1 WHERE id = $2', [rows[0].id, rows[0].team_id]);
  res.json({ ok: true });
});

// Team detail for the per-team page: roster with live status, no secrets.
router.get('/:slug/team/:teamId', async (req, res) => {
  const ev = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  const event = ev.rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });
  const t = await pool.query(
    `SELECT id, name, repo_url, repo_status, commit_count, commit_override, score_adjust, active_device_id,
            last_commit_msg, last_commit_author, last_commit_at, committers
       FROM teams WHERE id = $1 AND event_id = $2`,
    [req.params.teamId, event.id]
  );
  const team = t.rows[0];
  if (!team) return res.status(404).json({ error: 'no such team' });

  const members = await pool.query(
    `SELECT m.id, m.name, COALESCE(l.laps, 0) AS laps, l.best_s
       FROM members m
       LEFT JOIN (SELECT member_id, count(*) AS laps, min(seconds) AS best_s
                    FROM laps WHERE counted GROUP BY member_id) l
         ON l.member_id = m.id
      WHERE m.team_id = $1 ORDER BY m.created_at ASC`,
    [team.id]
  );
  const devices = await pool.query(
    `SELECT d.id, d.name, d.member_id, d.activated_at, d.last_fix, d.lap_count, d.token,
            m.name AS member_name
       FROM devices d LEFT JOIN members m ON m.id = d.member_id
      WHERE d.team_id = $1 ORDER BY d.created_at ASC`,
    [team.id]
  );
  const lapAgg = await pool.query(
    `SELECT count(*) FILTER (WHERE counted) AS valid,
            count(*) FILTER (WHERE NOT counted) AS invalid,
            avg(seconds) FILTER (WHERE counted) AS avg_s,
            min(seconds) FILTER (WHERE counted) AS best_s,
            (SELECT seconds FROM laps WHERE team_id = $1 AND counted
              ORDER BY finished_at DESC LIMIT 1) AS last_s
       FROM laps WHERE team_id = $1`,
    [team.id]
  );
  const config = eventConfig(event);
  const agg = lapAgg.rows[0];
  const paceDistM = config.officialTiming === 'exit_entry' ? config.timedSegmentM : config.lapM;
  const laps = Number(agg.valid);
  const km = +((laps * config.lapM) / 1000).toFixed(2);
  const commits = team.commit_override ?? (Number(team.commit_count) || 0);
  res.json({
    event: event.name,
    slug: event.slug,
    status: eventStatus(event),
    team: team.name,
    teamId: team.id,
    repo: team.repo_url || null,
    commits,
    committers: team.committers ?? null,
    lastCommit: team.last_commit_msg
      ? {
          message: team.last_commit_msg,
          author: team.last_commit_author,
          agoS: team.last_commit_at
            ? Math.round((Date.now() - new Date(team.last_commit_at).getTime()) / 1000)
            : null,
        }
      : null,
    laps,
    invalidLaps: Number(lapAgg.rows[0].invalid) || 0,
    km,
    lastLapS: agg.last_s != null ? Math.round(agg.last_s) : null,
    avgLapS: agg.avg_s != null ? Math.round(agg.avg_s) : null,
    bestLapS: agg.best_s != null ? Math.round(agg.best_s) : null,
    lastPaceSPerKm: agg.last_s != null ? Math.round(agg.last_s / (paceDistM / 1000)) : null,
    avgPaceSPerKm: agg.avg_s != null ? Math.round(agg.avg_s / (paceDistM / 1000)) : null,
    bestPaceSPerKm: agg.best_s != null ? Math.round(agg.best_s / (paceDistM / 1000)) : null,
    score: +(teamScore(km, commits, config) + Number(team.score_adjust || 0)).toFixed(2),
    readiness: {
      minMembers: config.minTeamSize,
      members: members.rows.length,
      devicesConnected: devices.rows.filter((d) => d.activated_at).length,
      githubConnected: team.repo_status === 'connected',
      repoSet: !!team.repo_url,
      ready:
        members.rows.length >= config.minTeamSize &&
        devices.rows.some((d) => d.activated_at) &&
        team.repo_status === 'connected',
    },
    members: members.rows.map((m) => ({
      id: m.id,
      name: m.name,
      laps: Number(m.laps),
      bestLapS: m.best_s != null ? Math.round(m.best_s) : null,
    })),
    devices: devices.rows.map((d) => ({
      // NB: never expose d.token here — the team page is public, and the token
      // is the ingest capability (leaking it lets anyone inject GPS for the team)
      id: d.id,
      label: d.member_name || d.name || 'Team device',
      active: d.id === team.active_device_id,
      connected: !!d.activated_at,
      laps: d.lap_count,
      lastPingAgoS: d.last_fix?.at ? Math.round((Date.now() - d.last_fix.at) / 1000) : null,
      battery: d.last_fix?.battery ?? null,
      charging: d.last_fix?.charging ?? null,
    })),
  });
});

// Public leaderboard. Poll every 2-5s. A 2s in-memory cache makes board load
// constant regardless of crowd size (clients poll at 3s; staleness invisible).
const boardCache = new Map(); // slug -> { at, body }
router.get('/:slug/board', async (req, res) => {
  const cached = boardCache.get(req.params.slug);
  if (!('fresh' in req.query) && cached && Date.now() - cached.at < 2000) return res.json(cached.body);
  const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  const event = rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });
  const config = eventConfig(event);

  const teams = await pool.query(
    `SELECT t.id, t.name, t.repo_url, t.commit_count, t.commit_override, t.score_adjust,
            t.last_commit_msg, t.last_commit_author, t.last_commit_at, t.committers,
            t.devin_sessions, t.devin_active, t.devin_msgs, t.devin_prs_open,
            t.devin_prs_merged, t.devin_acus, t.devin_checked_at,
            COALESCE(dm.name, ad.name, CASE WHEN ad.id IS NULL THEN NULL ELSE 'Team device' END) AS runner_name,
            ad.last_fix AS runner_last_fix,
            ll.seconds AS last_lap_s, ll.counted AS last_lap_valid, ll.reject_reason AS last_lap_reason,
            l.avg_s AS avg_lap_s,
            COALESCE(l.valid, 0) AS valid_laps, COALESCE(l.invalid, 0) AS invalid_laps,
            COALESCE(l.valid_then, 0) AS valid_laps_then
       FROM teams t
       LEFT JOIN devices ad ON ad.id = t.active_device_id
       LEFT JOIN members dm ON dm.id = ad.member_id
       LEFT JOIN (
         SELECT team_id,
                count(*) FILTER (WHERE counted) AS valid,
                count(*) FILTER (WHERE NOT counted) AS invalid,
                avg(seconds) FILTER (WHERE counted) AS avg_s,
                count(*) FILTER (WHERE counted AND finished_at < now() - interval '10 minutes') AS valid_then
           FROM laps WHERE event_id = $1 GROUP BY team_id
       ) l ON l.team_id = t.id
       LEFT JOIN LATERAL (
         SELECT seconds, counted, reject_reason FROM laps
          WHERE team_id = t.id ORDER BY finished_at DESC LIMIT 1
       ) ll ON true
      WHERE t.event_id = $1`,
    [event.id]
  );

  const paceDistM = config.officialTiming === 'exit_entry' ? config.timedSegmentM : config.lapM;
  const board = teams.rows
    .map((t) => {
      const laps = Number(t.valid_laps);
      const km = +((laps * config.lapM) / 1000).toFixed(2);
      const lapsThen = Number(t.valid_laps_then);
      const kmThen = +((lapsThen * config.lapM) / 1000).toFixed(2);
      const commits = t.commit_override ?? (Number(t.commit_count) || 0);
      const lastFixAgoS = t.runner_last_fix?.at
        ? Math.round((Date.now() - t.runner_last_fix.at) / 1000)
        : null;
      let status = 'idle';
      if (t.runner_name) status = lastFixAgoS != null && lastFixAgoS <= 30 ? 'running' : 'stopped';
      return {
        teamId: t.id,
        team: t.name,
        runner: t.runner_name || null,
        status,
        laps,
        invalidLaps: Number(t.invalid_laps),
        km,
        commits,
        repo: t.repo_url || null,
        devin: t.devin_checked_at
          ? {
              sessions: Number(t.devin_sessions),
              active: Number(t.devin_active),
              msgs: Number(t.devin_msgs),
              prsOpen: Number(t.devin_prs_open),
              prsMerged: Number(t.devin_prs_merged),
              acus: Number(t.devin_acus),
            }
          : null,
        committers: t.committers ?? null,
        lastCommit: t.last_commit_msg
          ? {
              message: t.last_commit_msg,
              author: t.last_commit_author,
              agoS: t.last_commit_at
                ? Math.round((Date.now() - new Date(t.last_commit_at).getTime()) / 1000)
                : null,
            }
          : null,
        score: +(teamScore(km, commits, config) + Number(t.score_adjust || 0)).toFixed(2),
        scoreThen: +(teamScore(kmThen, commits, config) + Number(t.score_adjust || 0)).toFixed(2),
        kmThen,
        lastLap: t.last_lap_s != null
          ? {
              seconds: Math.round(t.last_lap_s),
              valid: t.last_lap_valid,
              reason: t.last_lap_reason,
              paceSPerKm: t.last_lap_valid ? Math.round(t.last_lap_s / (paceDistM / 1000)) : null,
            }
          : null,
        avgLap: t.avg_lap_s != null
          ? {
              seconds: Math.round(t.avg_lap_s),
              paceSPerKm: Math.round(t.avg_lap_s / (paceDistM / 1000)),
            }
          : null,
        paceSPerKm:
          t.last_lap_s != null && t.last_lap_valid
            ? Math.round(t.last_lap_s / (paceDistM / 1000))
            : null,
        lastPingAgoS: lastFixAgoS,
      };
    })
    .sort((a, b) => b.score - a.score || b.km - a.km || a.team.localeCompare(b.team));

  // Rank movement vs 10 minutes ago, derived from the laps log (stateless:
  // survives reloads and is identical on every screen). Commits use current
  // values for both rankings, so movement reflects running.
  const then = [...board].sort((a, b) => b.scoreThen - a.scoreThen || b.kmThen - a.kmThen || a.team.localeCompare(b.team));
  const rankThen = new Map(then.map((t, i) => [t.teamId, i]));
  board.forEach((t, i) => {
    const was = rankThen.get(t.teamId);
    t.move = was > i ? 'up' : was < i ? 'down' : null;
    delete t.scoreThen;
    delete t.kmThen;
  });

  const body = {
    event: event.name,
    slug: event.slug,
    lapM: config.lapM,
    scoreFormula: config.scoreFormula,
    status: eventStatus(event),
    startAt: event.start_at,
    endAt: event.end_at,
    serverNow: new Date().toISOString(),
    teams: board,
  };
  boardCache.set(req.params.slug, { at: Date.now(), body });
  res.json(body);
});

export default router;
