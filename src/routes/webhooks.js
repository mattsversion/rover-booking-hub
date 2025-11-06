// src/routes/webhooks.js
import express from 'express';
import { prisma } from '../db.js';
import { buildEID } from '../services/utils/eid.js';
import webpush from 'web-push';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyMessage } from '../services/classifier.js';


// intake helpers (centralized)
import {
  findKeywords,
  classifyService,
  extractPetNames,
  serializeRange,      // still used for backward compatibility if needed
  parseSegments,       // NEW: multi-segment parser
  extractRoverMeta     // NEW: owner/pet/age/weight (Rover-style)
} from '../services/intake.js';

export const webhooks = express.Router();

// ---------- Web Push wiring ----------
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// normalize phone for matching (strip everything but digits; keep last 10 if US-like)
function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D+/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
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

// -------------------- Main intake --------------------
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

    // EID dedupe (BEFORE writes)
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

    // Optional AI classification
    let classifyLabel = null, classifyScore = null, extractedJson = null;
    try {
      const { label, score, extracted } = await classifyMessage(body);
      classifyLabel = label;
      classifyScore = score;
      extractedJson = extracted ? JSON.stringify(extracted) : null;
    } catch {
      // best-effort; ignore failures
    }

    // ---- Heuristics (keywords + segments) ----
    const keywords   = findKeywords(body);
    const svcGuess   = classifyService(body);
    const segments   = parseSegments(body, receivedAt); // [{startAt,endAt,serviceHint}, ...]
    const roverMeta  = extractRoverMeta(body);          // {ownerName, petName, petAgeMonths, petWeightLbs}

    // strict gate: must have keywords AND at least one segment AND not purely "Walk"
    const isWalkOnly = svcGuess === 'Walk';
    const isCandidate = (keywords.length > 0) && segments.length > 0 && !isWalkOnly;

    // We will attach the inbound message to the FIRST booking we create/patch (if any)
    let bookingId = null;

    // try attaching to an open thread for this exact phone first (best defense against dupes)
    const fromNorm = normPhone(from);

    // highest priority: a recent PENDING or CONFIRMED booking for this phone (any date)
    let openThread = null;
    if (fromNorm) {
      openThread = await prisma.booking.findFirst({
        where: {
          clientPhone: { not: null },
          status: { in: ['PENDING', 'CONFIRMED'] },
          AND: [
            // compare normalized versions
            { clientPhone: { endsWith: fromNorm } } // works even if saved with separators
          ]
        },
        orderBy: { createdAt: 'desc' }
      });
    }

    if (openThread) {
      bookingId = openThread.id;
    }

    if (!openThread && isCandidate) {
      // if we didn't find an open thread, fall back to your previous “segment-aware” behavior
      for (let idx = 0; idx < segments.length; idx++) {
        const seg = segments[idx];
        const inferredSvc = svcGuess !== 'Unspecified' ? svcGuess : (seg.serviceHint || 'Unspecified');

        // try to reuse a recent booking for this phone near the start date (legacy behavior)
        let booking = null;
        if (fromNorm) {
          booking = await prisma.booking.findFirst({
            where: {
              OR: [
                { clientPhone: { endsWith: fromNorm } },
                { roverRelay: from }
              ],
              AND: [
                { startAt: { gte: new Date(seg.startAt.getTime() - 2*24*60*60*1000) } },
                { startAt: { lte: new Date(seg.startAt.getTime() + 2*24*60*60*1000) } }
              ]
            },
            orderBy: { createdAt: 'desc' }
          });
        }

        if (!booking || booking.status === 'CANCELED') {
          booking = await prisma.booking.create({
            data: {
              source: body.includes('r.rover.com') ? 'Rover' : 'SMS',
              clientName: roverMeta.ownerName || from,
              clientPhone: from,
              roverRelay: from.includes('r.rover.com') ? from : null,
              serviceType: inferredSvc,
              startAt: seg.startAt,
              endAt: seg.endAt,
              status: 'PENDING',
              notes: 'Created from SMS (filtered booking candidate)'
            }
          });
        } else {
          const patch = {};
          if ((booking.serviceType || 'Unspecified') === 'Unspecified' && inferredSvc !== 'Unspecified') {
            patch.serviceType = inferredSvc;
          }
          const needDates =
            Math.abs(new Date(booking.startAt) - seg.startAt) > 60 * 1000 ||
            Math.abs(new Date(booking.endAt)   - seg.endAt)   > 60 * 1000;
          if (needDates) {
            patch.startAt = seg.startAt;
            patch.endAt   = seg.endAt;
          }
          if (Object.keys(patch).length) {
            booking = await prisma.booking.update({ where: { id: booking.id }, data: patch });
          }
        }

        if (idx === 0) bookingId = booking.id;

        // (pet inference block unchanged)
      }
    }


    // Store the inbound message (bookingId may be null)
    const extractedDatesJson = JSON.stringify(
      segments.map(s => ({
        startISO: s.startAt.toISOString(),
        endISO:   s.endAt.toISOString()
      }))
    );

    await prisma.message.create({
      data: {
        eid,
        platform: 'sms',
        threadId: from,
        providerMessageId: null,
        fromPhone: from,
        direction: 'IN',
        channel: 'SMS',
        fromLabel: roverMeta.ownerName || from,
        body: String(body).slice(0, 2000),
        isRead: false,
        isBookingCandidate: isCandidate,
        extractedKeywordsJson: JSON.stringify(keywords),
        extractedDatesJson,
        classifyLabel,
        classifyScore,
        extractedJson,
        bookingId
      }
    });

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
