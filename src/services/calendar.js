import { google } from 'googleapis';

function getAuth(){
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return o;
}

export async function createOrUpdateBusyEvent(booking, transparency='transparent'){
  const auth = getAuth();
  const cal = google.calendar({ version: 'v3', auth });
  const summary = transparency === 'opaque' ? 'FULLY BOOKED' : `Hold: ${booking.clientName}`;

  // find existing event for this booking (by extended prop)


// in deleteBusyEvent
const q = await cal.events.list({
  calendarId: process.env.AVAIL_CAL_ID,
  sharedExtendedProperty: `bookingId=${bookingId}`,
  maxResults: 1
});


  const requestBody = {
    summary,
    start: { dateTime: new Date(booking.startAt).toISOString() },
    end:   { dateTime: new Date(booking.endAt).toISOString() },
    transparency, // 'transparent' = free, 'opaque' = busy
    extendedProperties: { shared: { bookingId: booking.id } }
  };

  if (q.data.items?.length) {
    return cal.events.update({
      calendarId: process.env.AVAIL_CAL_ID,
      eventId: q.data.items[0].id,
      requestBody
    });
  } else {
    return cal.events.insert({
      calendarId: process.env.AVAIL_CAL_ID,
      requestBody
    });
  }
}

export async function deleteBusyEvent(bookingId){
  const auth = getAuth();
  const cal = google.calendar({ version: 'v3', auth });
const q = await cal.events.list({
  calendarId: process.env.AVAIL_CAL_ID,
  sharedExtendedProperty: `bookingId=${bookingId}`,
  maxResults: 1
});

// inside deleteBusyEvent, after the first list call
if (!q.data.items?.length) {
  // Fallback: search by time window in the last 60 days
  const timeMin = new Date(Date.now() - 60*24*60*60*1000).toISOString();
  const q2 = await cal.events.list({
    calendarId: process.env.AVAIL_CAL_ID,
    timeMin,
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime'
  });
  const candidate = q2.data.items?.find(ev =>
    ev.extendedProperties?.shared?.bookingId === bookingId
  );
  if (candidate) {
    await cal.events.delete({ calendarId: process.env.AVAIL_CAL_ID, eventId: candidate.id });
    return;
  }
}

  if (q.data.items?.length) {
    await cal.events.delete({ calendarId: process.env.AVAIL_CAL_ID, eventId: q.data.items[0].id });
  }
}

export async function listBusy(startAt, endAt){
  const auth = getAuth();
  const cal = google.calendar({ version: 'v3', auth });
  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: new Date(startAt).toISOString(),
      timeMax: new Date(endAt).toISOString(),
      items: [{ id: process.env.AVAIL_CAL_ID }]
    }
  });
  const busy = fb.data.calendars?.[process.env.AVAIL_CAL_ID]?.busy || [];
  return busy; // [{start: "...", end: "..."}]
}

