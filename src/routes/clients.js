import express from 'express';
import { prisma } from '../db.js';

export const clientsRouter = express.Router();

// normalize phone (simple)
const normPhone = (p = '') =>
  p.replace(/[^\d+]/g, '').replace(/^1(\d{10})$/, '+$1').trim();

/**
 * GET /clients
 * Optional search: ?q=...
 * Enrich each client with quick insights (total, last booking, LTV-ish score)
 */
clientsRouter.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();

  const where = q
    ? {
        OR: [
          { phone: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};

  const base = await prisma.client.findMany({
    where,
    orderBy: [{ trusted: 'desc' }, { updatedAt: 'desc' }],
  });

  const clients = await Promise.all(
    base.map(async (c) => {
      const bookings = await prisma.booking.findMany({
        where: {
          OR: [
            { clientPhone: c.phone },
            c.name
              ? { clientName: { equals: c.name, mode: 'insensitive' } }
              : undefined,
          ].filter(Boolean),
        },
        orderBy: { startAt: 'desc' },
      });

      const total = bookings.length;
      const lastBookingAt = bookings[0]?.startAt || null;

      // crude LTV proxy
      const ltvScore = bookings.reduce((sum, b) => {
        const days = Math.max(
          1,
          Math.round((b.endAt - b.startAt) / (24 * 60 * 60 * 1000))
        );
        const weight = /overnight/i.test(b.serviceType || '')
          ? 1.0
          : /day\s*care/i.test(b.serviceType || '')
          ? 0.5
          : /walk/i.test(b.serviceType || '')
          ? 0.2
          : 0.3;
        return sum + days * weight;
      }, 0);

      return {
        ...c,
        insights: {
          totalBookings: total,
          lastBookingAt,
          ltvScore: Number(ltvScore.toFixed(1)),
        },
      };
    })
  );

  res.render('clients', { clients });
});

/**
 * POST /clients/add
 * Create or update by phone; marks as private automatically, optional name and trusted flag
 */
clientsRouter.post('/add', async (req, res) => {
  const phone = normPhone(req.body.phone || '');
  const name = (req.body.name || '').trim() || null;
  const trusted = !!req.body.trusted;
  const isPrivate = true;

  if (!phone) return res.status(400).send('phone required');

  const existing = await prisma.client.findUnique({ where: { phone } });
  if (existing) {
    await prisma.client.update({
      where: { id: existing.id },
      data: {
        name: existing.name || name,
        isPrivate: true,
        trusted,
      },
    });
  } else {
    await prisma.client.create({
      data: { phone, name, isPrivate, trusted },
    });
  }

  res.redirect('/clients');
});

/**
 * POST /clients/:id/trusted?on=1|0
 * Explicit trust on/off
 */
clientsRouter.post('/:id/trusted', async (req, res) => {
  const on = (req.query.on || '').toLowerCase();
  const trusted = on === '1' || on === 'true' || on === 'yes';
  await prisma.client.update({
    where: { id: req.params.id },
    data: { trusted },
  });
  res.redirect('/clients');
});

/**
 * POST /clients/:id/toggle-private
 */
clientsRouter.post('/:id/toggle-private', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
  await prisma.client.update({
    where: { id: c.id },
    data: { isPrivate: !c.isPrivate },
  });
  res.redirect('/clients');
});

/**
 * POST /clients/:id/delete
 */
clientsRouter.post('/:id/delete', async (req, res) => {
  await prisma.client
    .delete({ where: { id: req.params.id } })
    .catch(() => {});
  res.redirect('/clients');
});
