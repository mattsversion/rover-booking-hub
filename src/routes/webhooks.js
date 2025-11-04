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

/* ---------------------- Web Push wiring ---------------------- */
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Persisted subscriptions (JSON file; db table would be fine too)
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

/* ------------------- helpers / normalization ------------------ */
function serializeSegments(extracted) {
  // store classifier output segments verbatim for debugging/exports
  if (!extracted?.segments?.length) return null;
  return JSON.stringify(extracted.segments);
}

function inferServiceFromExtracted(extracted) {
  if (!extracted?.segments?.length) return extracted?.serviceType || 'Unspecified';
  // if any segment has endAt -> Overnight, else Daycare (matches your rule)
  const hasRange = extracted.segments.some(s => !!s.endAt);
  return hasRange ? 'Overnight' : 'Daycare';
}

function firstSegmentDates(extracted) {
  const seg = extracted?.segments?.[0];
  if (!seg) return { startAt: null, endAt: null };
  return {
    startAt: seg.startAt ? new Date(seg.startAt) : null,
    endAt: seg.endAt ? new Date(seg.endAt) : null,
  };
}

/* ------------------ flexible body formats -------------------- */
webhooks.use(
  '/sms-forward',
  express.urlencoded({ extended: true }),
  express.text({ type: '*/*' }) // allow raw body
);

webhooks.get('/sms-forward', (_req, res) => {
  res.send('Webhook is up. Use POST with JSON or form fields: {from, body, timestamp}.');
});

webhooks.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ------------------- inbound SMS forwarder ------------------- */
webhooks.post('/sms-forward', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.SMS_FORWARD_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Parse payload (json / form / raw / query)
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

    // Stable message EID (dedupe BEFORE any writes)
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

    // Strict classification (regex-first in classifier.js)
    let classifyLabel = null, classifyScore = null, extracted = null, extractedJson = null;
    try {
      const out = await classifyMessage(body);
      classifyLabel = out?.label || null;
      classifyScore = out?.score ?? null;
      extracted = out?.extracted || null;
      extractedJson = extracted ? JSON.stringify(extracted) : null;
    } catch {
      // classifier optional; proceed with no candidate
    }

    const isCandidate = classifyLabel === 'BOOKING_REQUEST';

    // Try to find a recent booking thread for this number (last 60d)
    let booking = await prisma.booking.findFirst({
      where: {
        OR: [{ clientPhone: from }, { roverRelay: from }],
        createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) }
      },
      orderBy: { createdAt: 'desc' }
    });

    // If candidate and no booking exists -> create one
    if (isCandidate && !booking) {
      const serviceType = inferServiceFromExtracted(extracted);
      const { startAt, endAt } = firstSegmentDates(extracted);

      booking = await prisma.booking.create({
        data: {
          source: 'SMS',
          clientName: from,           // you can improve with your own name heuristics later
          clientPhone: from,
          roverRelay: null,
          serviceType: serviceType || 'Unspecified',
          startAt: startAt || receivedAt,
          endAt: endAt || (startAt || receivedAt),
          status: 'PENDING',
          notes: 'Created from SMS (booking candidate)'
        }
      });
    }

    // Create the inbound message
    const msg = await prisma.message.create({
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
        extractedKeywordsJson: null, // no longer using heuristic keywords
        extractedDatesJson: serializeSegments(extracted),
        classifyLabel,
        classifyScore,
        extractedJson,
        bookingId: booking?.id || null // attach if a booking exists
      }
    });

    // If we created/found a booking and this was a candidate, we may want to refresh its dates/service
    if (booking && isCandidate && extracted?.segments?.length) {
      const patch = {};
      const svc = inferServiceFromExtracted(extracted);
      if (svc && (booking.serviceType || 'Unspecified') === 'Unspecified') {
        patch.serviceType = svc;
      }
      const { startAt, endAt } = firstSegmentDates(extracted);
      if (startAt && endAt && booking.status === 'PENDING') {
        // only update if they differ meaningfully
        const diffStart = booking.startAt ? Math.abs(new Date(booking.startAt) - startAt) : Infinity;
        const diffEnd   = booking.endAt   ? Math.abs(new Date(booking.endAt)   - endAt)   : Infinity;
        if (diffStart > 60 * 1000 || diffEnd > 60 * 1000) {
          patch.startAt = startAt;
          patch.endAt = endAt;
        }
      }
      if (Object.keys(patch).length) {
        await prisma.booking.update({ where: { id: booking.id }, data: patch });
      }
    }

    // Push notify
    await sendPushAll({
      title: isCandidate ? '📩 New booking message' : '📩 New message',
      body: `${from}: ${body.slice(0, 100)}`,
      url: (booking && isCandidate) ? `/booking/${booking.id}` : '/'
    });

    return res.json({
      ok: true,
      bookingId: booking?.id || null,
      isCandidate,
      eid,
      classifyLabel,
      classifyScore
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});
