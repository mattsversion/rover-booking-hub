// src/routes/webhooks.js
import express from 'express';
import { prisma } from '../db.js';

export const webhooks = express.Router();

// Accept urlencoded (form) and raw text on this path:
webhooks.use('/sms-forward',
  express.urlencoded({ extended: true }),
  express.text({ type: '*/*' }) // when Tasker sends raw text without a header
);

// Optional GET helper
webhooks.get('/sms-forward', (req, res) => {
  res.send('Webhook is up. Use POST with JSON or form fields: {from, body, timestamp}.');
});

webhooks.post('/sms-forward', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.SMS_FORWARD_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let from, body, timestamp;

    // 1) JSON (if app-wide express.json() parsed it)
    if (req.is('application/json') && req.body && typeof req.body === 'object') {
      ({ from, body, timestamp } = req.body);

    // 2) Raw text that contains JSON
    } else if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
      try { ({ from, body, timestamp } = JSON.parse(req.body)); } catch { /* ignore */ }

    // 3) Form fields (application/x-www-form-urlencoded)
    } else if (req.body && typeof req.body === 'object') {
      ({ from, body, timestamp } = req.body);
    }

    // 4) Last resort: query params
    if (!from && req.query) {
      from = req.query.from;
      body = req.query.body;
      timestamp = req.query.timestamp;
    }

    if (!from || !body) return res.status(400).json({ error: 'Missing fields' });

    console.log('SMS webhook hit:', { from, body, timestamp });

    const now = new Date(Number(timestamp) || Date.now());
    let booking = await prisma.booking.findFirst({
      where: {
        OR: [{ clientPhone: from }, { roverRelay: from }],
        status: { in: ['PENDING', 'CONFIRMED'] },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!booking) {
      booking = await prisma.booking.create({
        data: {
          source: 'SMS',
          clientName: from,
          clientPhone: from,
          roverRelay: from,
          serviceType: 'Unspecified',
          startAt: now,
          endAt: new Date(now.getTime() + 60 * 60 * 1000),
          status: 'PENDING',
          notes: 'Created from SMS (Tasker)'
        }
      });
    }

    await prisma.message.create({
      data: {
        bookingId: booking.id,
        direction: 'IN',
        channel: 'SMS',
        fromLabel: from,
        body: String(body).slice(0, 2000)
      }
    });

    return res.json({ ok: true, bookingId: booking.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});
