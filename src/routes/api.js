// src/routes/api.js
import express from 'express';
import { prisma } from '../db.js';
import { createOrUpdateBusyEvent, deleteBusyEvent, listBusy } from '../services/calendar.js';
import { dogsInWindow } from '../services/capacity.js';
import { fetchPetsFromRover, fetchPetFromProfileUrl } from '../services/rover.js';

export const api = express.Router();

/* -------- Bookings basic -------- */
api.get('/bookings', async (_req, res) => {
  const data = await prisma.booking.findMany({
    orderBy: { createdAt: 'desc' },
    include: { messages: true, pets: true }
  });
  res.json(data);
});

api.get('/bookings/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } }, pets: true }
  });
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

/* -------- Rover imports -------- */
// Import pet info by searching Rover conversation/request
api.post('/rover/import/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({ where: { id: req.params.id }});
  if (!b) return res.status(404).json({ error: 'Not found' });

  const hint = { externalId: b.externalId || undefined, relay: b.roverRelay || b.clientPhone || undefined };

  try {
    const pets = await fetchPetsFromRover(hint);
    if (!pets?.length) return res.status(404).json({ error: 'No pets found on Rover page' });

    await prisma.pet.deleteMany({ where: { bookingId: b.id }});
    for (const p of pets) await prisma.pet.create({ data: { bookingId: b.id, ...p }});

    const updated = await prisma.booking.findUnique({ where: { id: b.id }, include: { pets: true }});
    res.json({ ok: true, pets: updated.pets });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Rover import failed' });
  }
});

// Import ONE pet directly from a Rover dog profile URL
api.post('/rover/import-by-url/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({ where: { id: req.params.id }});
  if (!b) return res.status(404).json({ error: 'Not found' });

  const { url } = req.body || {};
  if (!url || !/^https?:\/\/(www\.)?rover\.com\/.+\/dogs\//i.test(url)) {
    return res.status(400).json({ error: 'Provide a valid Rover dog profile URL' });
  }

  try {
    const pet = await fetchPetFromProfileUrl(url);
    if (!pet) return res.status(404).json({ error: 'Could not read pet profile' });

    const saved = await prisma.pet.create({ data: { bookingId: b.id, ...pet }});
    res.json({ ok: true, pet: saved });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Rover import failed' });
  }
});

/* -------- Actions: confirm/decline -------- */
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

/* -------- Pets create/update -------- */
api.post('/bookings/:id/pets', async (req, res) => {
  const booking = await prisma.booking.findUnique({ where: { id: req.params.id }});
  if (!booking) return res.status(404).json({ error: 'Not found' });

  const { petId, name, breed, ageYears, weightLbs, instructions, photoUrl } = req.body;

  let pet;
  if (petId) {
    pet = await prisma.pet.update({
      where: { id: petId },
      data: { name, breed, ageYears: numOrNull(ageYears), weightLbs: numOrNull(weightLbs), instructions, photoUrl }
    });
  } else {
    pet = await prisma.pet.create({
      data: {
        bookingId: booking.id,
        name: name || 'Dog',
        breed, ageYears: numOrNull(ageYears),
        weightLbs: numOrNull(weightLbs),
        instructions, photoUrl
      }
    });
  }
  res.json({ ok:true, pet });
});
function numOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

/* -------- Templates (cancel policy, etc.) -------- */
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

/* -------- Edit / availability -------- */
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
  if(!start || !end) return res.status(400).json({ error: 'start and end are required (ISO or ms)' });

  const startAt = new Date(start);
  const endAt   = new Date(end);

  const busy = await listBusy(startAt, endAt);
  const currentDogs = await dogsInWindow(startAt, endAt);
  const capacity = 10;

  res.json({
    ok: true,
    window: { startAt, endAt },
    busy,
    dogsOverlapping: currentDogs,
    willExceed: currentDogs >= capacity
  });
});
