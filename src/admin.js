import { Router } from 'express';
import { pool } from './db.js';
import { countCommits, pollOnce } from './github.js';
import { readIngestLog, clearIngestLog } from './ingestLog.js';

const router = Router();

// Body values destined for integer columns: returns a safe int or null —
// never NaN/garbage that Postgres would throw on (see the /team/test crash).
function intOr(v, fallback = null) {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) < 2_000_000_000 ? n : fallback;
}


for (const p of ['teamId', 'deviceId', 'memberId', 'lapId']) {
  router.param(p, (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : res.status(404).json({ error: 'not found' })));
}

router.use((req, res, next) => {
  const key = req.headers.authorization?.replace(/^Bearer /, '') || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'bad admin key' });
  }
  next();
});

// Live ingest debug log (in-memory, newest first) — for testing Traccar.
router.get('/ingest-log', (req, res) => {
  res.json(readIngestLog());
});
router.post('/ingest-log/clear', (req, res) => {
  clearIngestLog();
  res.json({ ok: true });
});

// Stored-GPS health check: what actually landed in the points table, per
// device — proves storage/parsing worked, not just that requests arrived.
router.get('/events/:slug/points-summary', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, COALESCE(m.name, d.name, 'Team device') AS label, t.name AS team,
            count(p.id)::int AS points,
            min(p.fixed_at) AS first_fix, max(p.fixed_at) AS last_fix,
            round(avg(p.accuracy_m)::numeric, 1) AS avg_acc,
            max(p.accuracy_m) AS worst_acc,
            count(*) FILTER (WHERE p.accuracy_m IS NULL)::int AS null_acc,
            count(*) FILTER (WHERE p.speed_ms IS NOT NULL)::int AS with_speed,
            count(*) FILTER (WHERE p.fixed_at > p.received_at + interval '1 minute')::int AS future_ts
       FROM devices d
       JOIN teams t ON t.id = d.team_id
       LEFT JOIN members m ON m.id = d.member_id
       LEFT JOIN points p ON p.device_id = d.id
      WHERE d.event_id = (SELECT id FROM events WHERE slug = $1)
      GROUP BY d.id, label, t.name
      ORDER BY points DESC`,
    [req.params.slug]
  );
  res.json(rows);
});

// Raw recent points for a device — eyeball exactly what was stored.
router.get('/devices/:deviceId/points', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT lat, lng, accuracy_m, speed_ms, fixed_at, received_at
       FROM points WHERE device_id = $1 ORDER BY id DESC LIMIT 50`,
    [req.params.deviceId]
  );
  res.json(rows);
});

// Event-scoped view of the ingest log: this event's device pings, plus every
// unmatched attempt (unknown token, missing token, /ingest-test) — those are
// the failures you're debugging, so they show everywhere.
router.get('/events/:slug/ingest-log', async (req, res) => {
  const entries = readIngestLog();
  const tokens = [...new Set(entries.map((e) => e.token).filter(Boolean))];
  let byToken = new Map();
  if (tokens.length) {
    const { rows } = await pool.query(
      `SELECT d.token, t.name AS team, COALESCE(m.name, d.name, 'Team device') AS label, e.slug
         FROM devices d
         JOIN teams t ON t.id = d.team_id
         JOIN events e ON e.id = d.event_id
         LEFT JOIN members m ON m.id = d.member_id
        WHERE d.token = ANY($1)`,
      [tokens]
    );
    byToken = new Map(rows.map((r) => [r.token, r]));
  }
  res.json(
    entries
      .map((e) => {
        const d = e.token ? byToken.get(e.token) : null;
        if (e.test) return { ...e, match: 'test' };
        if (!e.token) return { ...e, match: 'no_token' };
        if (!d) return { ...e, match: 'unknown_token' };
        if (d.slug !== req.params.slug) return null; // another event's traffic
        return { ...e, match: 'device', team: d.team, label: d.label };
      })
      .filter(Boolean)
  );
});

router.get('/events', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/events', async (req, res) => {
  const { slug, name, zones = [], config = {}, startAt = null, endAt = null } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug: lowercase, digits, dashes' });
  const { rows } = await pool.query(
    `INSERT INTO events (slug, name, zones, config, start_at, end_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET name = $2, zones = $3, config = $4, start_at = $5, end_at = $6
     RETURNING *`,
    [slug, name, JSON.stringify(zones), JSON.stringify(config), startAt, endAt]
  );
  res.json(rows[0]);
});

router.get('/events/:slug', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const teams = await pool.query(
    `SELECT t.*,
            (SELECT count(*) FROM members m WHERE m.team_id = t.id) AS member_count,
            (SELECT count(*) FROM devices d WHERE d.team_id = t.id AND d.activated_at IS NOT NULL) AS connected_count
       FROM teams t WHERE t.event_id = $1 ORDER BY t.name`,
    [rows[0].id]
  );
  res.json({ ...rows[0], teams: teams.rows });
});

router.post('/events/:slug/teams', async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const team = await pool.query(
    `INSERT INTO teams (event_id, name) VALUES ($1, $2)
     ON CONFLICT (event_id, name) DO UPDATE SET name = $2 RETURNING *`,
    [rows[0].id, name]
  );
  res.json(team.rows[0]);
});

// Event lifecycle: start_now / end_now / pause / resume.
router.post('/events/:slug/control', async (req, res) => {
  const { action } = req.body;
  const sql = {
    // start_now also clears an already-elapsed end time, so it can restart an
    // event that was ended by mistake (a future end time is kept).
    start_now: `UPDATE events SET start_at = now(), paused_at = NULL,
                end_at = CASE WHEN end_at <= now() THEN NULL ELSE end_at END
                WHERE slug = $1 RETURNING *`,
    end_now: 'UPDATE events SET end_at = now(), paused_at = NULL WHERE slug = $1 RETURNING *',
    pause: 'UPDATE events SET paused_at = now() WHERE slug = $1 RETURNING *',
    resume: 'UPDATE events SET paused_at = NULL WHERE slug = $1 RETURNING *',
    // draft <-> live: only published events appear on the public landing
    publish: 'UPDATE events SET published = true WHERE slug = $1 RETURNING *',
    unpublish: 'UPDATE events SET published = false WHERE slug = $1 RETURNING *',
  }[action];
  if (!sql) return res.status(400).json({ error: 'action: start_now | end_now | pause | resume | publish | unpublish' });
  const { rows } = await pool.query(sql, [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  res.json(rows[0]);
});

// Rename an event's slug. All data hangs off the event id so nothing else
// moves — but every URL containing the slug changes (QRs, board links).
router.post('/events/:slug/rename-slug', async (req, res) => {
  const newSlug = String(req.body.newSlug || '').trim();
  if (!/^[a-z0-9-]+$/.test(newSlug)) return res.status(400).json({ error: 'slug: lowercase, digits, dashes' });
  const clash = await pool.query('SELECT 1 FROM events WHERE slug = $1', [newSlug]);
  if (clash.rows[0]) return res.status(409).json({ error: 'that slug is already taken' });
  const { rows } = await pool.query('UPDATE events SET slug = $1 WHERE slug = $2 RETURNING *', [
    newSlug, req.params.slug,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  res.json(rows[0]);
});

// Recent laps for a team — for the valid/invalid review panel.
router.get('/events/:slug/teams/:teamId/laps', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.seconds, l.counted, l.reject_reason, l.manual, l.finished_at,
            l.entry_seconds, l.gate_seconds, m.name AS runner
       FROM laps l LEFT JOIN members m ON m.id = l.member_id
      WHERE l.team_id = $1 AND l.event_id = (SELECT id FROM events WHERE slug = $2)
      ORDER BY l.finished_at DESC LIMIT 50`,
    [req.params.teamId, req.params.slug]
  );
  res.json(rows);
});

// Idle infractions ("nobody sits down" violations) for dispute review.
router.get('/events/:slug/teams/:teamId/infractions', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, started_at, ended_at, seconds, dismissed, prompt_count, prompt_log
       FROM infractions
      WHERE team_id = $1 AND event_id = (SELECT id FROM events WHERE slug = $2)
      ORDER BY started_at DESC LIMIT 100`,
    [req.params.teamId, req.params.slug]
  );
  res.json(rows);
});

// Dismiss (or reinstate) an infraction — e.g. GPS dropout, agreed dispute.
router.patch('/infractions/:id(\\d+)', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE infractions SET dismissed = $1 WHERE id = $2 RETURNING *',
    [!!req.body.dismissed, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such infraction' });
  res.json(rows[0]);
});

// Manually credit laps to a team (attributed to the active runner if any).
router.post('/events/:slug/teams/:teamId/laps', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const team = await pool.query(
    `SELECT t.id, d.member_id AS active_member_id, d.id AS active_device_id
       FROM teams t LEFT JOIN devices d ON d.id = t.active_device_id
      WHERE t.id = $1 AND t.event_id = $2`,
    [req.params.teamId, ev.rows[0].id]
  );
  if (!team.rows[0]) return res.status(404).json({ error: 'no such team' });
  const count = Math.min(50, Math.max(1, Math.round(Number(req.body.count) || 1)));
  const seconds = Number(req.body.seconds) || 0;
  const inserted = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await pool.query(
      `INSERT INTO laps (event_id, team_id, member_id, device_id, seconds, counted, manual)
       VALUES ($1, $2, $3, $4, $5, true, true) RETURNING id`,
      [ev.rows[0].id, team.rows[0].id, team.rows[0].active_member_id, team.rows[0].active_device_id, seconds]
    );
    inserted.push(rows[0].id);
  }
  res.json({ ok: true, inserted });
});

// Edit a lap: flip valid/invalid and/or correct its time.
router.patch('/laps/:lapId', async (req, res) => {
  const sets = [];
  const vals = [];
  if ('counted' in req.body) {
    vals.push(!!req.body.counted);
    sets.push(`counted = $${vals.length}`,
      `reject_reason = CASE WHEN $${vals.length} THEN NULL ELSE 'admin_removed' END`);
  }
  if ('seconds' in req.body) {
    vals.push(Math.max(0, Number(req.body.seconds) || 0));
    sets.push(`seconds = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.lapId);
  const { rows } = await pool.query(
    `UPDATE laps SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such lap' });
  res.json(rows[0]);
});

// People roster: names + attributed laps.
router.get('/events/:slug/members', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.team_id, t.name AS team,
            COALESCE(l.laps, 0) AS laps
       FROM members m JOIN teams t ON t.id = m.team_id
       LEFT JOIN (SELECT member_id, count(*) AS laps FROM laps WHERE counted GROUP BY member_id) l
         ON l.member_id = m.id
      WHERE m.event_id = (SELECT id FROM events WHERE slug = $1)
      ORDER BY t.name, m.created_at ASC`,
    [req.params.slug]
  );
  res.json(rows);
});

// Devices roster: connection freshness + positions, for ops and the map.
router.get('/events/:slug/devices', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.token, d.name, d.member_id, d.team_id, d.activated_at, d.lap_count, d.last_fix,
            t.name AS team, m.name AS member_name, d.id = t.active_device_id AS is_active
       FROM devices d JOIN teams t ON t.id = d.team_id
       LEFT JOIN members m ON m.id = d.member_id
      WHERE d.event_id = (SELECT id FROM events WHERE slug = $1)
      ORDER BY t.name, d.created_at ASC`,
    [req.params.slug]
  );
  res.json(rows.map((d) => ({
    ...d,
    lastPingAgoS: d.last_fix?.at ? Math.round((Date.now() - d.last_fix.at) / 1000) : null,
    lat: d.last_fix?.lat ?? null,
    lng: d.last_fix?.lng ?? null,
    battery: d.last_fix?.battery ?? null,
    charging: d.last_fix?.charging ?? null,
    speedMs: d.last_fix?.speedMs ?? null,
    last_fix: undefined,
  })));
});

// Device management: relabel, relink to a person, make it the scoring
// tracker, clear a stuck lap state, or remove it.
router.patch('/devices/:deviceId', async (req, res) => {
  const d = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);
  if (!d.rows[0]) return res.status(404).json({ error: 'no such device' });
  if ('name' in req.body) {
    await pool.query('UPDATE devices SET name = $1 WHERE id = $2', [req.body.name?.trim() || null, d.rows[0].id]);
  }
  if ('memberId' in req.body) {
    const mid = req.body.memberId ? intOr(req.body.memberId) : null;
    if (req.body.memberId && mid == null) return res.status(400).json({ error: 'memberId must be a number' });
    if (mid) {
      const m = await pool.query('SELECT id FROM members WHERE id = $1 AND team_id = $2', [mid, d.rows[0].team_id]);
      if (!m.rows[0]) return res.status(404).json({ error: 'no such member on this team' });
    }
    await pool.query('UPDATE devices SET member_id = $1 WHERE id = $2', [mid, d.rows[0].id]);
  }
  res.json({ ok: true });
});
router.post('/devices/:deviceId/activate', async (req, res) => {
  const d = await pool.query('SELECT id, team_id FROM devices WHERE id = $1', [req.params.deviceId]);
  if (!d.rows[0]) return res.status(404).json({ error: 'no such device' });
  await pool.query('UPDATE teams SET active_device_id = $1 WHERE id = $2', [d.rows[0].id, d.rows[0].team_id]);
  res.json({ ok: true });
});
router.post('/devices/:deviceId/reset-state', async (req, res) => {
  await pool.query("UPDATE devices SET state = '{}' WHERE id = $1", [req.params.deviceId]);
  res.json({ ok: true });
});
router.delete('/devices/:deviceId', async (req, res) => {
  await pool.query('UPDATE teams SET active_device_id = NULL WHERE active_device_id = $1', [req.params.deviceId]);
  await pool.query('DELETE FROM devices WHERE id = $1', [req.params.deviceId]);
  res.json({ ok: true });
});

// Wipe race data (laps, members, points) after a rehearsal. Teams, repos, and
// event config survive.
router.post('/events/:slug/reset', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const id = ev.rows[0].id;
  await pool.query('DELETE FROM points WHERE device_id IN (SELECT id FROM devices WHERE event_id = $1)', [id]);
  await pool.query('DELETE FROM laps WHERE event_id = $1', [id]);
  await pool.query('UPDATE teams SET active_device_id = NULL WHERE event_id = $1', [id]);
  await pool.query('DELETE FROM devices WHERE event_id = $1', [id]);
  await pool.query('DELETE FROM members WHERE event_id = $1', [id]);
  res.json({ ok: true });
});

// Partial team update: rename, repo, commit override (null clears), score adjust.
router.patch('/events/:slug/teams/:teamId', async (req, res) => {
  const sets = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
  if ('name' in req.body) {
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    add('name = ?', req.body.name.trim());
  }
  if ('repoUrl' in req.body) {
    add('repo_url = ?', req.body.repoUrl || null);
    add('repo_status = ?', null); // unknown until tested/polled again
    if (!req.body.repoUrl) add('commit_count = ?', 0);
  }
  if ('commitOverride' in req.body) {
    const v = req.body.commitOverride;
    add('commit_override = ?', v === null || v === '' ? null : Math.max(0, intOr(Math.round(Number(v)), 0)));
  }
  if ('scoreAdjust' in req.body) add('score_adjust = ?', Number(req.body.scoreAdjust) || 0);
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.teamId, req.params.slug);
  const { rows } = await pool.query(
    `UPDATE teams SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND event_id = (SELECT id FROM events WHERE slug = $${vals.length})
      RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such team' });
  res.json(rows[0]);
});

// Test a team's GitHub connection right now: reachable, public, and counts
// commits in the event window. Persists the verdict.
router.post('/events/:slug/teams/:teamId/check-repo', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.repo_url, e.start_at, e.end_at, e.created_at
       FROM teams t JOIN events e ON e.id = t.event_id
      WHERE t.id = $1 AND e.slug = $2`,
    [req.params.teamId, req.params.slug]
  );
  const t = rows[0];
  if (!t) return res.status(404).json({ error: 'no such team' });
  if (!t.repo_url) return res.json({ status: 'not_set' });
  const since = (t.start_at || t.created_at)?.toISOString?.();
  const until = t.end_at?.toISOString?.();
  const count = await countCommits(t.repo_url, since, until).catch(() => null);
  const status = count == null ? 'error' : 'connected';
  await pool.query(
    `UPDATE teams SET repo_status = $1,
            commit_count = COALESCE($2, commit_count),
            commits_checked_at = CASE WHEN $2 IS NULL THEN commits_checked_at ELSE now() END
      WHERE id = $3`,
    [status, count, t.id]
  );
  res.json({ status, commits: count });
});

// ---- Member surgery: everything a marshal might need to fix on the day ----

// Rename or move a member to another team (optionally taking their laps along).
router.patch('/members/:memberId', async (req, res) => {
  const m = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.memberId]);
  const member = m.rows[0];
  if (!member) return res.status(404).json({ error: 'no such member' });
  if ('name' in req.body && req.body.name?.trim()) {
    await pool.query('UPDATE members SET name = $1 WHERE id = $2', [req.body.name.trim(), member.id]);
  }
  if ('teamId' in req.body && intOr(req.body.teamId) !== member.team_id) {
    if (intOr(req.body.teamId) == null) return res.status(400).json({ error: 'teamId must be a number' });
    const t = await pool.query('SELECT id FROM teams WHERE id = $1 AND event_id = $2', [
      intOr(req.body.teamId), member.event_id,
    ]);
    if (!t.rows[0]) return res.status(404).json({ error: 'no such team in this event' });
    await pool.query('UPDATE members SET team_id = $1 WHERE id = $2', [t.rows[0].id, member.id]);
    // devices linked to them follow, unless they were a team's scoring device
    await pool.query('UPDATE teams SET active_device_id = NULL WHERE active_device_id IN (SELECT id FROM devices WHERE member_id = $1)', [member.id]);
    await pool.query('UPDATE devices SET team_id = $1 WHERE member_id = $2', [t.rows[0].id, member.id]);
    if (req.body.moveLaps) {
      await pool.query('UPDATE laps SET team_id = $1 WHERE member_id = $2', [t.rows[0].id, member.id]);
    }
  }
  res.json({ ok: true });
});

// Remove a member (mis-join, duplicate). Their laps stay with the team,
// unattributed; their devices become team devices.
router.delete('/members/:memberId', async (req, res) => {
  await pool.query('UPDATE laps SET member_id = NULL WHERE member_id = $1', [req.params.memberId]);
  await pool.query('DELETE FROM members WHERE id = $1', [req.params.memberId]); // devices: member_id -> NULL via FK
  res.json({ ok: true });
});

// Populate this event with realistic live-race test data: dates moved to
// mid-race, test teams with people + devices, a filled leaderboard, live-ish
// positions, and busy public repos so the commit poller returns real numbers.
router.post('/events/:slug/populate-test', async (req, res) => {
  const ev = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  const event = ev.rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });

  // Mid-race: started 4h ago, ends in 4h.
  await pool.query(
    `UPDATE events SET start_at = now() - interval '4 hours',
            end_at = now() + interval '4 hours', paused_at = NULL WHERE id = $1`,
    [event.id]
  );
  const startMs = Date.now() - 4 * 3600e3;

  // Base point for fake positions: first zone's first corner, else the track.
  const base = event.zones?.[0]?.polygon?.[0] || [51.5388, -0.0166];

  // Busy public repos -> real commits inside a 4h window; 30 distinct repos
  // makes GitHub polling load realistic at full event scale.
  const TEAM_NAMES = [
    'Bit Runners', 'Ctrl Alt Elite', 'Fork & Sprint', 'Push It Real Good', 'Segfault Striders',
    'Race Condition', 'The Long Pollers', 'Git Outta Here', 'Cache Me Outside', 'Sprint Boot',
    'Runtime Terrors', 'Async Athletes', 'The Marathon Mergers', 'Hot Reloaders', 'Loop Unrollers',
    'Tail Callers', 'The Breakpoints', 'Jog Scheduler', 'Fast Fourier Transforms', 'Heap Sprinters',
    'The Idempotents', 'Lap Reduce', 'Branch Predictors', 'Sweaty Palindromes', 'The Deadlocks',
    'Pace Invaders', 'Off By One Mile', 'The Garbage Collectors', 'Quantum Sprinters', 'Null Pace Exception',
  ];
  const REPOS = [
    'NixOS/nixpkgs', 'microsoft/vscode', 'home-assistant/core', 'llvm/llvm-project', 'godotengine/godot',
    'rust-lang/rust', 'python/cpython', 'kubernetes/kubernetes', 'torvalds/linux', 'nodejs/node',
    'facebook/react', 'flutter/flutter', 'microsoft/TypeScript', 'git/git', 'golang/go',
    'apache/spark', 'elastic/elasticsearch', 'grafana/grafana', 'ansible/ansible', 'odoo/odoo',
    'zephyrproject-rtos/zephyr', 'WebKit/WebKit', 'dotnet/runtime', 'JuliaLang/julia', 'ClickHouse/ClickHouse',
    'cockroachdb/cockroach', 'DefinitelyTyped/DefinitelyTyped', 'angular/angular', 'vercel/next.js', 'pytorch/pytorch',
  ];
  const teamCount = Math.min(TEAM_NAMES.length, Math.max(1, Math.round(Number(req.body?.teams) || 5)));
  const TEAMS = TEAM_NAMES.slice(0, teamCount).map((name, i) => ({
    name, repo: `https://github.com/${REPOS[i % REPOS.length]}`,
  }));
  const NAMES = ['Maya', 'Jonas', 'Priya', 'Tom', 'Ada', 'Leo', 'Zoe', 'Kai', 'Nina', 'Omar',
    'Ella', 'Finn', 'Ruth', 'Igor', 'Sana', 'Hugo', 'Iris', 'Noah', 'Lena', 'Ezra'];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const created = { teams: 0, members: 0, devices: 0, laps: 0 };
  let nameIdx = 0;

  for (let ti = 0; ti < TEAMS.length; ti++) {
    const spec = TEAMS[ti];
    const t = await pool.query(
      `INSERT INTO teams (event_id, name, repo_url) VALUES ($1, $2, $3)
       ON CONFLICT (event_id, name) DO UPDATE SET repo_url = $3 RETURNING id`,
      [event.id, spec.name, spec.repo]
    );
    const teamId = t.rows[0].id;
    created.teams++;

    // 3-4 people, each with a phone; plus a shared team phone for one team.
    const memberCount = 3 + (ti % 2);
    const members = [];
    for (let i = 0; i < memberCount; i++) {
      const m = await pool.query(
        'INSERT INTO members (event_id, team_id, name) VALUES ($1, $2, $3) RETURNING id, name',
        [event.id, teamId, NAMES[nameIdx++ % NAMES.length]]
      );
      members.push(m.rows[0]);
      created.members++;
    }
    const devices = [];
    for (const m of members) {
      const token = 'test_' + Math.random().toString(36).slice(2, 14);
      // Freshness variety: team 0 healthy, team 1 signal-lost, others mixed.
      const agoS = ti === 1 ? 300 : Math.round(rnd(3, ti === 2 ? 90 : 25));
      const d = await pool.query(
        `INSERT INTO devices (event_id, team_id, member_id, token, name, activated_at, last_fix, lap_count)
         VALUES ($1, $2, $3, $4, $5, now() - interval '3 hours', $6, 0) RETURNING id`,
        [event.id, teamId, m.id, token, m.name,
          { lat: base[0] + rnd(-0.0004, 0.0004), lng: base[1] + rnd(-0.0006, 0.0006),
            accuracyM: Math.round(rnd(5, 15)), at: Date.now() - agoS * 1000 }]
      );
      devices.push({ id: d.rows[0].id, memberId: m.id });
      created.devices++;
    }
    await pool.query('UPDATE teams SET active_device_id = $1 WHERE id = $2', [devices[0].id, teamId]);

    // Laps across the elapsed 4h: different volumes per team, mostly valid,
    // sprinkled invalids, attributed round-robin across the roster.
    const lapCount = 15 + (ti % 10) * 6 + Math.round(rnd(0, 8));
    const elapsed = Date.now() - startMs;
    const deviceLaps = new Map();
    for (let i = 0; i < lapCount; i++) {
      const at = new Date(startMs + (elapsed * (i + 0.5)) / lapCount + rnd(-30e3, 30e3));
      const secs = rnd(62, 98);
      const bad = Math.random() < 0.12;
      const reason = bad ? ['too_slow', 'too_fast', 'too_soon'][Math.floor(rnd(0, 3))] : null;
      const who = devices[i % devices.length];
      await pool.query(
        `INSERT INTO laps (event_id, team_id, member_id, device_id, seconds, counted, reject_reason,
                           entry_seconds, gate_seconds, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [event.id, teamId, who.memberId, who.id,
          bad && reason === 'too_slow' ? secs + 90 : secs, !bad, reason,
          secs + rnd(8, 16), Math.random() < 0.7 ? secs + rnd(-2, 2) : null, at]
      );
      if (!bad) deviceLaps.set(who.id, (deviceLaps.get(who.id) || 0) + 1);
      created.laps++;
    }
    for (const [devId, n] of deviceLaps) {
      await pool.query('UPDATE devices SET lap_count = $1, last_lap_s = $2 WHERE id = $3', [
        n, Math.round(rnd(65, 92)), devId,
      ]);
    }
  }

  // Pull real commit counts + latest commit lines for the new repos now.
  pollOnce().catch(() => {});

  res.json({ ok: true, ...created });
});

// Delete a whole event (old tests, duplicates). Everything under it goes.
router.delete('/events/:slug', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const id = ev.rows[0].id;
  await pool.query('DELETE FROM points WHERE device_id IN (SELECT id FROM devices WHERE event_id = $1)', [id]);
  await pool.query('DELETE FROM laps WHERE event_id = $1', [id]);
  await pool.query('DELETE FROM events WHERE id = $1', [id]); // teams/members/devices cascade
  res.json({ ok: true });
});

router.delete('/events/:slug/teams/:teamId', async (req, res) => {
  await pool.query(
    `DELETE FROM teams WHERE id = $1
       AND event_id = (SELECT id FROM events WHERE slug = $2)`,
    [req.params.teamId, req.params.slug]
  );
  res.json({ ok: true });
});

export default router;
