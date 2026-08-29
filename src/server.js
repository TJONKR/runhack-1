import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb, pool } from './db.js';
import adminRouter from './admin.js';
import apiRouter from './api.js';
import { ingestHandler } from './ingest.js';
import { startGithubPoller } from './github.js';
import { startIdleMonitor } from './idleMonitor.js';
import { startDevinPromptPoller } from './devinPrompts.js';
import { pushIngestLog } from './ingestLog.js';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// Backstop: Express 4 does not route async rejections to the error
// middleware, and an unhandled one kills the process — a full outage from
// one bad request. Log loudly, stay up.
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION (request likely hung):', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION (kept alive):', err));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// Catch-all text parser: whatever content-type a tracker sends, keep the raw
// body so the ingest log can show it and the fix parser can attempt it.
app.use(express.text({ type: () => true, limit: '64kb' }));

app.get('/healthz', (req, res) => res.send('ok'));

// Pure test endpoint for verifying the Traccar app: accepts anything, logs
// it to the ingest log, touches no race data. Point Traccar at
// https://<host>/ingest-test with any device identifier.
app.all(['/ingest-test', '/ingest-test/:x'], (req, res) => {
  pushIngestLog({
    at: new Date().toISOString(),
    test: true,
    method: req.method,
    token: req.params.x || req.query.id || req.body?.id || null,
    ip: req.ip,
    ua: (req.headers['user-agent'] || '').slice(0, 90) || null,
    ct: req.headers['content-type'] || undefined,
    query: Object.keys(req.query).length ? req.query : undefined,
    body: typeof req.body === 'string'
      ? (req.body.trim() ? req.body.slice(0, 2000) : undefined)
      : req.body && Object.keys(req.body).length ? req.body : undefined,
    status: 200,
    result: 'ok (test)',
  });
  res.status(200).send('ok (test)');
});

// Traccar posts here; also accepts GET with query params (old OsmAnd style).
// Every attempt — including missing/unknown tokens and bad payloads — is
// recorded to the in-memory ingest log for the admin debug console.
app.all('/ingest/:userId?', (req, res, next) => {
  const started = Date.now();
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    token: req.params.userId || null,
    ip: req.ip,
    ua: (req.headers['user-agent'] || '').slice(0, 90) || null,
    ct: req.headers['content-type'] || undefined,
    query: Object.keys(req.query).length ? req.query : undefined,
    body: typeof req.body === 'string'
      ? (req.body.trim() ? req.body.slice(0, 2000) : undefined)
      : req.body && Object.keys(req.body).length ? req.body : undefined,
  };
  const send = res.send.bind(res);
  res.send = (data) => {
    entry.status = res.statusCode;
    entry.result = String(data).slice(0, 80);
    entry.note = res.locals.notes?.join(' · ') || undefined;
    entry.ms = Date.now() - started;
    pushIngestLog(entry);
    return send(data);
  };
  if (!req.params.userId) return res.status(404).send('no device token in the URL — check Traccar server URL');
  ingestHandler(req, res).catch(next);
});

app.use('/api/admin', adminRouter);

// Sponsor/brand strip: drop logo files into public/brands/ and they appear on
// the board. Order by filename (prefix 01-, 02-, ... to control it).
app.get('/api/brands', (req, res) => {
  const dir = path.join(publicDir, 'brands');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.(svg|png|jpe?g|webp)$/i.test(f)).sort()
    : [];
  res.json(files.map((f) => `/brands/${f}`));
});

app.use('/api', apiRouter);

// QR as SVG for team pages / printouts. Only encodes URLs on this host.
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '');
  const origin = `${req.protocol}://${req.get('host')}`;
  if (!text.startsWith(origin) || text.length > 500) return res.status(400).send('bad text');
  res.type('image/svg+xml').send(
    await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#08182F', light: '#F4F3EF' } })
  );
});

// Public landing: the list of events and their live boards. Admin is /admin.
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/:slug/join', (req, res) => res.sendFile(path.join(publicDir, 'join.html')));
app.get('/:slug/board', (req, res) => res.sendFile(path.join(publicDir, 'board.html')));
app.get('/:slug/team/:teamId', (req, res) => res.sendFile(path.join(publicDir, 'team.html')));
app.use(express.static(publicDir));

// Shorthand: /{slug} shows the event's board (e.g. /london-26). Registered
// after static so real files always win; unknown slugs fall through to 404.
app.get('/:slug', async (req, res, next) => {
  if (!/^[a-z0-9-]+$/.test(req.params.slug)) return next();
  try {
    const { rows } = await pool.query('SELECT 1 FROM events WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return next();
    res.sendFile(path.join(publicDir, 'board.html'));
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  // malformed request bodies are the client's fault, not a server error
  if (err.type === 'entity.parse.failed' || err.status === 400 || err.statusCode === 400) {
    return res.status(400).json({ error: 'bad request body' });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 3000;
await initDb();
startGithubPoller();
startIdleMonitor();
startDevinPromptPoller();
app.listen(port, () => console.log(`runhack server on :${port}`));
