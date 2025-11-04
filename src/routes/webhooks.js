// src/routes/webhooks.js
import express from 'express';
import { prisma } from '../db.js';
import { buildEID } from '../services/utils/eid.js';
import webpush from 'web-push';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyMessage } from '../services/classifier.js';

// use shared intake helpers (do NOT re-declare them here)
import {
  findKeywords,
  pickDateRange,
  classifyService,
  extractPetNames,
  serializeRange,
} from '../services/intake.js';

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

// main intake
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

    // EID dedupe
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
    } catch {}

    // Heuristics (keywords + real date)
    const keywords = findKeywords(body);
    const range    = pickDateRange(body, receivedAt);
    const hasDates = !!range;

    // strict gate
    const isCandidate = (keywords.length > 0) && hasDates;

    // Only attach/create a booking when candidate
    let bookingId = null;

    if (isCandidate) {
      let booking = await prisma.booking.findFirst({
        where: {
          OR: [{ clientPhone: from }, { roverRelay: from }],
          createdAt: { gte: new Date(Date.now() - 30 * 24*60*60*1000) }
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

      // Pet best-effort attach (simple, schema-safe)
      try {
        const pets = extractPetNames(body);
        for (const name of pets) {
          const existing = await prisma.pet.findFirst({
            where: { name, bookings: { some: { id: booking.id } } }
          }).catch(()=>null);

          if (!existing) {
            const pet = await prisma.pet.create({ data: { name } });
            await prisma.booking.update({
              where: { id: booking.id },
              data: { pets: { connect: { id: pet.id } } }
            });
          }
        }
      } catch {}
    }

    // Store the inbound message (bookingId may be null)
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
