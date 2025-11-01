import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { prisma } from './db.js';
import { api } from './routes/api.js';
import expressLayouts from 'express-ejs-layouts';
import { webhooks } from './routes/webhooks.js';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import webpush from 'web-push';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, _res, next) => {
  console.log('REQ', req.method, req.url);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/webhooks', webhooks);
app.use('/api', api);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.get('/api/notifications/latest', async (_req, res) => {
  const last = await prisma.message.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true }
  });
  res.json(last || {});
});

app.use('/public', express.static(path.join(__dirname, '../public')));

// PWA assets at root (required by iOS)
app.get('/manifest.webmanifest', (_req, res) =>
  res.sendFile(path.join(__dirname, '../public/manifest.webmanifest'))
);
app.get('/sw.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});

// simple dashboard auth
function requireAuth(req, res, next){
  if (req.path.startsWith('/webhooks')) return next();
  if (req.path === '/login' || req.path === '/do-login') return next();
  if (req.cookies?.sess === process.env.DASH_PASSWORD) return next();
  return res.redirect('/login');
}
app.use(requireAuth);

app.get('/login', (_req, res) => res.render('login'));
app.post('/do-login', (req, res) => {
  if ((req.body.password || '') === process.env.DASH_PASSWORD) {
    res.cookie('sess', process.env.DASH_PASSWORD, { httpOnly:true, sameSite:'lax' });
    return res.redirect('/');
  }
  res.render('login', { error:'Wrong Password' });
});

/** HOME with tabs */
app.get('/', async (req, res) => {
  const tab = (req.query.tab || 'unread').toLowerCase();

  const [unread, pending, booked] = await Promise.all([
    prisma.booking.findMany({
      where: { messages: { some: { direction: 'IN', isRead: false } } },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' } }, pets: true }
    }),
    prisma.booking.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' } }, pets: true }
    }),
    prisma.booking.findMany({
      where: { status: 'CONFIRMED' },
      orderBy: { startAt: 'asc' },
      include: { messages: { orderBy: { createdAt: 'desc' } }, pets: true }
    })
  ]);

  res.render('inbox', {
    tab,
    counts: { unread: unread.length, pending: pending.length, booked: booked.length },
    unread, pending, booked
  });
});

// ===== Web Push (VAPID) setup =====
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:you@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Minimal persistence for subscriptions (JSON file)
const SUBS_FILE = path.join(__dirname, '../storage/push-subs.json');

async function loadSubs() {
  try { return JSON.parse(await fs.readFile(SUBS_FILE, 'utf8')); }
  catch { return []; }
}
async function saveSubs(subs) {
  await fs.mkdir(path.dirname(SUBS_FILE), { recursive: true });
  await fs.writeFile(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf8');
}

// Save a subscription
app.post('/push/subscribe', express.json(), async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(400).json({ error: 'vapid_not_configured' });
    }
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad_subscription' });
    const subs = await loadSubs();
    if (!subs.find(s => s.endpoint === sub.endpoint)) {
      subs.push(sub);
      await saveSubs(subs);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'subscribe_failed' });
  }
});

// Optional broadcast test
app.post('/push/test', async (_req, res) => {
  try {
    const subs = await loadSubs();
    const payload = JSON.stringify({
      title: '📩 Booking Hub',
      body: 'Test push delivered.',
      url: '/'
    });
    await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload)));
    res.json({ ok: true, sent: subs.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'push_failed' });
  }
});

/** BOOKING DETAIL: mark inbound as read */
app.get('/booking/:id', async (req, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } }, pets: true }
  });
  if (!booking) return res.status(404).send('Not found');

  await prisma.message.updateMany({
    where: { bookingId: booking.id, direction: 'IN', isRead: false },
    data: { isRead: true }
  });

  res.render('booking', { booking });
});

/** ===== Manual Booking ===== */
app.get('/bookings/new', (_req, res) => res.render('new-booking'));
app.post('/bookings', async (req, res) => {
  try {
    const { clientName, clientPhone, roverRelay, clientEmail, serviceType, dogsCount, startAt, endAt, notes } = req.body;
    if (!clientName || !startAt || !endAt) return res.status(400).send('clientName, startAt, endAt required');
    const start = new Date(startAt);
    const end   = new Date(endAt);
    if (isNaN(start) || isNaN(end)) return res.status(400).send('Invalid dates');

    const created = await prisma.booking.create({
      data: {
        source: 'Manual',
        clientName: clientName.trim(),
        clientPhone: clientPhone?.trim() || null,
        roverRelay: roverRelay?.trim() || null,
        clientEmail: clientEmail?.trim() || null,
        serviceType: serviceType?.trim() || 'Unspecified',
        dogsCount: dogsCount ? Number(dogsCount) : 1,
        startAt: start,
        endAt: end,
        status: 'PENDING',
        notes: notes || null
      }
    });
    res.redirect(`/booking/${created.id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to create booking');
  }
});

/** ===== Export: Confirmed Bookings -> PDF ===== */
app.get('/exports/confirmed', async (_req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: [{ startAt: 'asc' }, { clientName: 'asc' }],
    include: { pets: true }
  });
  res.render('export-confirmed', { bookings, generatedAt: new Date(), layout: false });
});

// Direct PDF (Chromium-on-Render)
app.get('/exports/confirmed.pdf', async (_req, res) => {
  try {
    const confirmed = await prisma.booking.findMany({
      where: { status: 'CONFIRMED', endAt: { gte: new Date() } },
      orderBy: { startAt: 'asc' },
      include: { pets: true }
    });

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Confirmed Bookings</title>
  <style>
    @page { size: A4; margin: 16mm; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; margin: 10px 0; page-break-inside: avoid; }
    .muted { color:#666; font-size:12px; }
    .row { display:flex; justify-content:space-between; gap:10px; }
    .pet { display:inline-block; background:#f5f5ff; border:1px solid #e6e6ff; border-radius:999px; padding:2px 8px; margin-right:6px; font-size:12px; }
  </style>
</head>
<body>
  <h1>Confirmed Bookings</h1>
  ${confirmed.map(b => `
    <div class="card">
      <div class="row">
        <div>
          <div style="font-weight:700;font-size:16px;">${escapeHtml(b.clientName)}</div>
          <div class="muted">${escapeHtml(b.clientPhone || b.roverRelay || '—')}</div>
        </div>
        <div class="muted">${new Date(b.startAt).toLocaleString()} → ${new Date(b.endAt).toLocaleString()}</div>
      </div>
      <div class="muted" style="margin-top:6px;">
        <b>Service:</b> ${escapeHtml(b.serviceType || '—')} •
        <b>Dogs:</b> ${b.dogsCount || 1}
      </div>
      ${b.pets?.length ? `
        <div style="margin-top:6px;">
          ${b.pets.map(p => `<span class="pet">${escapeHtml(p.name)}${p.breed ? ' · ' + escapeHtml(p.breed) : ''}</span>`).join('')}
        </div>
      ` : ''}
      ${b.notes ? `<div style="margin-top:6px;">${escapeHtml(b.notes)}</div>` : ''}
    </div>
  `).join('')}
</body>
</html>
    `;

    let browser;
    try {
      const executablePath = await chromium.executablePath();
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdf = await page.pdf({
        printBackground: true,
        format: 'A4',
        margin: { top: '16mm', right: '16mm', bottom: '16mm', left: '16mm' }
      });

      await browser.close();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="confirmed.pdf"');
      return res.send(pdf);
    } catch (err) {
      if (browser) try { await browser.close(); } catch {}
      console.error('PDF export failed, falling back to HTML:', err?.message || err);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'export_failed' });
  }

  function escapeHtml(s=''){
    return String(s)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#39;');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Listening on http://localhost:${port}`));

/* ===== OAuth (Calendar) ===== */
app.get('/api/auth/google/start', (_req, res) => {
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const url = o.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly'
    ]
  });
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const o = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await o.getToken(req.query.code);
    res.send(`<pre>Copy this REFRESH TOKEN into .env as GOOGLE_REFRESH_TOKEN:\n\n${tokens.refresh_token || '(none)'}\n\nThen restart the server.</pre>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth error. Check console.');
  }
});
