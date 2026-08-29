import { pool, eventConfig, eventStatus } from './db.js';

// "NOBODY SITS DOWN" monitoring: at every moment each team should have someone
// out running. A team counts as covered when any of its devices delivered a
// recent fix at running speed; when coverage lapses for longer than the grace
// window (default 15s) a durable gap is logged, and it closes when someone
// runs again. Devin prompts during gaps are counted by devinPrompts.js.

/** A device covers its team when its last fix is fresh and at running speed.
 *  A fix without speed (some trackers omit it) counts while fresh — better to
 *  under-flag than to punish a phone that doesn't report speed. */
export function deviceCovers(lastFix, nowMs, cfg) {
  if (!lastFix?.at) return false;
  if (nowMs - lastFix.at > cfg.coverageStaleS * 1000) return false;
  return lastFix.speedMs == null || lastFix.speedMs >= cfg.idleSpeedMs;
}

/** Pure per-team step. state: { lastCoveredAt, openSince } (ms epochs).
 *  Returns { state, open, close } where open/close carry the ms timestamps
 *  at which a gap starts (backdated to when the grace ran out) or ends. */
export function stepTeam(state, covered, nowMs, cfg) {
  const s = { ...state };
  let open = null;
  let close = null;
  if (covered) {
    if (s.openSince != null) {
      close = nowMs;
      s.openSince = null;
    }
    s.lastCoveredAt = nowMs;
  } else {
    if (s.lastCoveredAt == null) s.lastCoveredAt = nowMs; // first sighting: arm, don't punish
    const graceEndsAt = s.lastCoveredAt + cfg.idleGraceS * 1000;
    if (s.openSince == null && nowMs >= graceEndsAt) {
      open = graceEndsAt;
      s.openSince = graceEndsAt;
    }
  }
  return { state: s, open, close };
}

// slug -> Map(teamId -> { lastCoveredAt, openSince })
const eventState = new Map();

async function tick() {
  const { rows: events } = await pool.query('SELECT * FROM events');
  for (const event of events) {
    const cfg = eventConfig(event);
    if (!cfg.idleMonitor) continue;
    const live = eventStatus(event) === 'live';
    let teamsState = eventState.get(event.slug);
    if (!teamsState) {
      teamsState = new Map();
      eventState.set(event.slug, teamsState);
    }
    if (!live) {
      // pause/finish: close anything open, then stand down
      for (const [teamId, s] of teamsState) {
        if (s.openSince != null) {
          await closeInfraction(event.id, teamId, Date.now());
          s.openSince = null;
        }
        s.lastCoveredAt = null;
      }
      continue;
    }
    const { rows: teams } = await pool.query(
      `SELECT t.id, coalesce(json_agg(d.last_fix) FILTER (WHERE d.last_fix IS NOT NULL), '[]') AS fixes
         FROM teams t LEFT JOIN devices d ON d.team_id = t.id
        WHERE t.event_id = $1 GROUP BY t.id`,
      [event.id]
    );
    const nowMs = Date.now();
    for (const t of teams) {
      const covered = t.fixes.some((f) => deviceCovers(f, nowMs, cfg));
      const prev = teamsState.get(t.id) ?? { lastCoveredAt: null, openSince: null };
      // never punish a team that hasn't started at all (no fix ever seen)
      if (!covered && prev.lastCoveredAt == null && !t.fixes.some((f) => f?.at)) continue;
      const { state, open, close } = stepTeam(prev, covered, nowMs, cfg);
      teamsState.set(t.id, state);
      if (open != null) {
        await pool.query(
          `INSERT INTO infractions (event_id, team_id, started_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
          [event.id, t.id, open]
        );
      }
      if (close != null) await closeInfraction(event.id, t.id, close);
    }
  }
}

async function closeInfraction(eventId, teamId, endedMs) {
  await pool.query(
    `UPDATE infractions
        SET ended_at = to_timestamp($3 / 1000.0),
            seconds = extract(epoch FROM to_timestamp($3 / 1000.0) - started_at)
      WHERE event_id = $1 AND team_id = $2 AND ended_at IS NULL`,
    [eventId, teamId, endedMs]
  );
}

export function startIdleMonitor(intervalMs = 5000) {
  const run = () => tick().catch((err) => console.error('idle monitor:', err));
  run();
  setInterval(run, intervalMs);
}
