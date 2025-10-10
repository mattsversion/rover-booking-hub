import { prisma } from '../db.js';

export async function dogsInWindow(startAt, endAt){
  const items = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      // overlap check: (start <= endAt) AND (end >= startAt)
      startAt: { lte: endAt },
      endAt:   { gte: startAt }
    },
    select: { dogsCount: true }
  });
  return items.reduce((sum, b) => sum + (b.dogsCount || 1), 0);
}
