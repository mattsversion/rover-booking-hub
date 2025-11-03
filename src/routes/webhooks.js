// src/routes/webhooks.js
import express from 'express';
import { prisma } from '../db.js';
import * as chrono from 'chrono-node';
import { buildEID } from '../services/utils/eid.js';
import webpush from 'web-push';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureClientForPrivate } from '../services/clients.js';

export const webhooks = express.Router();

// ---------- Web Push wiring (same env as server.js) ----------
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
const AUTO_CONFIRM_TRUSTED = process.env.AUTO_CONFIRM_TRUSTED === '1';

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
  // you said you don’t do walking, but keep terms for intent detection:
  'walk','walker','walking',
  'drop in','drop-in','dropin',
  'overnight','stay','doggy day care','daycare','day care',
  'cat sit','dog sit','house sit','housesit','care','take care'
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

// =========================
// DATE PARSING — V2
// =========================
function norm(s=''){ return s.replace(/[–—−]/g, '-'); }

// heuristics: default missing year to current; if >7 days in past, bump a year
function resolveYear(d) {
  const x = new Date(d);
  if (isNaN(x)) return d;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7*24*60*60*1000);
  if (x < sevenDaysAgo) {
    const y = x.getFullYear() + 1;
    x.setFullYear(y);
  }
  return x;
}
function at5pm(d){ const x = new Date(d); x.setHours(17,0,0,0); return x; }

function makeCand({start, end=null, text='', kind='regex', baseScore=0}) {
  const sOk = start && !isNaN(start.valueOf());
  const eOk = !end || !isNaN(end.valueOf());
  if (!sOk || !eOk) return null;
  return { start, end, text, kind, baseScore };
}

const MONTH_NAME = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DAY_NUM = '(?:[0-3]?\\d)(?:st|nd|rd|th)?';
const YEAR_OPT = '(?:,?\\s*(?:20\\d{2}))?';

// RANGES
const RX_RANGE = [
  // Nov 20 - Nov 23
  new RegExp(`\\b(${MONTH_NAME})\\s+(${DAY_NUM})${YEAR_OPT}\\s*(?:-|to|through|thru)\\s*(${MONTH_NAME})\\s+(${DAY_NUM})${YEAR_OPT}\\b`, 'i'),
  // Nov 20 - 23 (same month)
  new RegExp(`\\b(${MONTH_NAME})\\s+(${DAY_NUM})${YEAR_OPT}\\s*(?:-|to|through|thru)\\s*(${DAY_NUM})${YEAR_OPT}\\b`, 'i'),
  // 11/20 - 11/23 or 11/20/2025 - 11/23[/2025]
  /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:-|to|through|thru)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i,
  // from Nov 20 to Nov 23
  new RegExp(`\\bfrom\\s+(${MONTH_NAME})\\s+(${DAY_NUM})${YEAR_OPT}\\s+(?:to|until|till|through)\\s+(${MONTH_NAME})\\s+(${DAY_NUM})${YEAR_OPT}\\b`, 'i'),
];

// SINGLES (on Nov 20 / 11/20[/2025])
const RX_SINGLE = [
  new RegExp(`\\b(?:on\\s+)?(${MONTH_NAME})\\s+(${DAY_NUM})${YEAR_OPT}\\b`, 'i'),
  /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i,
];

// comma list single-days: "12/15, 12/18, 12/24-12/30" — handle via a split and reuse matchers
function splitByCommas(text='') {
  // keep ranges intact (contain '-' or 'to')
  return norm(text)
    .split(/,\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function coerceYear(y) {
  if (!y) return null;
  if (y.length === 2) return `20${y}`;
  return y;
}

function parseRangePiece(piece) {
  const t = norm(piece);
  for (const rx of RX_RANGE) {
    const m = rx.exec(t);
    if (!m) continue;
    try {
      let s, e, label = m[0];

      if (rx === RX_RANGE[0]) {
        const sStr = `${m[1]} ${m[2]}${m[3]||''}`;
        const eStr = `${m[4]} ${m[5]}${m[6]||''}`;
        s = at5pm(new Date(sStr));
        e = at5pm(new Date(eStr));
      } else if (rx === RX_RANGE[1]) {
        const sStr = `${m[1]} ${m[2]}${m[3]||''}`;
        const mon  = m[1];
        const eStr = `${mon} ${m[4]}${m[5]||''}`;
        s = at5pm(new Date(sStr));
        e = at5pm(new Date(eStr));
      } else if (rx === RX_RANGE[2]) {
        const y1 = coerceYear(m[3]) || `${new Date().getFullYear()}`;
        const y2 = coerceYear(m[6]) || y1;
        s = at5pm(new Date(`${m[1]}/${m[2]}/${y1}`));
        e = at5pm(new Date(`${m[4]}/${m[5]}/${y2}`));
      } else {
        // 'from Mon to Mon' (rare in your data, but keep)
        const sStr = `${m[1]} ${m[2]}${m[3]||''}`;
        const eStr = `${m[4]} ${m[5]}${m[6]||''}`;
        s = at5pm(new Date(sStr));
        e = at5pm(new Date(eStr));
      }
      s = resolveYear(s);
      e = resolveYear(e);
      return makeCand({ start: s, end: e, text: label, kind: 'regex-range', baseScore: 10 });
    } catch {}
  }
  return null;
}

function parseSinglePiece(piece) {
  const t = norm(piece);
  for (const rx of RX_SINGLE) {
    const m = rx.exec(t);
    if (!m) continue;
    try {
      let s, label = m[0];
      if (rx === RX_SINGLE[0]) {
        const dayClean = (m[2]||'').replace(/(st|nd|rd|th)$/i, '');
        const sStr = `${m[1]} ${dayClean}${m[3]||''}`;
        s = at5pm(new Date(sStr));
      } else {
        const y = coerceYear(m[3]) || `${new Date().getFullYear()}`;
        s = at5pm(new Date(`${m[1]}/${m[2]}/${y}`));
      }
      s = resolveYear(s);
      return makeCand({ start: s, end: s, text: label, kind: 'regex-single', baseScore: 7 });
    } catch {}
  }
  return null;
}

// chrono fallback for anything missed
function chronoCandidates(text) {
  const out = [];
  const ref = new Date();
  const results = chrono.parse(text || '', ref, { forwardDate: true });
  for (const r of results) {
    const s = r.start?.date?.() ?? null;
    if (!s) continue;
    const e = r.end?.date?.() ?? null;
    const dateOnlyS = !r.start.isCertain('hour');
    const dateOnlyE = e ? !r.end.isCertain('hour') : true;
    let s2 = dateOnlyS ? at5pm(s) : s;
    let e2 = e ? (dateOnlyE ? at5pm(e) : e) : null;
    s2 = resolveYear(s2);
    if (e2) e2 = resolveYear(e2);

    const baseScore = e2 ? 6 : 4;
    out.push(makeCand({ start: s2, end: e2, text: r.text || '', kind: 'chrono', baseScore }));
  }
  return out.filter(Boolean);
}

/**
 * parseDateSegments(text)
 * Returns an array of segments: [{start, end, text, source, score}]
 * - Splits comma lists
 * - Tries explicit ranges, then singles, then chrono
 * - Ignores weekday-only hits
 */
function parseDateSegments(text='') {
  const pieces = splitByCommas(text);
  const segs = [];

  for (const piece of (pieces.length ? pieces : [text])) {
    let cand = parseRangePiece(piece) || parseSinglePiece(piece);
    if (!cand) {
      // try chrono within this piece, pick best-scored one
      const cands = chronoCandidates(piece).map(c => applyPenalties(c, piece));
      cands.sort((a,b) => (b.score ?? b.baseScore) - (a.score ?? a.baseScore));
      cand = cands[0] || null;
    } else {
      cand = applyPenalties(cand, piece);
    }
    if (!cand) continue;

    // weed out weekday-only (chrono can do this)
    if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(cand.text) &&
        !/\b\d{1,2}\b/.test(cand.text)) {
      continue;
    }
    // max booking sanity: drop > 60 days
    const durDays = ((cand.end || cand.start) - cand.start) / (24*60*60*1000);
    if (cand.end && durDays > 60) continue;

    segs.push(cand);
  }

  // Merge contiguous duplicates (e.g., same start/end twice)
  const key = s => `${s.start?.toISOString()}|${(s.end||s.start)?.toISOString()}`;
  const seen = new Set();
  return segs.filter(s => {
    const k = key(s);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function applyPenalties(cand, piece) {
  const now = new Date();
  let score = cand.baseScore;

  // penalize far future (> 18 mo)
  const futureMonths = (cand.start.getFullYear() - now.getFullYear()) * 12 +
                       (cand.start.getMonth() - now.getMonth());
  if (futureMonths > 18) score -= 2;

  // small bonus if piece includes 'to' or a hyphen and we have a range
  if (cand.end && /(?:-| to | through | thru )/i.test(piece)) score += 1;

  // small penalty if only chrono and very generic text
  if (cand.kind === 'chrono' && !/\d/.test(cand.text)) score -= 2;

  return { ...cand, score };
}

// Service inference: you don’t walk; so multi-day => "Overnight", single-day => "Daycare"
function inferServiceForSegment(seg) {
  if (!seg) return 'Unspecified';
  const start = seg.start;
  const end = seg.end || seg.start;
  const durHrs = Math.max(0, (end - start) / (60*60*1000));
  if (durHrs >= 24 - 0.001) return 'Overnight'; // boarding-style multi-day
  return 'Daycare'; // single-day
}

// Extract rover owner/pet heuristically from examples
function extractRoverEntities(text='') {
  const t = String(text);
  const out = { ownerFirst: null, ownerFull: null, petName: null, petAge: null, petWeight: null };

  // [ New booking request ... from Eric: Eric Roberts (2 mos, 5 lbs) ... ]
  const fromName = /\bfrom\s+([A-Z][a-zA-Z'-]+)\s*:/i.exec(t);
  if (fromName) out.ownerFirst = fromName[1];

  const ownerFull = /:\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)\s*\(/.exec(t);
  if (ownerFull) out.ownerFull = ownerFull[1];

  const petGroup = /\(([^\)]*?)\)/.exec(t);
  if (petGroup) {
    const age = /(\d+\s*(?:mo|mos|month|months|yr|yrs|year|years))/i.exec(petGroup[1]);
    const wt  = /(\d+\.?\d*)\s*(?:lb|lbs|pound|pounds)/i.exec(petGroup[1]);
    if (age) out.petAge = age[1];
    if (wt) out.petWeight = wt[1];
  }

  // naive pet name guess: a capitalized word right before '(' OR before dates if present
  const petName1 = /:\s*([A-Z][a-zA-Z'-]+)\s*\(/.exec(t);
  const petName2 = /:\s*([A-Z][a-zA-Z'-]+)\s*(?:\d{1,2}\/\d{1,2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b)/i.exec(t);
  out.petName = (petName1?.[1] || petName2?.[1] || null);

  return out;
}

// Serialize segments for Message.extractedDatesJson
function serializeSegments(segments) {
  return JSON.stringify(segments.map(s => ({
    startISO: s.start.toISOString(),
    endISO: (s.end || s.start).toISOString(),
    text: s.text,
    kind: s.kind,
    score: s.score
  })));
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

    // Rover relay vs private number: relay will look like r.rover.com/...
    const isRelay = /r\.rover\.com/i.test(from);
    const clientPhone = isRelay ? null : from;
    const roverRelay  = isRelay ? from  : null;
    const isPrivate = !isRelay; // private = non-Rover number

    // Link/create Client only for private numbers (do NOT mark as private automatically)
    let clientId = null;
    if (!isRelay && clientPhone) {
      clientId = (await ensureClientForPrivate({ phone: clientPhone, name: from }))?.id || null;
    }

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
    const segments = parseDateSegments(body); // may be 0+, each with start/end
    const hasDates = segments.length > 0;
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
          fromPhone: clientPhone || from,
          fromLabel: from,
          body: String(body).slice(0, 2000),
          isRead: false,
          isBookingCandidate: false,
          extractedKeywordsJson: JSON.stringify(keywords),
          extractedDatesJson: serializeSegments([]),
        }
      });
      await sendPushAll({ title: '📩 New message', body: body.slice(0, 120), url: '/' });
      return res.json({ ok: true, skipped: true, reason: 'not_booking_candidate', messageId: orphan.id, eid });
    }

    // Heuristic owner/pet for Rover messages
    const roverEntities = isRelay ? extractRoverEntities(body) : null;

    // ---- Find recent booking thread (last 30d) for this sender (relay or phone) ----
    const recentBooking = await prisma.booking.findFirst({
      where: {
        ...(isRelay ? { roverRelay: from } : { clientPhone: from }),
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Create or update bookings for each segment.
    // If there are multiple segments, we create multiple PENDING bookings (one per segment).
    const createdIds = [];
    const svcBySeg = segments.map(seg => inferServiceForSegment(seg));

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const svc = svcBySeg[i];

      let booking = recentBooking;
      // If there is a recent booking but the dates are clearly different and
      // we have multiple date segments, prefer creating distinct bookings.
      const datesDiffer = booking
        ? (Math.abs(new Date(booking.startAt) - seg.start) > 60*1000 ||
           Math.abs(new Date(booking.endAt)   - (seg.end||seg.start)) > 60*1000)
        : true;

      if (!booking || datesDiffer || segments.length > 1 || booking.status === 'CANCELED') {
        booking = await prisma.booking.create({
          data: {
            source: isRelay ? 'Rover' : 'SMS',
            clientName: roverEntities?.ownerFull || roverEntities?.ownerFirst || from,
            clientPhone,
            roverRelay,
            serviceType: svc || 'Unspecified',
            dogsCount: 1,
            startAt: seg.start,
            endAt: seg.end || new Date(seg.start.getTime() + 60*60*1000),
            status: 'PENDING',
            notes: isRelay ? 'Created from Rover relay' : 'Created from SMS (booking candidate)',
            clientId: clientId || null
          }
        });

        // If we could guess a pet, create a Pet row (best effort)
        if (roverEntities?.petName) {
          await prisma.pet.create({
            data: {
              bookingId: booking.id,
              name: roverEntities.petName,
              breed: null,
              instructions: null,
              photoUrl: null,
              ageYears: null, // we only captured text
              weightLbs: roverEntities.petWeight ? Number(roverEntities.petWeight) : null
            }
          }).catch(() => {});
        }
      } else {
        // Update missing fields (service type, dates while PENDING)
        const patch = {};
        if ((booking.serviceType || 'Unspecified') === 'Unspecified' && svc && svc !== 'Unspecified') {
          patch.serviceType = svc;
        }
        const shouldRefreshDates =
          booking.status === 'PENDING' &&
          (Math.abs(new Date(booking.startAt) - seg.start) > 60*1000 ||
           Math.abs(new Date(booking.endAt)   - (seg.end||seg.start)) > 60*1000);
        if (shouldRefreshDates) {
          patch.startAt = seg.start;
          patch.endAt   = seg.end || new Date(seg.start.getTime() + 60*60*1000);
        }
        if (Object.keys(patch).length) {
          booking = await prisma.booking.update({ where: { id: booking.id }, data: patch });
        }
        // Backfill clientId if we have one now
        if (!booking.clientId && clientId) {
          await prisma.booking.update({ where: { id: booking.id }, data: { clientId } });
        }
      }

      createdIds.push(booking.id);
    }

    // --- optional auto-confirm for trusted clients (private numbers only)
    try {
      if (AUTO_CONFIRM_TRUSTED && isPrivate && clientId && createdIds.length) {
        // check the client once
        const c = await prisma.client.findUnique({
          where: { id: clientId },
          select: { trusted: true }
        });
        if (c?.trusted) {
          await Promise.allSettled(
            createdIds.map(async (id) => {
              const b = await prisma.booking.findUnique({ where: { id }, select: { status: true, notes: true } });
              if (b?.status === 'PENDING') {
                await prisma.booking.update({
                  where: { id },
                  data: { status: 'CONFIRMED', notes: (b.notes || '') + ' (auto-confirmed: trusted client)' }
                });
              }
            })
          );
        }
      }
    } catch (e) {
      console.warn('autoconfirm check failed', e?.message || e);
    }




    // ---- Create the inbound message, link to the first booking (and store all segments)
    const primaryBookingId = createdIds[0];

    await prisma.message.create({
      data: {
        eid,
        platform: 'sms',
        threadId: from,
        providerMessageId: null,
        fromPhone: clientPhone || from,
        direction: 'IN',
        channel: isRelay ? 'Rover' : 'SMS',
        fromLabel: isRelay ? (roverEntities?.ownerFull || roverEntities?.ownerFirst || from) : from,
        body: String(body).slice(0, 2000),
        isRead: false,
        isBookingCandidate: true,
        extractedKeywordsJson: JSON.stringify(keywords),
        extractedDatesJson: serializeSegments(segments),
        bookingId: primaryBookingId
      }
    });

    // ---- Push notify devices ----
    await sendPushAll({
      title: createdIds.length > 1 ? `📩 ${createdIds.length} booking dates parsed` : '📩 New booking message',
      body: `${from}: ${body.slice(0, 100)}`,
      url: createdIds.length ? `/booking/${primaryBookingId}` : '/'
    });

    return res.json({
      ok: true,
      bookingIds: createdIds,
      eid,
      segments: segments.map(s => ({
        start: s.start.toISOString(),
        end: (s.end || s.start).toISOString(),
        score: s.score,
        kind: s.kind
      }))
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});
