import express from 'express';
import { prisma } from '../db.js';

export const clientsRouter = express.Router();

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 0206248 (clients: single router export; import + mount once; add simple trust/private UI)
=======
>>>>>>> 0a41fd8 (WIP: clients page, analytics view, server/webhooks updates)
// list trusted/private clients
clientsRouter.get('/', async (_req, res) => {
  const rows = await prisma.client.findMany({
    orderBy: [{ name: 'asc' }, { phone: 'asc' }]
<<<<<<< HEAD
=======
clientsRouter.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const where = q ? {
    OR: [
      { phone: { contains: q, mode: 'insensitive' } },
      { name:  { contains: q, mode: 'insensitive' } },
    ],
  } : {};

  const clients = await prisma.client.findMany({
    where,
    orderBy: [{ trusted: 'desc' }, { updatedAt: 'desc' }],
>>>>>>> 794ce02 (merge: resolve clients route conflict; clients view uses global layout + trust toggle)
=======
>>>>>>> 0a41fd8 (WIP: clients page, analytics view, server/webhooks updates)
  });
  res.render('clients', { clients: rows });
});

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 0206248 (clients: single router export; import + mount once; add simple trust/private UI)
// add/update via form (phone is unique)
clientsRouter.post('/upsert', async (req, res) => {
  const { phone, name } = req.body;
=======
clientsRouter.post('/save', async (req, res) => {
  const phone = (req.body.phone || '').trim();
  if (!phone) return res.status(400).send('phone required');
  const name      = (req.body.name || '').trim() || null;
>>>>>>> 794ce02 (merge: resolve clients route conflict; clients view uses global layout + trust toggle)
=======
// add/update via form (phone is unique)
clientsRouter.post('/upsert', async (req, res) => {
  const { phone, name } = req.body;
>>>>>>> 0a41fd8 (WIP: clients page, analytics view, server/webhooks updates)
  const isPrivate = !!req.body.isPrivate;
  const trusted   = !!req.body.trusted;
  if (!phone) return res.status(400).send('phone required');

  await prisma.client.upsert({
    where: { phone },
    create: { phone, name: name || null, isPrivate, trusted },
    update: { name: name || null, isPrivate, trusted }
  });
  res.redirect('/clients');
});

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
// toggles
=======
>>>>>>> 794ce02 (merge: resolve clients route conflict; clients view uses global layout + trust toggle)
=======
// toggles
>>>>>>> 0206248 (clients: single router export; import + mount once; add simple trust/private UI)
clientsRouter.post('/:id/toggle-trust', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
<<<<<<< HEAD
=======
// toggles
clientsRouter.post('/:id/toggle-trust', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
>>>>>>> 0a41fd8 (WIP: clients page, analytics view, server/webhooks updates)
  await prisma.client.update({ where: { id: c.id }, data: { trusted: !c.trusted } });
  res.redirect('/clients');
});

clientsRouter.post('/:id/toggle-private', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
  await prisma.client.update({ where: { id: c.id }, data: { isPrivate: !c.isPrivate } });
  res.redirect('/clients');
});

// src/routes/clients.js  (keep your existing list; just enrich)
router.get('/clients', async (_req, res) => {
  const clients = await prisma.client.findMany({
    orderBy: [{ trusted: 'desc' }, { updatedAt: 'desc' }],
  });

  // For each client, pull quick aggregates
  const enriched = await Promise.all(clients.map(async (c) => {
    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { clientPhone: c.phone },
          { clientName: c.name ? { equals: c.name, mode:'insensitive' } : undefined }
        ].filter(Boolean)
      },
      orderBy: { startAt: 'desc' }
    });

    const total = bookings.length;
    const last  = bookings[0]?.startAt || null;

    // simple LTV proxy: overnight=1.0, daycare=0.5, walk=0.2 credit per day
    const ltv = bookings.reduce((sum, b) => {
      const days = Math.max(1, Math.round((b.endAt - b.startAt)/(24*60*60*1000)));
      const weight =
        /overnight/i.test(b.serviceType||'') ? 1.0 :
        /daycare/i.test(b.serviceType||'')  ? 0.5 :
        /walk/i.test(b.serviceType||'')     ? 0.2 : 0.3;
      return sum + days * weight;
    }, 0);

    return { ...c, insights: { totalBookings: total, lastBookingAt: last, ltvScore: Number(ltv.toFixed(1)) } };
  }));

  res.render('clients', { clients: enriched });
});


export { router as clientsRouter };
<<<<<<< HEAD
=======
  await prisma.client.update({
    where: { id },
    data: { trusted: !c.trusted, isPrivate: true },
  });
  res.redirect('/clients');
});

clientsRouter.post('/:id/delete', async (req, res) => {
  await prisma.client.delete({ where: { id: req.params.id } }).catch(()=>{});
  res.redirect('/clients');
});
>>>>>>> 794ce02 (merge: resolve clients route conflict; clients view uses global layout + trust toggle)
=======
>>>>>>> 0a41fd8 (WIP: clients page, analytics view, server/webhooks updates)
