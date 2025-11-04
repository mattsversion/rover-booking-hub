// src/routes/webhooks.js
import express from 'express';
import { prisma } from '../db.js';
import { buildEID } from '../services/utils/eid.js';
import webpush from 'web-push';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyMessage } from '../services/classifier.js';

export const webhooks = express.Router();

// ---------- Web Push wiring ----------
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

// --------- Booking intent heuristics ----------
// expanded with "drop off", "dropoff", “pick up”
const KEYWORDS = [
  'book','booking','reserve','reservation',
  'rover','sitter','sitting','board','boarding','overnight','stay',
  'doggy day care','doggy daycare','daycare','day care',
  'drop in','drop-in','dropin','drop off','dropoff','pick up','pickup'
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

// ---- parsing helpers (no chrono) ----
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function nextWeekdayDate(targetName, ref = new Date()) {
  const target = WEEKDAYS.indexOf(targetName.toLowerCase());
  if (target < 0) return null;
  const d = new Date(ref);
  const diff = (target - d.getDay() + 7) % 7 || 7; // always go forward
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}

// “thursday this week” → this week’s Thu (even if 2 days ahead)
// If today is after Thu, roll forward to next week’s Thu.
function thisWeekWeekdayDate(targetName, ref = new Date()) {
  const target = WEEKDAYS.indexOf(targetName.toLowerCase());
  if (target < 0) return null;
  const d = new Date(ref);
  const day = d.getDay();
  const delta = target - day;
  const out = new Date(d);
  out.setDate(d.getDate() + delta);
  out.setHours(0,0,0,0);
  if (delta < 0) { // already passed → use next week
    out.setDate(out.getDate() + 7);
  }
  return out;
}

// times like "9.30am", "9:30 am", "~ 4pm", "4 pm"
function parseTimeToken(tok) {
  const m = tok.toLowerCase().match(/~?\s*(\d{1,2})([:\.](\d{2}))?\s*(a|p)?m?\b/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  let min = m[3] ? parseInt(m[3], 10) : 0;
  const ap = m[4]; // a or p
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min };
  return null;
}

// find "from ... to ..." or "... - ..." pairs
function parseTimeRange(text) {
  const t = text.toLowerCase();
  const rangeRe = /(from|starting at)?\s*([~\s\d:\.apm]+)\s*(to|till|til|-|—|–|—)\s*([~\s\d:\.apm]+)/i;
  const m = t.match(rangeRe);
  if (!m) return null;
  const a = parseTimeToken(m[2]);
  const b = parseTimeToken(m[4]);
  if (!a || !b) return null;
  return { startH: a.h, startM: a.min, endH: b.h, endM: b.min };
}

function findWeekdayPhrase(text) {
  const t = text.toLowerCase();
  const thisWeek = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(this\s+week)\b/i);
  if (thisWeek) return { name: thisWeek[1].toLowerCase(), mode: 'this' };
  const plain = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (plain) return { name: plain[1].toLowerCase(), mode: 'next' };
  return null;
}

// explicit date like 12/24/2025 or 12-24-2025 or "december 24"
function parseExplicitDate(text, ref = new Date()) {
  const mdy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (mdy) {
    const mm = +mdy[1], dd = +mdy[2], yy = mdy[3] ? +mdy[3] : ref.getFullYear();
    const year = yy < 100 ? 2000 + yy : yy;
    const d = new Date(year, mm - 1, dd);
    if (!isNaN(d)) return d;
  }
  const mname = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (mname) {
    const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mm = monthMap[mname[1].slice(0,3).toLowerCase()];
    const dd = +mname[2];
    const year = mname[3] ? +mname[3] : ref.getFullYear();
    const d = new Date(year, mm, dd);
    if (!isNaN(d)) return d;
  }
  return null;
}

// main: pick a usable date range from message
function pickDateRange(text, ref = new Date()) {
  const weekday = findWeekdayPhrase(text);
  const explicit = parseExplicitDate(text, ref);
  const times = parseTimeRange(text);

  let baseDate = null;
  if (explicit) {
    baseDate = explicit;
  } else if (weekday) {
    baseDate = weekday.mode === 'this' ? thisWeekWeekdayDate(weekday.name, ref)
                                       : nextWeekdayDate(weekday.name, ref);
  }

  if (!baseDate) return null;

  // if we have only one explicit date and also a "to <date>" segment, capture that
  const span = text.match(/(?:\bto\b|\-|\–|\—)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\b[A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?)/i);
  let endDate = null;
  if (span) {
    endDate = parseExplicitDate(span[1], ref);
  }

  const startAt = new Date(baseDate);
  const endAt   = new Date(endDate || baseDate);

  if (times) {
    startAt.setHours(times.startH, times.startM, 0, 0);
    endAt.setHours(times.endH,   times.endM,   0, 0);
    // if end time crosses midnight (rare in daycare), bump a day
    if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  } else {
    // no explicit times → default to 5pm single-day (UI-friendly)
    startAt.setHours(17,0,0,0);
    endAt.setHours(17,0,0,0);
  }

  return { startAt, endAt, text };
}

function classifyService(text='') {
  const t = text.toLowerCase();
  // explicit words first
  if (/\b(overnight|board(?:ing)?|sleep(?:over)?)\b/.test(t)) return 'Overnight';
  if (/\b(day ?care|doggy ?day ?care)\b/.test(t))            return 'Daycare';
  if (/\b(drop[\s-]?in|check ?in)\b/.test(t))                return 'Drop-in';
  // implicit by duration: same date + has times -> daycare
  const tr = parseTimeRange(t);
  const wd = findWeekdayPhrase(t) || parseExplicitDate(t);
  if (tr && wd) return 'Daycare';
  return 'Unspecified';
}

// pet extraction: "Vida's mom", "drop Vida off", "for Luna", "for my dog Luna"
function extractPetNames(text='') {
  const names = new Set();

  const mom = text.match(/\b([A-Z][a-z]{2,})'s\s+mom\b/);
  if (mom) names.add(mom[1]);

  const drop = text.match(/\bdrop\s+([A-Z][a-z]{2,})\s+off\b/);
  if (drop) names.add(drop[1]);

  const forName = text.match(/\bfor\s+(?:my\s+dog\s+)?([A-Z][a-z]{2,})\b/);
  if (forName) names.add(forName[1]);

  // commas around name: "this is Vera, Vida's mom" → catch Vida via mom rule; Vera is owner
  return [...names];
}

function serializeRange(range) {
  if (!range) return '[]';
  return JSON.stringify([{
    startISO: range.startAt.toISOString(),
    endISO:   range.endAt.toISOString(),
    text:     range.text || ''
  }]);
}

// ------------------------------------------------------------
// accept form/json/raw
webhooks.use(
  '/sms-forward',
  express.urlencoded({ extended: true }),
  express.text({ type: '*/*' })
);

webhooks.get('/sms-forward', (_req, res) => {
  res.send('Webhook is up. Use POST with JSON or form fields: {from, body, timestamp}.');
});

webhooks.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

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

    // ---- Optional AI classification ----
    let classifyLabel = null, classifyScore = null, extractedJson = null;
    try {
      const { label, score, extracted } = await classifyMessage(body);
      classifyLabel = label;
      classifyScore = score;
      extractedJson = extracted ? JSON.stringify(extracted) : null;
    } catch {}

    // ---- Heuristics (keywords + real date) ----
    const keywords = findKeywords(body);
    const range    = pickDateRange(body, receivedAt);
    const hasDates = !!range;

    // strict gate: must have both keywords and dates
    const isCandidate = (keywords.length > 0) && hasDates;

    // Always store the message, but only create/attach a booking when candidate
    let bookingId = null;

    if (isCandidate) {
      // find recent thread booking
      let booking = await prisma.booking.findFirst({
        where: {
          OR: [{ clientPhone: from }, { roverRelay: from }],
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        },
        orderBy: { createdAt: 'desc' }
      });

      const svc = classifyService(body);
      const startAt = range.startAt;
      const endAt   = range.endAt;

      if (!booking || booking.status === 'CANCELED') {
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
        const patch = {};
        if ((booking.serviceType || 'Unspecified') === 'Unspecified' && svc !== 'Unspecified') {
          patch.serviceType = svc;
        }
        const shouldRefreshDates =
          booking.status === 'PENDING' &&
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

      bookingId = booking.id;

      // --- Pet best-effort attach
      try {
        const pets = extractPetNames(body);
        for (const name of pets) {
          // avoid duplicate pets on the same booking by (name, bookingId) check
          const existing = await prisma.pet.findFirst({
            where: { name, bookings: { some: { id: booking.id } } }
          }).catch(()=>null);

          if (!existing) {
            // if your schema is Booking <-> Pet many-to-many via join table
            await prisma.pet.upsert({
              where: { name_owner: { name, ownerPhone: from } }, // if you don't have this unique, catch below
              update: { },
              create: { name, ownerPhone: from }
            }).then(async pet => {
              // connect through the relation
              await prisma.booking.update({
                where: { id: booking.id },
                data: { pets: { connect: { id: pet.id } } }
              });
            }).catch(async () => {
              // fallback: create and connect without unique
              const pet = await prisma.pet.create({ data: { name } });
              await prisma.booking.update({
                where: { id: booking.id },
                data: { pets: { connect: { id: pet.id } } }
              });
            });
          }
        }
      } catch {}
    }

    // ---- Create the inbound message (bookingId may be null) ----
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
        isBookingCandidate: isCandidate,
        extractedKeywordsJson: JSON.stringify(keywords),
        extractedDatesJson: serializeRange(range),
        classifyLabel,
        classifyScore,
        extractedJson,
        bookingId
      }
    });

    // ---- Push notify devices ----
    await sendPushAll({
      title: isCandidate ? '📩 New booking message' : '📩 New message',
      body: `${from}: ${body.slice(0, 100)}`,
      url: isCandidate && bookingId ? `/booking/${bookingId}` : '/'
    });

    return res.json({ ok: true, bookingId, eid, candidate: isCandidate });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});
