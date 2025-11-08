// src/services/calendar.js
import { google } from 'googleapis';

/* ======================== Config & Helpers ======================== */

const TZ = process.env.TZ || 'America/New_York';
const CAL_DEBUG = process.env.CAL_DEBUG === '1';

function dlog(...args) {
  if (CAL_DEBUG) console.log('[calendar]', ...args);
}

function missingEnv() {
  const miss = [];
  if (!process.env.GOOGLE_CLIENT_ID) miss.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET) miss.push('GOOGLE_CLIENT_SECRET');
  if (!process.env.GOOGLE_REDIRECT_URI) miss.push('GOOGLE_REDIRECT_URI');
  if (!process.env.GOOGLE_REFRESH_TOKEN) miss.push('GOOGLE_REFRESH_TOKEN');
  return miss;
}

function isInvalidGrant(err) {
  const msg =
    err?.response?.data?.error_description ||
    err?.response?.data?.error ||
    err?.errors?.[0]?.message ||
    err?.code ||
    err?.message ||
    '';
  return String(msg).toLowerCase().includes('invalid_grant');
}

function isRetryable(err) {
  const status = err?.response?.status || err?.code;
  // 429 rate-limit, 5xx server errors -> retry
  return status === 429 || (Number(status) >= 500 && Number(status) < 600);
}

function backoff(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries(fn, label = 'request', max = 3) {
  let attempt = 0, delay = 400;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (e) {
      if (isRetryable(e) && attempt < max) {
        dlog(`${label} failed (attempt ${attempt}) — retrying in ${delay}ms`, e?.response?.status || e?.code || '');
        await backoff(delay);
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
}

/* ======================== Auth & Calendar ======================== */

function getAuth() {
  const miss = missingEnv();
  if (miss.length) {
    dlog('not connected — missing env:', miss.join(', '));
    return null;
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2;
}

function getCalendar(auth) {
  return google.calendar({ version: 'v3', auth });
}

/**
 * Resolve a calendar "id" to a usable ID.
 * - If AVAIL_CAL_ID looks like an email or 'primary' → use directly.
 * - Otherwise, treat it as a *name* and search the user’s calendars to find a match.
 */
async function resolveCalendarId(cal) {
  const raw = (process.env.AVAIL_CAL_ID || 'primary').trim();
  if (raw === 'primary' || raw.includes('@')) {
    return raw;
  }

  // Try to find by summary (name)
  try {
    const items = await withRetries(
      () => cal.calendarList.list({ maxResults: 250 }),
      'calendarList.list'
    );
    const found = (items?.data?.items || []).find((c) => (c.summary || '').toLowerCase() === raw.toLowerCase());
    if (found?.id) {
      dlog(`Resolved AVAIL_CAL_ID "${raw}" → ${found.id}`);
      return found.id;
    }
    dlog(`Could not resolve calendar by summary "${raw}", falling back to primary`);
  } catch (e) {
    dlog('calendarList.list failed; using primary', e?.message || e);
  }
  return 'primary';
}

/* ======================== Public: Verify ======================== */

/**
 * Quick connection verification you can call from e.g. a /debug route.
 * Returns { connected: boolean, calendarId?: string, email?: string, reason?: string }
 */
export async function verifyConnection() {
  const miss = missingEnv();
  if (miss.length) return { connected: false, reason: `Missing env: ${miss.join(', ')}` };

  const auth = getAuth();
  if (!auth) return { connected: false, reason: 'Auth not created' };

  try {
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const me = await withRetries(() => oauth2.userinfo.get(), 'userinfo.get');
    const cal = getCalendar(auth);
    const calendarId = await resolveCalendarId(cal);
    // No-op call to ensure token works
    await withRetries(
      () => cal.calendars.get({ calendarId }),
      'calendars.get'
    );
    return { connected: true, email: me?.data?.email || null, calendarId };
  } catch (e) {
    if (isInvalidGrant(e)) return { connected: false, reason: 'invalid_grant (refresh token revoked?)' };
    return { connected: false, reason: e?.message || 'unknown_error' };
  }
}

/* ======================== Core Operations ======================== */

function toCalDateTime(isoOrDate) {
  const d = new Date(isoOrDate);
  return {
    dateTime: d.toISOString(),
    timeZone: TZ
  };
}

/**
 * Create or update a "busy" (opaque or transparent) event for a booking.
 * Safe no-op when not connected; robust on errors.
 */
export async function createOrUpdateBusyEvent(booking, transparency = 'transparent') {
  const auth = getAuth();
  if (!auth) return; // not connected

  const cal = getCalendar(auth);
  const calendarId = await resolveCalendarId(cal);

  const summary = transparency === 'opaque'
    ? 'FULLY BOOKED'
    : `Hold: ${booking.clientName || 'Client'}`;

  const requestBody = {
    summary,
    description: `Auto-synced from Booking Hub\nClient: ${booking.clientName || '—'}\nDogs: ${booking.dogsCount || 1}\nNotes: ${booking.notes || '—'}`,
    start: toCalDateTime(booking.startAt),
    end: toCalDateTime(booking.endAt),
    transparency, // 'transparent' or 'opaque'
    extendedProperties: { shared: { bookingId: booking.id } },
    reminders: { useDefault: true }
  };

  try {
    // Fast path: look up by extended property
    const q = await withRetries(
      () => cal.events.list({
        calendarId,
        sharedExtendedProperty: `bookingId=${booking.id}`,
        maxResults: 1,
        singleEvents: true
      }),
      'events.list(lookup)'
    );

    if (q.data.items?.length) {
      const id = q.data.items[0].id;
      dlog('Updating existing event for booking', booking.id, '→', id);
      await withRetries(
        () => cal.events.update({ calendarId, eventId: id, requestBody }),
        'events.update'
      );
    } else {
      dlog('Inserting new event for booking', booking.id);
      await withRetries(
        () => cal.events.insert({ calendarId, requestBody }),
        'events.insert'
      );
    }
  } catch (e) {
    if (isInvalidGrant(e)) {
      console.warn('[calendar] invalid_grant in createOrUpdateBusyEvent — skipping. Check GOOGLE_REFRESH_TOKEN.');
      return;
    }
    console.error('[calendar] createOrUpdateBusyEvent error', e?.response?.data || e);
  }
}

/**
 * Delete the busy event for a bookingId. Safe on errors/not-connected.
 */
export async function deleteBusyEvent(bookingId) {
  const auth = getAuth();
  if (!auth) return;

  const cal = getCalendar(auth);
  const calendarId = await resolveCalendarId(cal);

  try {
    const q = await withRetries(
      () => cal.events.list({
        calendarId,
        sharedExtendedProperty: `bookingId=${bookingId}`,
        maxResults: 1,
        singleEvents: true
      }),
      'events.list(delete-lookup)'
    );

    if (q.data.items?.length) {
      const id = q.data.items[0].id;
      dlog('Deleting event for booking', bookingId, '→', id);
      await withRetries(
        () => cal.events.delete({ calendarId, eventId: id }),
        'events.delete'
      );
      return;
    }

    // Fallback: scan recent window (in case extended prop index lagged)
    const timeMin = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days
    const q2 = await withRetries(
      () => cal.events.list({
        calendarId,
        timeMin,
        maxResults: 200,
        singleEvents: true,
        orderBy: 'startTime'
      }),
      'events.list(delete-scan)'
    );

    const candidate = (q2.data.items || []).find(
      ev => ev?.extendedProperties?.shared?.bookingId === bookingId
    );
    if (candidate) {
      dlog('Deleting (fallback) event for booking', bookingId, '→', candidate.id);
      await withRetries(
        () => cal.events.delete({ calendarId, eventId: candidate.id }),
        'events.delete(fallback)'
      );
    }
  } catch (e) {
    if (isInvalidGrant(e)) {
      console.warn('[calendar] invalid_grant in deleteBusyEvent — skipping.');
      return;
    }
    console.error('[calendar] deleteBusyEvent error', e?.response?.data || e);
  }
}

/**
 * List busy intervals between startAt and endAt for capacity checks.
 * Returns [] on not-connected or any error.
 */
export async function listBusy(startAt, endAt) {
  const auth = getAuth();
  if (!auth) return [];

  const cal = getCalendar(auth);
  const calendarId = await resolveCalendarId(cal);

  try {
    const fb = await withRetries(
      () => cal.freebusy.query({
        requestBody: {
          timeMin: new Date(startAt).toISOString(),
          timeMax: new Date(endAt).toISOString(),
          timeZone: TZ,
          items: [{ id: calendarId }]
        }
      }),
      'freebusy.query'
    );

    const calendars = fb.data.calendars || {};
    const busy = calendars[calendarId]?.busy || calendars['primary']?.busy || [];
    return (busy || []).map(b => ({ start: b.start, end: b.end }));
  } catch (e) {
    if (isInvalidGrant(e)) {
      console.warn('[calendar] invalid_grant in listBusy — returning empty [].');
      return [];
    }
    console.error('[calendar] listBusy error', e?.response?.data || e);
    return [];
  }
}
