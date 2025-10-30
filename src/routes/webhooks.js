import express from 'express';
import { prisma } from '../db.js';
import * as chrono from 'chrono-node';
import { buildEID } from '../services/utils/eid.js';

export const webhooks = express.Router();

webhooks.use('/sms-forward',
  express.urlencoded({ extended: true }),
  express.text({ type: '*/*' })
);

webhooks.get('/sms-forward', (_req, res) => {
  res.send('Webhook is up. Use POST with JSON or form fields: {from, body, timestamp}.');
});

webhooks.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

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

function parseDates(text) {
  if (!text) return [];
  const ref = new Date();
  const results = chrono.parse(text, ref, { forwardDate: true });
  return results
    .map(r => ({
      start: r.start?.date() ?? null,
      end: r.end?.date() ?? r.start?.date() ?? null,
      text: r.text
    }))
    .filter(d => d.start);
}

webhooks.post('/sms-forward', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.SMS_FORWARD_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let from, body, timestamp;

    if (req.is('application/json') && req.body && typeof req.body === 'object') {
      ({ from, body, timestamp } = req.body);
    } else if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
      try { ({ from, body, timestamp } = JSON.parse(req.body)); } catch {}
    } else if (req.body && typeof req.body === 'object') {
      ({ from, body, timestamp } = req.body);
    }
    if (!from && req.query) {
      from = req.query.from;
      body = req.query.body;
      timestamp = req.query.timestamp;
    }
    if (!from || !body) return res.status(400).json({ error: 'Missing fields' });

    const receivedAt = new Date(Number(timestamp) || Date.now());

    // ---- FILTERING ----
    const keywords = findKeywords(body);
    const dates = parseDates(body);
    const isCandidate = (keywords.length > 0) && (dates.length > 0);

    if (!isCandidate) {
      // silently accept but don't store (you asked to save only booking-like messages)
      return res.json({ ok: true, skipped: true, reason: 'not_booking_candidate' });
    }

    // find or create a booking for this sender (last 30 days)
    let booking = await prisma.booking.findFirst({
      where: {
        OR: [{ clientPhone: from }, { roverRelay: from }],
        status: { in: ['PENDING', 'CONFIRMED'] },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!booking) {
      // If the text has dates, we can seed a 1h placeholder window; you can refine later.
      const startAt = dates[0]?.start || receivedAt;
      const endAt = dates[0]?.end || new Date(startAt.getTime() + 60 * 60 * 1000);

      booking = await prisma.booking.create({
        data: {
          source: 'SMS',
          clientName: from,
          clientPhone: from,
          roverRelay: from,
          serviceType: 'Unspecified',
          startAt,
          endAt,
          status: 'PENDING',
          notes: 'Created from SMS (filtered booking candidate)'
        }
      });
    }

    // Build a stable EID to dedupe replays
    const eid = buildEID({
      platform: 'sms',
      threadId: from,
      providerMessageId: undefined,
      from,
      body,
      timestamp: receivedAt.getTime()
    });

    // Upsert by EID
// helpers to serialize
function datesToSerializable(dates) {
  return dates.map(d => ({
    startISO: d.start ? new Date(d.start).toISOString() : null,
    endISO:   d.end   ? new Date(d.end).toISOString()   : null,
    text: d.text || ''
  }));
}

await prisma.message.upsert({
  where: { eid },
  update: {
    body: String(body).slice(0, 2000),
    isBookingCandidate: true,
    extractedKeywordsJson: JSON.stringify(keywords),
    extractedDatesJson: JSON.stringify(datesToSerializable(dates))
  },
  create: {
    eid,
    platform: 'sms',
    threadId: from,
    providerMessageId: null,
    fromPhone: from,
    isBookingCandidate: true,
    extractedKeywordsJson: JSON.stringify(keywords),
    extractedDatesJson: JSON.stringify(datesToSerializable(dates)),

    bookingId: booking.id,
    direction: 'IN',
    channel: 'SMS',
    fromLabel: from,
    body: String(body).slice(0, 2000)
  }
});


    return res.json({ ok: true, bookingId: booking.id, eid });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});
