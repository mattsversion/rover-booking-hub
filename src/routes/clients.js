// src/routes/clients.js
import express from 'express';
import { prisma } from '../db.js';

export const clients = express.Router(); // <-- named export

// List ONLY private (non-Rover) clients
clients.get('/', async (_req, res) => {
  const rows = await prisma.client.findMany({
    where: { isPrivate: true },
    orderBy: [{ name: 'asc' }, { phone: 'asc' }]
  });
  res.render('clients', { clients: rows }); // layout is global
});

// Create/update from the form
clients.post('/upsert', async (req, res) => {
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

// Toggle trusted on a client
clients.post('/:id/toggle-trust', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
  await prisma.client.update({ where: { id: c.id }, data: { trusted: !c.trusted } });
  res.redirect('/clients');
});

// Toggle private on a client
clients.post('/:id/toggle-private', async (req, res) => {
  const c = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).send('not found');
  await prisma.client.update({ where: { id: c.id }, data: { isPrivate: !c.isPrivate } });
  res.redirect('/clients');
});
