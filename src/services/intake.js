// src/services/intake.js
// Shared message-intake parsing + batch reparse job

// --------- Booking intent heuristics ----------
const KEYWORDS = [
  'book','booking','reserve','reservation',
  'rover','sitter','sitting','board','boarding','overnight','stay',
  'doggy day care','doggy daycare','daycare','day care',
  'drop in','drop-in','dropin','drop off','dropoff','pick up','pickup'
];

export function findKeywords(text) {
  const t = (text || '').toLowerCase();
  const hits = [];
  for (const k of KEYWORDS) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(t)) hits.push(k);
  }
  return [...new Set(hits)];
}

// ---- parsing helpers (no chrono) ----
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function nextWeekdayDate(targetName, ref = new Date()) {
  const target = WEEKDAYS.indexOf(targetName.toLowerCase());
  if (target < 0) return null;
  const d = new Date(ref);
  const diff = (target - d.getDay() + 7) % 7 || 7; // always forward
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}

function thisWeekWeekdayDate(targetName, ref = new Date()) {
  const target = WEEKDAYS.indexOf(targetName.toLowerCase());
  if (target < 0) return null;
  const d = new Date(ref);
  const day = d.getDay();
  const delta = target - day;
  const out = new Date(d);
  out.setDate(d.getDate() + delta);
  out.setHours(0,0,0,0);
  if (delta < 0) out.setDate(out.getDate() + 7); // passed → next week
  return out;
}

// times like "9.30am", "9:30 am", "~ 4pm", "4 pm"
function parseTimeToken(tok) {
  const m = String(tok || '').toLowerCase().match(/~?\s*(\d{1,2})([:\.](\d{2}))?\s*(a|p)?m?\b/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  let min = m[3] ? parseInt(m[3], 10) : 0;
  const ap = m[4]; // a or p
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min };
  return null;
}

function parseTimeRange(text) {
  const t = (text || '').toLowerCase();
  const rangeRe = /(from|starting at)?\s*([~\s\d:\.apm]+)\s*(to|till|til|-|—|–|—)\s*([~\s\d:\.apm]+)/i;
  const m = t.match(rangeRe);
  if (!m) return null;
  const a = parseTimeToken(m[2]);
  const b = parseTimeToken(m[4]);
  if (!a || !b) return null;
  return { startH: a.h, startM: a.min, endH: b.h, endM: b.min };
}

function findWeekdayPhrase(text) {
  const t = (text || '').toLowerCase();
  const thisWeek = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(this\s+week)\b/i);
  if (thisWeek) return { name: thisWeek[1].toLowerCase(), mode: 'this' };
  const plain = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (plain) return { name: plain[1].toLowerCase(), mode: 'next' };
  return null;
}

// explicit date like 12/24/2025 or 12-24-2025 or "december 24"
function parseExplicitDate(text, ref = new Date()) {
  if (!text) return null;
  const mdy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (mdy) {
    const mm = +mdy[1], dd = +mdy[2], yy = mdy[3] ? +mdy[3] : ref.getFullYear();
    const year = yy < 100 ? 2000 + yy : yy;
    const d = new Date(year, mm - 1, dd);
    if (!isNaN(d)) return d;
  }
  const mname = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (mname) {
    const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mm = monthMap[mname[1].slice(0,3).toLowerCase()];
    const dd = +mname[2];
    const year = mname[3] ? +mname[3] : ref.getFullYear();
    const d = new Date(year, mm, dd);
    if (!isNaN(d)) return d;
  }
  return null;
}

export function pickDateRange(text, ref = new Date()) {
  const weekday = findWeekdayPhrase(text);
  const explicit = parseExplicitDate(text, ref);
  const times = parseTimeRange(text);

  let baseDate = null;
  if (explicit) {
    baseDate = explicit;
  } else if (weekday) {
    baseDate = weekday.mode === 'this' ? thisWeekWeekdayDate(weekday.name, ref)
                                       : nextWeekdayDate(weekday.name, ref);
  }
  if (!baseDate) return null;

  // end date like "to 12/30" or "– Dec 30"
  const span = String(text || '').match(/(?:\bto\b|\-|–|—)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\b[A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?)/i);
  let endDate = null;
  if (span) endDate = parseExplicitDate(span[1], ref);

  const startAt = new Date(baseDate);
  const endAt   = new Date(endDate || baseDate);

  if (times) {
    startAt.setHours(times.startH, times.startM, 0, 0);
    endAt.setHours(times.endH,   times.endM,   0, 0);
    if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  } else {
    // single-day default time when there are no explicit times
    startAt.setHours(17,0,0,0);
    endAt.setHours(17,0,0,0);
  }
  return { startAt, endAt, text };
}

export function classifyService(text='') {
  const t = (text || '').toLowerCase();
  if (/\b(overnight|board(?:ing)?|sleep(?:over)?)\b/.test(t)) return 'Overnight';
  if (/\b(day ?care|doggy ?day ?care)\b/.test(t))            return 'Daycare';
  if (/\b(drop[\s-]?in|check ?in)\b/.test(t))                return 'Drop-in';
  const tr = parseTimeRange(t);
  const wd = findWeekdayPhrase(t) || parseExplicitDate(t);
  if (tr && wd) return 'Daycare';
  return 'Unspecified';
}

// pet extraction: "Vida's mom", "drop Vida off", "for Luna"
export function extractPetNames(text='') {
  const names = new Set();
  const mom = text.match(/\b([A-Z][a-z]{2,})'s\s+mom\b/);
  if (mom) names.add(mom[1]);
  const drop = text.match(/\bdrop\s+([A-Z][a-z]{2,})\s+off\b/);
  if (drop) names.add(drop[1]);
  const forName = text.match(/\bfor\s+(?:my\s+dog\s+)?([A-Z][a-z]{2,})\b/);
  if (forName) names.add(forName[1]);
  return [...names];
}

export function serializeRange(range) {
  if (!range) return '[]';
  return JSON.stringify([{
    startISO: range.startAt.toISOString(),
    endISO:   range.endAt.toISOString(),
    text:     range.text || ''
  }]);
}

// ---------- batch reparse job ----------
/**
 * Re-parse messages and (re)attach bookings/pets.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{days?: number, onlyUnlinked?: boolean}} opts
 * @returns {Promise<{scanned:number, candidates:number, created:number, updated:number, linked:number, petsLinked:number}>}
 */
export async function reparseAll(prisma, opts = {}) {
  const days = Number.isFinite(opts.days) ? opts.days : 120;
  const onlyUnlinked = !!opts.onlyUnlinked;
  const since = new Date(Date.now() - days*24*60*60*1000);

  const where = {
    direction: 'IN',
    createdAt: { gte: since }
  };
  if (onlyUnlinked) where.bookingId = null;

  const msgs = await prisma.message.findMany({ where, orderBy: { createdAt: 'asc' } });

  let scanned=0, candidates=0, created=0, updated=0, linked=0, petsLinked=0;

  for (const m of msgs) {
    scanned++;
    const keywords = findKeywords(m.body);
    const range    = pickDateRange(m.body, m.createdAt || new Date());
    const isCandidate = (keywords.length > 0) && !!range;

    // Always update extracted fields on the message
    await prisma.message.update({
      where: { id: m.id },
      data: {
        isBookingCandidate: isCandidate,
        extractedKeywordsJson: JSON.stringify(keywords),
        extractedDatesJson: serializeRange(range)
      }
    }).catch(()=>{});

    if (!isCandidate) continue;
    candidates++;

    // Find recent booking linked to this thread
    let booking = await prisma.booking.findFirst({
      where: {
        OR: [{ clientPhone: m.fromPhone }, { roverRelay: m.threadId }],
        createdAt: { gte: new Date(Date.now() - 30 * 24*60*60*1000) }
      },
      orderBy: { createdAt: 'desc' }
    });

    const svc = classifyService(m.body);
    const startAt = range.startAt;
    const endAt   = range.endAt;

    if (!booking || booking.status === 'CANCELED') {
      booking = await prisma.booking.create({
        data: {
          source: 'SMS',
          clientName: m.fromLabel || m.fromPhone || m.threadId || 'Client',
          clientPhone: m.fromPhone,
          roverRelay: m.threadId,
          serviceType: svc,
          startAt, endAt,
          status: 'PENDING',
          notes: 'Reparsed from inbox'
        }
      });
      created++;
    } else {
      const patch = {};
      if ((booking.serviceType || 'Unspecified') === 'Unspecified' && svc !== 'Unspecified') {
        patch.serviceType = svc;
      }
      const shouldRefreshDates =
        booking.status === 'PENDING' &&
        (Math.abs(new Date(booking.startAt) - startAt) > 60 * 1000 ||
         Math.abs(new Date(booking.endAt)   - endAt)   > 60 * 1000);
      if (shouldRefreshDates) {
        patch.startAt = startAt;
        patch.endAt   = endAt;
      }
      if (Object.keys(patch).length) {
        await prisma.booking.update({ where: { id: booking.id }, data: patch });
        updated++;
      }
    }

    // ensure message links to the booking
    if (!m.bookingId || m.bookingId !== booking.id) {
      await prisma.message.update({ where: { id: m.id }, data: { bookingId: booking.id } }).catch(()=>{});
      linked++;
    }

    // attach pets if we can
    const pets = extractPetNames(m.body);
    for (const name of pets) {
      try {
        const existing = await prisma.pet.findFirst({
          where: { name, bookings: { some: { id: booking.id } } }
        });
        if (!existing) {
          const pet = await prisma.pet.create({ data: { name } });
          await prisma.booking.update({
            where: { id: booking.id },
            data: { pets: { connect: { id: pet.id } } }
          });
          petsLinked++;
        }
      } catch {}
    }
  }

  return { scanned, candidates, created, updated, linked, petsLinked };
}
