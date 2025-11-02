// src/services/clients.js
import { prisma } from '../db.js';

export async function ensureClientForPrivate({ phone, name }) {
  if (!phone) return null;
  // skip if looks like Rover relay (we only want private numbers)
  // heuristic: rover relays often contain '@r.rover.com' or similar
  if (/@r\.rover\.com/i.test(phone)) return null;

  let c = await prisma.client.findUnique({ where: { phone } });
  if (!c) {
    c = await prisma.client.create({
      data: { phone, name: name || null }
    });
  } else if (name && !c.name) {
    // backfill name if we later learn it
    c = await prisma.client.update({
      where: { id: c.id },
      data: { name }
    });
  }
  return c;
}

// Create/find a client for ANY phone, optionally mark as private.
export async function ensureClient(prismaOrNothing, { phone, name, markPrivate = false }) {
  // allow calling as ensureClient({ ... }) if you keep prisma import at top
  const db = prismaOrNothing?.$use ? prismaOrNothing : (await import('../db.js')).prisma;
  if (!phone) return null;

  let c = await db.client.findUnique({ where: { phone } });
  if (!c) {
    c = await db.client.create({
      data: { phone, name: name || null, isPrivate: !!markPrivate }
    });
  } else {
    const patch = {};
    if (name && !c.name) patch.name = name;
    if (markPrivate && !c.isPrivate) patch.isPrivate = true;
    if (Object.keys(patch).length) {
      c = await db.client.update({ where: { id: c.id }, data: patch });
    }
  }
  return c;
}

