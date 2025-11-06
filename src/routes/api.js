// src/routes/api.js
import express from 'express';
import { prisma } from '../db.js';
import { createOrUpdateBusyEvent, deleteBusyEvent, listBusy } from '../services/calendar.js';
import { dogsInWindow } from '../services/capacity.js';
// If you need these later, they stay imported:
import { fetchPetsFromRover } from '../services/rover.js';

export const api = express.Router();

// normalize phone into last 10 digits (US-style) for consistent matching
function normPhone(p){
  if (!p) return null;
  const digits = String(p).replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : (digits || null);
}


/* ---------------- Bookings basic ---------------- */
api.get('/bookings', async (_req, res) => {
  const data = await prisma.booking.findMany({
    orderBy: { createdAt: 'desc' },
    include: { messages: true, pets: true }
  });
  res.json(data);
});

// ----- Delete a booking (hard delete) -----
// ----- Delete a booking (hard delete) -----
api.delete('/bookings/:id', async (req, res) => {
  const id = req.params.id;
  console.log('[DELETE] /api/bookings/%s', id);

  try {
    // sanity
    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) {
      console.log('[DELETE] not found', id);
      return res.status(404).json({ error: 'Not found' });
    }

    // remove children first to satisfy FKs
    const delMsgs = await prisma.message.deleteMany({ where: { bookingId: id } });
    const delPets = await prisma.pet.deleteMany({ where: { bookingId: id } });

    console.log('[DELETE] children', { msgs: delMsgs.count, pets: delPets.count });

    await prisma.booking.delete({ where: { id } });

    console.log('[DELETE] booking removed', id);
    return res.json({ ok: true, removed: id, msgs: delMsgs.count, pets: delPets.count });
  } catch (e) {
    console.error('[DELETE] failed', e);
    return res.status(500).json({ error: 'delete_failed', detail: String(e?.message || e) });
  }
});


api.get('/bookings/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } }, pets: true }
  });
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

/* ---------------- Manual create (NEW) ---------------- */
api.post('/bookings', async (req, res) => {
  try {
    const {
      clientName,
      clientPhone,
      roverRelay,
      clientEmail,
      serviceType,
      dogsCount,
      startAt,
      endAt,
      notes,
      status
    } = req.body || {};

    if (!clientName || !startAt || !endAt) {
      return res.status(400).json({ error: 'clientName, startAt, endAt are required' });
    }

    const start = new Date(startAt);
    const end   = new Date(endAt);
    if (isNaN(start) || isNaN(end)) {
      return res.status(400).json({ error: 'Invalid dates' });
    }

    const dogs = Number(dogsCount);
    const dogsSafe = Number.isFinite(dogs) && dogs > 0 ? dogs : 1;

    const phoneNorm = normPhone(clientPhone);

    const created = await prisma.booking.create({
      data: {
        source: 'Manual',
        clientName: String(clientName).trim(),
        clientPhone: phoneNorm, // <— normalized
        roverRelay: roverRelay ? String(roverRelay).trim() : null,
        clientEmail: clientEmail ? String(clientEmail).trim() : null,
        serviceType: (serviceType && String(serviceType).trim()) || 'Unspecified',
        dogsCount: dogsSafe,
        startAt: start,
        endAt: end,
        status: (status && String(status).toUpperCase()) === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING',
        notes: notes ? String(notes) : null
      }
    });

    const wantsHTML = (req.headers.accept || '').includes('text/html');
    if (wantsHTML || req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      return res.redirect(`/booking/${created.id}`);
    }
    return res.json({ ok: true, id: created.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create booking' });
  }
});

// ----- Change Requests -----
api.post('/changes/accept/:id', async (req, res) => {
  const cr = await prisma.changeRequest.findUnique({ where: { id: req.params.id } });
  if (!cr) return res.status(404).json({ error: 'Change request not found' });

  const booking = await prisma.booking.update({
    where: { id: cr.bookingId },
    data: { startAt: cr.newStartAt, endAt: cr.newEndAt }
  });

  // reflect on calendar if this booking is confirmed
  if (booking.status === 'CONFIRMED') {
    await createOrUpdateBusyEvent(booking, 'opaque');
  }

  await prisma.changeRequest.update({
    where: { id: cr.id },
    data: { status: 'ACCEPTED', decidedAt: new Date() }
  });

  res.json({ ok: true, bookingId: booking.id, newStartAt: booking.startAt, newEndAt: booking.endAt });
});

api.post('/changes/decline/:id', async (req, res) => {
  const cr = await prisma.changeRequest.update({
    where: { id: req.params.id },
    data: { status: 'DECLINED', decidedAt: new Date() }
  });
  res.json({ ok: true, declined: cr.id });
});


/* ---------------- Rover imports ---------------- */
// (kept the URL import only, since it’s what you use now)
api.post('/rover/import-url/:id', async (req, res) => {
  try {
    const b = await prisma.booking.findUnique({ where: { id: req.params.id }});
    if (!b) return res.status(404).json({ error: 'Not found' });

    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Please provide a valid Rover dog profile URL.' });
    }

    const pet = await (await import('../services/rover.js')).fetchPetFromProfileUrl(url);
    if (!pet) return res.status(404).json({ error: 'Could not read a pet from that URL.' });

    const created = await prisma.pet.create({ data: { bookingId: b.id, ...pet } });
    const updated = await prisma.booking.findUnique({
      where: { id: b.id }, include: { pets: true }
    });

    res.json({ ok: true, added: created, pets: updated.pets });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Import by URL failed' });
  }
});

/* ---------------- Actions: confirm/decline ---------------- */
api.post('/actions/confirm/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({ where: { id: req.params.id }});
  if (!b) return res.status(404).json({ error: 'Not found' });

  const currentDogs = await dogsInWindow(b.startAt, b.endAt);
  const newTotal = currentDogs + (b.dogsCount || 1);
  const transparency = newTotal >= 10 ? 'opaque' : 'transparent';

  const updated = await prisma.booking.update({
    where: { id: b.id }, data: { status: 'CONFIRMED' }
  });

  await createOrUpdateBusyEvent(updated, transparency);
  res.json({ ok: true, newTotal, transparency, status: updated.status });
});

api.post('/actions/decline/:id', async (req, res) => {
  const b = await prisma.booking.update({
    where: { id: req.params.id }, data: { status: 'CANCELED' }
  });
  await deleteBusyEvent(b.id);
  res.json({ ok: true });
});

/* ---------------- Pets create/update ---------------- */
api.post('/bookings/:id/pets', async (req, res) => {
  const booking = await prisma.booking.findUnique({ where: { id: req.params.id }});
  if (!booking) return res.status(404).json({ error: 'Not found' });

  const { petId, name, breed, ageYears, weightLbs, instructions, photoUrl } = req.body;

  let pet;
  if (petId) {
    pet = await prisma.pet.update({
      where: { id: petId },
      data: {
        name,
        breed,
        ageYears: numOrNull(ageYears),
        weightLbs: numOrNull(weightLbs),
        instructions,
        photoUrl
      }
    });
  } else {
    pet = await prisma.pet.create({
      data: {
        bookingId: booking.id,
        name: name || 'Dog',
        breed,
        ageYears: numOrNull(ageYears),
        weightLbs: numOrNull(weightLbs),
        instructions,
        photoUrl
      }
    });
  }
  res.json({ ok: true, pet });
});
function numOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

/* ---------------- Two-way SMS (disabled) ---------------- */
api.post('/bookings/:id/reply', async (_req, res) => res.status(403).json({ error: 'two_way_disabled' }));
api.get('/outbox/next',        async (_req, res) => res.status(403).json({ error: 'two_way_disabled' }));
api.get('/outbox/ack',         async (_req, res) => res.status(410).send('two_way_disabled'));
api.post('/outbox/ack',        async (_req, res) => res.status(410).json({ error: 'two_way_disabled' }));

/* ---------------- Templates ---------------- */
api.get('/templates/:kind/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { pets: true }});
  if (!b) return res.status(404).json({ error: 'Not found' });

  const { kind } = req.params;
  const now = new Date();
  const start = new Date(b.startAt);
  const daysUntil = Math.ceil((start - now) / (1000*60*60*24));
  const petNames = b.pets.length ? b.pets.map(p => p.name).join(', ') : 'your dog';

  if (kind === 'cancel') {
    const within3 = daysUntil <= 3;
    const feeText = within3 ? 'As per my policy, a 50% LATE-CANCELLATION FEE (50%) applies.' : 'No late-cancellation fee applies.';
    const msg =
`Hi! I’m sorry to hear you need to cancel ${formatRange(b.startAt, b.endAt)} for ${petNames}.
${feeText}
Please confirm and I’ll finalize the cancellation.`;
    return res.json({ text: msg, within3 });
  }

  if (kind === 'confirm') {
    const msg =
`Great! I have you down for ${b.serviceType} on ${formatRange(b.startAt, b.endAt)} for ${petNames}.
To confirm, please reply YES. If you need changes, let me know.`;
    return res.json({ text: msg });
  }

  if (kind === 'ask-photos') {
    const msg =
`Could you send a couple of clear PHOTOS of your dog and any CARE INSTRUCTIONS (feeding, meds, routines)?
This helps me prepare and keep ${petNames} comfy. Thank you!`;
    return res.json({ text: msg });
  }

  res.status(400).json({ error: 'Unknown template kind' });
});
function formatRange(startAt, endAt){
  const s = new Date(startAt), e = new Date(endAt);
  return `${s.toLocaleString()} – ${e.toLocaleString()}`;
}

/* ---------------- Edit / availability ---------------- */
api.patch('/bookings/:id', async (req, res) => {
  const { startAt, endAt, serviceType, dogsCount, notes } = req.body;
  const updated = await prisma.booking.update({
    where: { id: req.params.id },
    data: {
      serviceType: serviceType ?? undefined,
      dogsCount: dogsCount ? Number(dogsCount) : undefined,
      notes: notes ?? undefined,
      ...(startAt ? { startAt: new Date(startAt) } : {}),
      ...(endAt   ? { endAt:   new Date(endAt)   } : {}),
    }
  });
  res.json(updated);
});

api.get('/availability', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required (ISO or ms)' });

  const startAt = new Date(start);
  const endAt   = new Date(end);

  const busy = await listBusy(startAt, endAt);
  const calendarConnected = !!(process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);

  const currentDogs = await dogsInWindow(startAt, endAt);
  const capacity = 10;

  res.json({
    ok: true,
    window: { startAt, endAt },
    busy,
    dogsOverlapping: currentDogs,
    willExceed: currentDogs >= capacity,
    calendarConnected
  });
});
