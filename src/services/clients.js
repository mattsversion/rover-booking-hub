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
