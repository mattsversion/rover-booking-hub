<<<<<<< HEAD
=======
// src/routes/clients.js
>>>>>>> b7eb8a1 (clients: add /clients UI (list/search), upsert, and trust toggle; mount route)
import express from 'express';
import { prisma } from '../db.js';

export const clientsRouter = express.Router();

<<<<<<< HEAD
// list trusted/private clients
clientsRouter.get('/', async (_req, res) => {
  const rows = await prisma.client.findMany({
    orderBy: [{ name: 'asc' }, { phone: 'asc' }]
  });
  res.render('clients', { clients: rows });
});

// add/update via form (phone is unique)
clientsRouter.post('/upsert', async (req, res) => {
  const { phone, name } = req.body;
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

// toggles
clientsRouter.post('/:id/toggle-trust', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
  await prisma.client.update({ where: { id: c.id }, data: { trusted: !c.trusted } });
  res.redirect('/clients');
});

clientsRouter.post('/:id/toggle-private', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
  await prisma.client.update({ where: { id: c.id }, data: { isPrivate: !c.isPrivate } });
  res.redirect('/clients');
});

export { router as clientsRouter };
=======
// list + search
clientsRouter.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const where = q
    ? {
        OR: [
          { phone: { contains: q, mode: 'insensitive' } },
          { name:  { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};

  const clients = await prisma.client.findMany({
    where,
    orderBy: [{ trusted: 'desc' }, { updatedAt: 'desc' }],
  });

  res.render('clients', { clients, q });
});

// upsert by phone (create or update)
clientsRouter.post('/save', async (req, res) => {
  const phone = (req.body.phone || '').trim();
  if (!phone) return res.status(400).send('phone required');

  const name      = (req.body.name || '').trim() || null;
  const isPrivate = !!req.body.isPrivate;
  const trusted   = !!req.body.trusted;

  await prisma.client.upsert({
    where: { phone },
    update: { name, isPrivate, trusted },
    create: { phone, name, isPrivate, trusted },
  });

  res.redirect('/clients');
});

// toggle trust
clientsRouter.post('/:id/toggle-trust', async (req, res) => {
  const id = req.params.id;
  const c = await prisma.client.findUnique({ where: { id } });
  if (!c) return res.status(404).send('not found');

  await prisma.client.update({
    where: { id },
    data: { trusted: !c.trusted, isPrivate: true }, // trusting implies private
  });

  res.redirect('/clients');
});

// delete client (optional)
clientsRouter.post('/:id/delete', async (req, res) => {
  await prisma.client.delete({ where: { id: req.params.id } }).catch(()=>{});
  res.redirect('/clients');
});
>>>>>>> b7eb8a1 (clients: add /clients UI (list/search), upsert, and trust toggle; mount route)
