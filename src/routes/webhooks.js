// src/routes/webhooks.js
import express from 'express';
import { prisma } from '../db.js';
import * as chrono from 'chrono-node';
import { buildEID } from '../services/utils/eid.js';
import webpush from 'web-push';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export const webhooks = express.Router();

// ---------- Web Push wiring (same env as server.js) ----------
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Persisted subscriptions (JSON file; db table is fine too)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '../../storage');
const SUBS_FILE   = path.join(STORAGE_DIR, 'push-subs.json');


async function loadSubs() {
  try { return JSON.parse(await fs.readFile(SUBS_FILE, 'utf8')); }
  catch { return []; }
}
async function sendPushAll(payloadObj) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = await loadSubs();
  if (!subs.length) return;
  const payload = JSON.stringify(payloadObj);
  await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload)));
}

// ------------------------------------------------------------

webhooks.use(
  '/sms-forward',
  express.urlencoded({ extended: true }),
  express.text({ type: '*/*' }) // allow Tasker raw body
);

webhooks.get('/sms-forward', (_req, res) => {
  res.send('Webhook is up. Use POST with JSON or form fields: {from, body, timestamp}.');
});

webhooks.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --------- Booking intent heuristics ----------
const KEYWORDS = [
  'book','booking','reserve','reservation',
  'rover','sitter','sitting','board','boarding',
  'walk','walker','walking',
  'drop in','drop-in','dropin',
  'overnight','stay','doggy day care','daycare','day care',
  'cat sit','dog sit','house sit','housesit'
];

function findKeywords(text) {
  const t = (text || '').toLowerCase();
  const hits = [];
  for (const k of KEYWORDS) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(t)) hits.push(k);
  }
  return [...new Set(hits)];
}

// ---- robust date extraction ----
function parseDatesAll(text) {
  if (!text) return [];
  const ref = new Date();
  const results = chrono.parse(text, ref, { forwardDate: true });
  const spans = [];

  for (const r of results) {
    const start = r.start?.date?.() ?? null;
    const end   = r.end?.date?.()   ?? null;
    if (start) spans.push({ start, end: end || null, text: r.text || '' });
  }

  // explicit MM/DD/YYYY ... MM/DD/YYYY
  const md = /(\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)[^\d]+(\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)/i.exec(text);
  if (md) {
    const s = new Date(md[1]); const e = new Date(md[2]);
    if (!isNaN(s) && !isNaN(e)) spans.push({ start: s, end: e, text: md[0] });
  }

  // “Nov 07, 2025 … Nov 11, 2025”
  const wd = /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}).+?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i.exec(text);
  if (wd) {
    const s = new Date(wd[1].replace(/,/, '')); const e = new Date(wd[2].replace(/,/, ''));
    if (!isNaN(s) && !isNaN(e)) spans.push({ start: s, end: e, text: wd[0] });
  }

  return spans.filter(d => d.start && !isNaN(d.start.valueOf()));
}

// take earliest start + latest end across all matches; default time to 5pm if date-only
function pickDateRange(text) {
  const spans = parseDatesAll(text);
  if (!spans.length) return null;

  const points = [];
  for (const s of spans) { points.push(new Date(s.start)); if (s.end) points.push(new Date(s.end)); }
  points.sort((a,b)=>a-b);

  const start = points[0];
  const end   = points[points.length - 1] || points[0];

  const startAt = new Date(start);
  const endAt   = new Date(end);

  // If the text looked like date-only (no time), pin to 5:00 PM for nicer UI defaults
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\b|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\b/i.test(text)) {
    startAt.setHours(17,0,0,0);
    endAt.setHours(17,0,0,0);
  }
  return { startAt, endAt, text };
}

function classifyService(text='') {
  const t = text.toLowerCase();
  if (/\b(overnight|board(?:ing)?|sleep(?:over)?)\b/.test(t)) return 'Overnight';
  if (/\b(day ?care|doggy ?day ?care)\b/.test(t))            return 'Daycare';
  if (/\b(drop[\s-]?in|check ?in)\b/.test(t))                return 'Drop-in';
  if (/\b(walk(?:er|ing)?)\b/.test(t))                       return 'Walk';
  if (/\b(sit(?:ter|ting)?)\b/.test(t))                      return 'Sitting';
  return 'Unspecified';
}

// helper: serialize a single range into the JSON column
function serializeRange(range) {
  if (!range) return '[]';
  return JSON.stringify([{
    startISO: range.startAt.toISOString(),
    endISO:   range.endAt.toISOString(),
    text:     range.text || ''
  }]);
}

// ------------------------------------------------------------

webhooks.post('/sms-forward', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.SMS_FORWARD_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // --- Parse payload (json / form / raw / query) ---
    let from, body, timestamp;
    if (req.is('application/json') && req.body && typeof req.body === 'object') {
      ({ from, body, timestamp } = req.body);
    } else if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
      try { ({ from, body, timestamp } = JSON.parse(req.body)); } catch {}
    } else if (req.body && typeof req.body === 'object') {
      ({ from, body, timestamp } = req.body);
    }
    if (!from && req.query) {
      from = req.query.from; body = req.query.body; timestamp = req.query.timestamp;
    }
    if (!from || !body) return res.status(400).json({ error: 'Missing fields' });

    const receivedAt = new Date(Number(timestamp) || Date.now());

    // ---- Stable message EID (dedupe BEFORE any writes) ----
    const eid = buildEID({
      platform: 'sms',
      threadId: from,
      providerMessageId: undefined,
      from, body, timestamp: receivedAt.getTime()
    });

    const already = await prisma.message.findUnique({ where: { eid } });
    if (already) {
      return res.json({ ok: true, deduped: true, bookingId: already.bookingId || null, eid });
    }

    // ---- Intent / dates ----
    const keywords = findKeywords(body);
    const range    = pickDateRange(body);
    const hasDates = !!range;
    const isCandidate = (keywords.length > 0) && hasDates;

    // If not a booking candidate, still save the inbound and push a lightweight alert
    if (!isCandidate) {
      const orphan = await prisma.message.create({
        data: {
          eid,
          platform: 'sms',
          threadId: from,
          direction: 'IN',
          channel: 'SMS',
          fromPhone: from,
          fromLabel: from,
          body: String(body).slice(0, 2000),
          isRead: false,
          isBookingCandidate: false,
          extractedKeywordsJson: JSON.stringify(keywords),
          extractedDatesJson: serializeRange(null)
        }
      });
      await sendPushAll({ title: '📩 New message', body: body.slice(0, 120), url: '/' });
      return res.json({ ok: true, skipped: true, reason: 'not_booking_candidate', messageId: orphan.id, eid });
    }

    // ---- Find recent booking for this number (last 30 days, any status) ----
    let booking = await prisma.booking.findFirst({
      where: {
        OR: [{ clientPhone: from }, { roverRelay: from }],
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      },
      orderBy: { createdAt: 'desc' }
    });

    const svc     = classifyService(body);
    const startAt = range?.startAt || receivedAt;
    const endAt   = range?.endAt   || new Date(startAt.getTime() + 60 * 60 * 1000);

    if (!booking || booking.status === 'CANCELED') {
      // Create a fresh PENDING booking instead of resurrecting canceled threads
      booking = await prisma.booking.create({
        data: {
          source: 'SMS',
          clientName: from,
          clientPhone: from,
          roverRelay: from,
          serviceType: svc,
          startAt, endAt,
          status: 'PENDING',
          notes: 'Created from SMS (filtered booking candidate)'
        }
      });
    } else {
      // Enrich the existing booking:
      //  - fill missing service type
      //  - if dates changed and we still are pending, refresh them from the latest message
      const patch = {};
      if ((booking.serviceType || 'Unspecified') === 'Unspecified' && svc !== 'Unspecified') {
        patch.serviceType = svc;
      }
      const shouldRefreshDates =
        booking.status === 'PENDING' && hasDates &&
        (Math.abs(new Date(booking.startAt) - startAt) > 60 * 1000 ||
         Math.abs(new Date(booking.endAt)   - endAt)   > 60 * 1000);
      if (shouldRefreshDates) {
        patch.startAt = startAt;
        patch.endAt   = endAt;
      }
      if (Object.keys(patch).length) {
        booking = await prisma.booking.update({ where: { id: booking.id }, data: patch });
      }
    }

    // ---- Create the inbound message, linked to the booking ----
    await prisma.message.create({
      data: {
        eid,
        platform: 'sms',
        threadId: from,
        providerMessageId: null,
        fromPhone: from,
        direction: 'IN',
        channel: 'SMS',
        fromLabel: from,
        body: String(body).slice(0, 2000),
        isRead: false,
        isBookingCandidate: true,
        extractedKeywordsJson: JSON.stringify(keywords),
        extractedDatesJson: serializeRange(range),
        bookingId: booking.id
      }
    });

    // ---- Push notify devices ----
    await sendPushAll({
      title: '📩 New booking message',
      body: `${from}: ${body.slice(0, 100)}`,
      url: `/booking/${booking.id}`
    });

    return res.json({ ok: true, bookingId: booking.id, eid, serviceType: svc });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});
