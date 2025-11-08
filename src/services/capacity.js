// src/services/capacity.js
import { prisma } from '../db.js';

/** True if two intervals [aS,aE] and [bS,bE] overlap with an optional grace (ms). */
function overlaps(aStart, aEnd, bStart, bEnd, graceMs = 0) {
  return (aStart.getTime() <= bEnd.getTime() + graceMs) &&
         (aEnd.getTime()   >= bStart.getTime() - graceMs);
}

/**
 * Count dogs overlapping a window.
 * @param {Date} startAt
 * @param {Date} endAt
 * @param {{ includePending?: boolean, excludeBookingId?: string, statuses?: string[], graceMinutes?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function dogsInWindow(startAt, endAt, opts = {}) {
  const {
    includePending = false,
    excludeBookingId = null,
    statuses = includePending ? ['CONFIRMED','PENDING'] : ['CONFIRMED'],
    graceMinutes = 0
  } = opts;

  const graceMs = Math.max(0, (graceMinutes|0) * 60 * 1000);

  try {
    // Do a coarse DB filter first (cheap) then exact overlap in JS with grace
    const rows = await prisma.booking.findMany({
      where: {
        status: { in: statuses },
        ...(excludeBookingId ? { NOT: { id: excludeBookingId } } : {}),
        // coarse overlap: (start <= endAt) AND (end >= startAt)
        startAt: { lte: endAt },
        endAt:   { gte: startAt }
      },
      select: { id: true, startAt: true, endAt: true, dogsCount: true }
    });

    return rows.reduce((sum, b) => {
      const dogs = Number.isFinite(b.dogsCount) && b.dogsCount > 0 ? b.dogsCount : 1;
      return overlaps(b.startAt, b.endAt, startAt, endAt, graceMs) ? sum + dogs : sum;
    }, 0);
  } catch (e) {
    console.error('[capacity] dogsInWindow failed:', e);
    return 0;
  }
}

/**
 * Count dogs at a specific instant.
 * Useful for “can I slot a quick drop-in at 2:30pm?” checks.
 * @param {Date} at
 * @param {{ includePending?: boolean, excludeBookingId?: string, statuses?: string[], graceMinutes?: number }} [opts]
 */
export async function dogsAtInstant(at, opts = {}) {
  const t = at instanceof Date ? at : new Date(at);
  // tiny epsilon window so DB coarse filter still works
  const epsilon = 1; // 1 ms
  return dogsInWindow(new Date(t.getTime() - epsilon), new Date(t.getTime() + epsilon), opts);
}

/**
 * Build an hourly timeline of dog counts across a window.
 * Great for charts or capacity rule checks (e.g., never exceed 10).
 * @param {Date} startAt
 * @param {Date} endAt
 * @param {{ includePending?: boolean, excludeBookingId?: string, statuses?: string[], graceMinutes?: number, stepMinutes?: number }} [opts]
 * @returns {Promise<Array<{ at: Date, count: number }>>}
 */
export async function dogsTimeline(startAt, endAt, opts = {}) {
  const stepMinutes = Math.max(5, (opts.stepMinutes ?? 60)|0); // default hourly
  const points = [];
  const start = new Date(startAt);
  const end = new Date(endAt);

  // prefetch once; we’ll reuse for each sample
  const {
    includePending = false,
    excludeBookingId = null,
    statuses = includePending ? ['CONFIRMED','PENDING'] : ['CONFIRMED'],
    graceMinutes = 0
  } = opts;
  const graceMs = Math.max(0, (graceMinutes|0) * 60 * 1000);

  let rows = [];
  try {
    rows = await prisma.booking.findMany({
      where: {
        status: { in: statuses },
        ...(excludeBookingId ? { NOT: { id: excludeBookingId } } : {}),
        startAt: { lte: end },
        endAt:   { gte: start }
      },
      select: { startAt: true, endAt: true, dogsCount: true }
    });
  } catch (e) {
    console.error('[capacity] dogsTimeline query failed:', e);
    return [];
  }

  for (let t = start.getTime(); t <= end.getTime(); t += stepMinutes * 60 * 1000) {
    const at = new Date(t);
    const c = rows.reduce((sum, b) => {
      const dogs = Number.isFinite(b.dogsCount) && b.dogsCount > 0 ? b.dogsCount : 1;
      return overlaps(b.startAt, b.endAt, at, at, graceMs) ? sum + dogs : sum;
    }, 0);
    points.push({ at, count: c });
  }
  return points;
}

/**
 * Convenience: will adding `dogsToAdd` exceed `capacity` in [startAt,endAt]?
 * Returns { willExceed, current, projected, capacity }
 */
export async function willExceedCapacity(startAt, endAt, dogsToAdd = 1, capacity = 10, opts = {}) {
  const current = await dogsInWindow(startAt, endAt, opts);
  const projected = current + (Number.isFinite(dogsToAdd) ? dogsToAdd : 1);
  return {
    willExceed: projected > capacity,
    current,
    projected,
    capacity
  };
}
