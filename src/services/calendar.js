// src/services/calendar.js
import { google } from 'googleapis';

function getAuth() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;

  // if any part missing, treat calendar as "not connected"
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !GOOGLE_REFRESH_TOKEN) {
    return null;
  }

  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2;
}

function isInvalidGrant(err) {
  // gaxios/google lib shapes
  const msg = err?.response?.data?.error || err?.code || err?.message || '';
  return String(msg).includes('invalid_grant');
}

function getCalendar(auth) {
  return google.calendar({ version: 'v3', auth });
}

/**
 * Create or update a "busy" event for a booking.
 * transparency: 'transparent' (free) or 'opaque' (busy)
 * Safe: no-ops on errors or when not connected.
 */
export async function createOrUpdateBusyEvent(booking, transparency = 'transparent') {
  const auth = getAuth();
  if (!auth) return; // not connected

  const cal = getCalendar(auth);
  const calendarId = process.env.AVAIL_CAL_ID || 'primary';
  const summary = transparency === 'opaque' ? 'FULLY BOOKED' : `Hold: ${booking.clientName || 'Client'}`;

  const requestBody = {
    summary,
    start: { dateTime: new Date(booking.startAt).toISOString() },
    end: { dateTime: new Date(booking.endAt).toISOString() },
    transparency, // 'transparent' or 'opaque'
    extendedProperties: { shared: { bookingId: booking.id } },
  };

  try {
    // look for an existing event with this bookingId extended prop
    const q = await cal.events.list({
      calendarId,
      sharedExtendedProperty: `bookingId=${booking.id}`,
      maxResults: 1,
      singleEvents: true,
    });

    if (q.data.items?.length) {
      await cal.events.update({
        calendarId,
        eventId: q.data.items[0].id,
        requestBody,
      });
    } else {
      await cal.events.insert({
        calendarId,
        requestBody,
      });
    }
  } catch (e) {
    if (isInvalidGrant(e)) {
      console.warn('[calendar] invalid_grant in createOrUpdateBusyEvent — skipping.');
      return;
    }
    console.error('[calendar] createOrUpdateBusyEvent error', e);
  }
}

/**
 * Delete the busy event for a bookingId.
 * Safe: no-ops on errors or when not connected.
 */
export async function deleteBusyEvent(bookingId) {
  const auth = getAuth();
  if (!auth) return; // not connected

  const cal = getCalendar(auth);
  const calendarId = process.env.AVAIL_CAL_ID || 'primary';

  try {
    // primary lookup by extended property
    const q = await cal.events.list({
      calendarId,
      sharedExtendedProperty: `bookingId=${bookingId}`,
      maxResults: 1,
      singleEvents: true,
    });

    if (q.data.items?.length) {
      await cal.events.delete({ calendarId, eventId: q.data.items[0].id });
      return;
    }

    // fallback: scan recent events for the extended prop (in case property/indexing lags)
    const timeMin = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // last 60 days
    const q2 = await cal.events.list({
      calendarId,
      timeMin,
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const candidate = q2.data.items?.find(
      (ev) => ev?.extendedProperties?.shared?.bookingId === bookingId
    );
    if (candidate) {
      await cal.events.delete({ calendarId, eventId: candidate.id });
    }
  } catch (e) {
    if (isInvalidGrant(e)) {
      console.warn('[calendar] invalid_grant in deleteBusyEvent — skipping.');
      return;
    }
    console.error('[calendar] deleteBusyEvent error', e);
  }
}

/**
 * List "busy" intervals between startAt and endAt.
 * Returns [] if not connected or on error.
 */
export async function listBusy(startAt, endAt) {
  const auth = getAuth();
  if (!auth) return []; // not connected

  const cal = getCalendar(auth);
  const calendarId = process.env.AVAIL_CAL_ID || 'primary';

  try {
    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: new Date(startAt).toISOString(),
        timeMax: new Date(endAt).toISOString(),
        items: [{ id: calendarId }],
      },
    });
    const calendars = fb.data.calendars || {};
    const busy =
      calendars[calendarId]?.busy ||
      calendars['primary']?.busy ||
      [];
    // normalize objects to { start, end }
    return (busy || []).map((b) => ({ start: b.start, end: b.end }));
  } catch (e) {
    if (isInvalidGrant(e)) {
      console.warn('[calendar] invalid_grant in listBusy — returning empty busy.');
      return [];
    }
    console.error('[calendar] listBusy error', e);
    return [];
  }
}
