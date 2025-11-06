// src/server.js
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
import fsSync from 'fs';
import { adminClassify } from './routes/admin-classify.js';
import { clientsRouter } from './routes/clients.js';
import { reparseAll } from './services/intake.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, _res, next) => {
  console.log('REQ', req.method, req.url);
  next();
});

app.use('/public', express.static(path.join(__dirname, '../public')));

app.use(adminClassify);

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/clients', clientsRouter);
app.use('/webhooks', webhooks);
app.use('/api', api);


const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '../storage');

const FLAGS = {
  autoArchiveDays: Number(process.env.AUTO_ARCHIVE_DAYS || 7),
  autoConfirmTrusted: process.env.AUTO_CONFIRM_TRUSTED === '1',
  adminToggles: process.env.ADMIN_TOGGLES === '1',
};



// PWA assets at root (required by iOS)
app.get('/manifest.webmanifest', (_req, res) =>
  res.sendFile(path.join(__dirname, '../public/manifest.webmanifest'))
);
app.get('/sw.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});

app.get('/debug/push', (_req, res) => {
  res.json({
    vapidPublicPresent: !!process.env.VAPID_PUBLIC_KEY,
    vapidPrivatePresent: !!process.env.VAPID_PRIVATE_KEY,
    swServed: fsSync.existsSync(path.join(__dirname, '../public/sw.js')),
    manifestServed: fsSync.existsSync(path.join(__dirname, '../public/manifest.webmanifest')),
  });
});

// simple dashboard auth
function requireAuth(req, res, next){
  if (req.path.startsWith('/webhooks')) return next();
  if (req.path === '/login' || req.path === '/do-login') return next();
  if (req.cookies?.sess === process.env.DASH_PASSWORD) return next();
  return res.redirect('/login');
}

app.use(requireAuth);

// quick “latest notification” endpoint used by the UI ping
app.get('/api/notifications/latest', async (_req, res) => {
  const last = await prisma.message.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true }
  });
  res.json(last || {});
});

// Danger: one-time cleanup for demo/test residue
app.post('/admin/cleanup-demo', async (_req, res) => {
  const start = new Date('2025-11-12T00:00:00');
  const end   = new Date('2025-11-15T00:00:00');

  const delMsgs = await prisma.message.deleteMany({
    where: {
      createdAt: { gte: start, lt: end },
      isBookingCandidate: true,
      extractedDatesJson: { contains: '2025-11-12' }
    }
  });

  const delBookings = await prisma.booking.deleteMany({
    where: {
      startAt: { gte: start, lt: end },
      status: 'PENDING'
    }
  });

  console.log('cleanup-demo removed', { delMsgs: delMsgs.count, delBookings: delBookings.count });
  res.redirect('/');
});

app.get('/login', (_req, res) => res.render('login'));
app.post('/do-login', (req, res) => {
  const ok = (req.body.password || '') === process.env.DASH_PASSWORD;
  if (!ok) return res.render('login', { error:'Wrong Password' });

  const remember = req.body.remember === '1';
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    // set secure if behind https proxy
    // secure: true,
  };
  if (remember) cookieOpts.maxAge = 60 * 24 * 60 * 60 * 1000; // 60 days

  res.cookie('sess', process.env.DASH_PASSWORD, cookieOpts);
  // redirect stays in the SAME tab
  return res.redirect('/');
});


/** HOME with tabs — show ONLY threads that contain inbound booking-candidate messages */
app.get('/', async (req, res) => {
  const tab = (req.query.tab || 'unread').toLowerCase();

  const commonInclude = { messages: { orderBy: { createdAt: 'desc' } }, pets: true };

  const [unread, pending, booked] = await Promise.all([
    // keep unread tied to inbound candidate messages
    prisma.booking.findMany({
      where: {
        messages: { some: { direction: 'IN', isRead: false, isBookingCandidate: true } }
      },
      orderBy: { createdAt: 'desc' },
      include: commonInclude
    }),
    // show ALL pending (manual included), newest first
    prisma.booking.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: commonInclude
    }),
    // show ALL confirmed, soonest first
    prisma.booking.findMany({
      where: { status: 'CONFIRMED' },
      orderBy: { startAt: 'asc' },
      include: commonInclude
    })
  ]);


  res.render('inbox', {
    tab,
    counts: { unread: unread.length, pending: pending.length, booked: booked.length },
    unread, pending, booked
  });
});

/* ------------------ Web Push (server-side) ------------------- */
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
const SUBS_FILE   = path.join(STORAGE_DIR, 'push-subs.json');
async function loadSubs(){ try { return JSON.parse(await fs.readFile(SUBS_FILE,'utf8')); } catch { return []; } }
async function saveSubs(subs){ await fs.mkdir(STORAGE_DIR,{recursive:true}); await fs.writeFile(SUBS_FILE, JSON.stringify(subs,null,2),'utf8'); }

async function runMaintenance() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - (FLAGS.autoArchiveDays * 24 * 60 * 60 * 1000));

  const arch = await prisma.booking.updateMany({
    where: {
      endAt: { lt: cutoff },
      status: { in: ['PENDING', 'CONFIRMED', 'CANCELED'] }
    },
    data: { status: 'ARCHIVED' }
  });

  // mark unread IN messages as read for newly archived threads
  const archivedIds = await prisma.booking.findMany({
    where: { status: 'ARCHIVED', updatedAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
    select: { id: true }
  });
  if (archivedIds.length) {
    await prisma.message.updateMany({
      where: { bookingId: { in: archivedIds.map(x => x.id) }, direction: 'IN', isRead: false },
      data: { isRead: true }
    });
  }

  console.log('maintenance', { autoArchived: arch.count, cutoffDays: FLAGS.autoArchiveDays });
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
    include: { messages: { orderBy: { createdAt: 'asc' } },
    pets: true,
    changes: { where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' } } // <— add this
   }
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
        clientPhone: normPhone(clientPhone) || null,
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

/** ===== Export: Confirmed Bookings -> PDF (HTML fallback) ===== */
app.get('/exports/confirmed', async (_req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: [{ startAt: 'asc' }, { clientName: 'asc' }],
    include: { pets: true }
  });
  res.render('export-confirmed', { bookings, generatedAt: new Date(), layout: false });
});

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

/* ---------------- Dashboard + Analytics/Exports --------------- */
// (unchanged logic, kept for completeness)

// tiny helpers
function parseISODate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d){ const x = new Date(d); x.setHours(23,59,59,999); return x; }

function normPhone(p){
  if (!p) return null;
  const digits = String(p).replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : (digits || null);
}

// Dashboard
app.get('/dashboard', async (_req, res) => {
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0,0,0,0);
  const endOfToday   = new Date(now); endOfToday.setHours(23,59,59,999);
  const next7        = new Date(now.getTime() + 7*24*60*60*1000);

  const [todayActive, upcoming7, stalePending] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: ['PENDING','CONFIRMED'] },
        AND: [{ endAt: { gte: startOfToday } }, { startAt: { lte: endOfToday } }]
      },
      orderBy: [{ startAt: 'asc' }, { clientName: 'asc' }],
      include: { pets: true }
    }),
    prisma.booking.findMany({
      where: {
        status: { in: ['PENDING','CONFIRMED'] },
        startAt: { gt: endOfToday, lte: next7 }
      },
      orderBy: [{ startAt: 'asc' }, { clientName: 'asc' }],
      include: { pets: true }
    }),
    prisma.booking.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now.getTime() - 24*60*60*1000) }
      },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  res.render('dashboard', { today: todayActive, upcoming: upcoming7, stalePending });
});

// Analytics + CSV
function fmt(n){ return Number.isFinite(n) ? n.toFixed(2) : '0.00'; }
function padCSV(s=''){ return `"${String(s).replace(/"/g,'""')}"`; }
function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 90*24*60*60*1000);
  return { from: startOfDay(from), to: endOfDay(to) };
}

app.get('/analytics', async (req, res) => {
  const qFrom = parseISODate(req.query.from);
  const qTo   = parseISODate(req.query.to);

  const { from: defFrom, to: defTo } = defaultRange();
  const from = qFrom ? startOfDay(qFrom) : defFrom;
  const to   = qTo   ? endOfDay(qTo)     : defTo;

  const bookings = await prisma.booking.findMany({
    where: { OR: [{ startAt: { gte: from, lte: to } }, { endAt: { gte: from, lte: to } }] },
    orderBy: { startAt: 'asc' },
    include: { pets: true }
  });

  const msgs = await prisma.message.findMany({
    where: { createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: 'asc' }
  });

  const total = bookings.length;
  const byStatus = groupCount(bookings, b => b.status || 'UNKNOWN');
  const byService = groupCount(bookings, b => b.serviceType || 'Unspecified');

  const createdInWin = bookings.filter(b => b.createdAt >= from && b.createdAt <= to);
  const createdPending = createdInWin.filter(b => b.status === 'PENDING').length;
  const createdConfirmed = createdInWin.filter(b => b.status === 'CONFIRMED').length;
  const conversionRate = createdPending + createdConfirmed > 0
    ? (createdConfirmed / (createdPending + createdConfirmed)) * 100
    : 0;

  const leadDays = bookings
    .filter(b => b.status === 'CONFIRMED')
    .map(b => (b.startAt - b.createdAt) / (24*60*60*1000))
    .filter(d => Number.isFinite(d) && d >= 0);
  const avgLead = leadDays.length ? (leadDays.reduce((a,b)=>a+b,0) / leadDays.length) : 0;

  const now = new Date();
  const in30 = new Date(now.getTime() + 30*24*60*60*1000);
  const upcoming = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      OR: [{ startAt: { gte: now, lte: in30 } }, { endAt: { gte: now, lte: in30 } }]
    },
    orderBy: { startAt: 'asc' }
  });
  const hoursNext30 = upcoming.reduce((sum, b) => {
    const s = new Date(Math.max(now, b.startAt));
    const e = new Date(Math.min(in30, b.endAt));
    const h = Math.max(0, (e - s) / (60*60*1000));
    return sum + h;
  }, 0);

  const msgIn  = msgs.filter(m => m.direction === 'IN').length;
  const msgOut = msgs.filter(m => m.direction === 'OUT').length;

  const privateBookings = bookings.filter(b => !b.roverRelay && b.clientPhone);
  const topClients = Object.entries(groupCount(privateBookings, b => b.clientPhone))
    .sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([phone, count]) => {
      const first = privateBookings.find(b => b.clientPhone === phone);
      return { phone, name: first?.clientName || '—', count };
    });

  const byDay = groupCount(createdInWin, b => new Date(b.createdAt).toISOString().slice(0,10));

  res.render('analytics', {
    from, to,
    totals: {
      totalBookings: total,
      byStatus,
      byService,
      conversionRate,
      avgLead,
      hoursNext30,
      msgIn, msgOut
    },
    topClients,
    byDay
  });

  function groupCount(arr, keyFn){
    const m = new Map();
    for (const x of arr) {
      const k = keyFn(x);
      m.set(k, (m.get(k)||0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  }
});

// CSV: bookings
app.get('/exports/bookings.csv', async (req, res) => {
  const qFrom = parseISODate(req.query.from);
  const qTo   = parseISODate(req.query.to);
  const status = (req.query.status || '').toString().toUpperCase();

  const { from: defFrom, to: defTo } = defaultRange();
  const from = qFrom ? startOfDay(qFrom) : defFrom;
  const to   = qTo   ? endOfDay(qTo)     : defTo;

  const where = { AND: [{ OR: [{ startAt: { gte: from, lte: to } }, { endAt: { gte: from, lte: to } }] }] };
  if (['PENDING','CONFIRMED','CANCELED'].includes(status)) where.AND.push({ status });

  const rows = await prisma.booking.findMany({ where, orderBy: { startAt: 'asc' }, include: { pets: true } });

  const header = [
    'id','createdAt','startAt','endAt','status',
    'clientName','clientPhone','roverRelay','clientEmail',
    'serviceType','dogsCount','source','pets','notes'
  ].join(',');

  const lines = rows.map(b => [
    b.id,
    b.createdAt?.toISOString() || '',
    b.startAt?.toISOString() || '',
    b.endAt?.toISOString() || '',
    b.status || '',
    padCSV(b.clientName || ''),
    padCSV(b.clientPhone || ''),
    padCSV(b.roverRelay || ''),
    padCSV(b.clientEmail || ''),
    padCSV(b.serviceType || ''),
    b.dogsCount ?? '',
    padCSV(b.source || ''),
    padCSV((b.pets||[]).map(p => p.name + (p.breed ? ` (${p.breed})` : '')).join('; ')),
    padCSV(b.notes || '')
  ].join(','));

  const csv = [header, ...lines].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="bookings.csv"');
  res.send(csv);
});

// CSV: messages
app.get('/exports/messages.csv', async (req, res) => {
  const qFrom = parseISODate(req.query.from);
  const qTo   = parseISODate(req.query.to);
  const dir   = (req.query.dir || '').toString().toUpperCase();

  const { from: defFrom, to: defTo } = defaultRange();
  const from = qFrom ? startOfDay(qFrom) : defFrom;
  const to   = qTo   ? endOfDay(qTo)     : defTo;

  const where = { createdAt: { gte: from, lte: to } };
  if (['IN','OUT'].includes(dir)) where.direction = dir;

  const rows = await prisma.message.findMany({ where, orderBy: { createdAt: 'asc' } });

  const header = [
    'id','createdAt','bookingId','direction','channel',
    'threadId','fromPhone','fromLabel','isRead',
    'isBookingCandidate','classifyLabel','classifyScore','body'
  ].join(',');

  const lines = rows.map(m => [
    m.id,
    m.createdAt?.toISOString() || '',
    m.bookingId || '',
    m.direction || '',
    m.channel || '',
    padCSV(m.threadId || ''),
    padCSV(m.fromPhone || ''),
    padCSV(m.fromLabel || ''),
    m.isRead ? 1 : 0,
    m.isBookingCandidate ? 1 : 0,
    padCSV(m.classifyLabel || ''),
    m.classifyScore ?? '',
    padCSV((m.body || '').slice(0, 2000))
  ].join(','));

  const csv = [header, ...lines].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="messages.csv"');
  res.send(csv);
});

/* -------------------- admin helpers / seed -------------------- */

// quick counts
app.get('/debug/counts', async (_req, res) => {
  const [bookings, messages] = await Promise.all([
    prisma.booking.count(),
    prisma.message.count()
  ]);
  res.json({ bookings, messages });
});

// one-click demo seed
app.post('/admin/seed-demo', async (_req, res) => {
  const now = new Date();
  const plus = d => new Date(now.getTime() + d*24*60*60*1000);

  const hasAny = await prisma.booking.count();
  if (hasAny > 0) return res.redirect('/');

  const alice = await prisma.booking.create({
    data: {
      source: 'Manual',
      clientName: 'Alice Rivera',
      clientPhone: '555-1111',
      serviceType: 'Overnight',
      dogsCount: 1,
      startAt: plus(1),
      endAt: plus(3),
      status: 'PENDING',
      notes: 'First-time client (private number)'
    }
  });
  await prisma.message.create({
    data: {
      bookingId: alice.id,
      direction: 'IN',
      channel: 'SMS',
      body: 'Hi! Board my dog from Nov 7 to Nov 9?',
      isBookingCandidate: true,
      eid: 'demo-eid-1',
      platform: 'sms',
      threadId: '555-1111',
      fromPhone: '555-1111'
    }
  });

  const bob = await prisma.booking.create({
    data: {
      source: 'Rover',
      clientName: 'Bob Chen',
      roverRelay: 'r.rover.com/xyz',
      serviceType: 'Daycare',
      dogsCount: 2,
      startAt: plus(5),
      endAt: plus(5),
      status: 'CONFIRMED',
      notes: 'Repeat via Rover'
    }
  });
  await prisma.message.create({
    data: {
      bookingId: bob.id,
      direction: 'OUT',
      channel: 'SMS',
      body: 'Confirmed for Daycare on the 12th 9–5.',
      isBookingCandidate: false,
      eid: 'demo-eid-2',
      platform: 'sms',
      threadId: 'r.rover.com/xyz',
      fromPhone: null
    }
  });

  res.redirect('/');
});

// nuke everything (careful)
app.post('/admin/clear-all', async (_req, res) => {
  await prisma.message.deleteMany({});
  await prisma.pet.deleteMany({}).catch(()=>{});
  await prisma.booking.deleteMany({});
  res.redirect('/');
});



// --- Admin Tools page
app.get('/admin/tools', (_req, res) => {
  res.render('admin-tools');
});

// --- Batch: Double-check & auto-fill
app.post('/admin/intake/reparse', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const days = Number(req.body.days) || 120;
    const onlyUnlinked = !!req.body.onlyUnlinked;
    const result = await reparseAll(prisma, { days, onlyUnlinked });
    res.render('admin-tools', { result });
  } catch (e) {
    console.error(e);
    res.status(500).send('Reparse failed');
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
