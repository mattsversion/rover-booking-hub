// src/services/intake.js
// unified intake helpers

// ---------- keywords (keeps walking words for detection, but we can ban later) ----------
const KEYWORDS = [
  'book','booking','reserve','reservation',
  'rover','sitter','sitting','board','boarding','overnight','stay',
  'doggy day care','doggy daycare','daycare','day care',
  'drop in','drop-in','dropin','drop off','dropoff','pick up','pickup',
  // spanish cues
  'cuidar','cuidado','hospedaje','hospedar','guardería','guarderia',
  'paseo','pasear','desde','hasta','dejar','recoger'
];
export function findKeywords(text='') {
  const t = text.toLowerCase();
  const hits = [];
  for (const k of KEYWORDS) {
    const re = new RegExp(`\\b${k.replace(/\s+/g,'\\s+')}\\b`, 'i');
    if (re.test(t)) hits.push(k);
  }
  return [...new Set(hits)];
}

// ---------- months, weekdays ----------
const EN_MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
const ES_MONTHS = {
  ene:0,enero:0,feb:1,febrero:1,mar:2,marzo:2,abr:3,abril:3,may:4,mayo:4,
  jun:5,junio:5,jul:6,julio:6,ago:7,agosto:7,sep:8,sept:8,septiembre:8,
  oct:9,octubre:9,nov:10,noviembre:10,dic:11,diciembre:11
};
const MONTH_RX = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sept?iembre|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)';
function monoMonth(m) {
  const k = m.toLowerCase();
  if (k in EN_MONTHS) return EN_MONTHS[k];
  if (k in ES_MONTHS) return ES_MONTHS[k];
  return null;
}

function yearInfer(ref, mm, dd) {
  // your rule: if no year, assume current year; if that date is >7 days in the past, bump to next year
  const y = ref.getFullYear();
  const d = new Date(y, mm, dd);
  const sevenDaysAgo = new Date(ref.getTime() - 7*24*60*60*1000);
  return d < sevenDaysAgo ? y + 1 : y;
}

// ---------- time helpers ----------
function parseTimeToken(tok) {
  const m = String(tok).toLowerCase().match(/~?\s*(\d{1,2})(?::|\.|h)?(\d{2})?\s*(a|p)?m?\b/);
  if (!m) return null;
  let h = +m[1], min = m[2] ? +m[2] : 0;
  const ap = m[3];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h>=0 && h<=23 && min>=0 && min<=59) return {h,min};
  return null;
}
function extractDropPickTimes(text) {
  const t = text.toLowerCase();
  const drop = t.match(/drop[\s-]?off[^a-z0-9]{0,12}(?:.*?\bat\b\s*)?([0-9:.apm\s]+)\b/);
  const pick = t.match(/pick[\s-]?up[^a-z0-9]{0,12}(?:.*?\bat\b\s*)?([0-9:.apm\s]+)\b/);
  const a = drop ? parseTimeToken(drop[1]) : null;
  const b = pick ? parseTimeToken(pick[1]) : null;
  // generic from..to
  const rg = t.match(/(?:from|de)\s+([0-9:.apm\s]+)\s+(?:to|a|hasta|-|–|—)\s+([0-9:.apm\s]+)/);
  if (!a && !b && rg) return { start: parseTimeToken(rg[1]) || null, end: parseTimeToken(rg[2]) || null };
  if (a || b) return { start: a || null, end: b || null };
  return null;
}

// ---------- rover meta (owner, pet, age, weight) ----------
export function extractRoverMeta(text='') {
  // example: "New booking request (dog boarding) from Eric: Eric Roberts (2 mos, 5 lbs)"
  const owner = text.match(/from\s+([A-Z][a-z]+)(?::|\b)/);
  const fullOwner = text.match(/from\s+[A-Z][a-z]+:\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
  const pet = text.match(/\b([A-Z][a-z]+)\s*\((?:\d+\s*(?:mos?|months?)|[\d\.]+\s*lbs)/) // "Vida (2 mos, 5 lbs)"
            || text.match(/\b([A-Z][a-z]+)’?s\s+mom\b/i)
            || text.match(/\bdrop\s+([A-Z][a-z]+)\s+off\b/i);
  const age = text.match(/\((\d+)\s*(?:mos?|months?)\b/i);
  const weight = text.match(/([\d\.]+)\s*lb?s?\b/i);
  return {
    ownerName: (fullOwner?.[1] || owner?.[1] || null),
    petName: pet?.[1] || null,
    petAgeMonths: age ? +age[1] : null,
    petWeightLbs: weight ? +weight[1] : null
  };
}

// ---------- scan date tokens (supports multiple segments) ----------
function scanDateTokens(text, ref = new Date()) {
  const tokens = [];
  const s = text.replace(/\,/g,' , ').replace(/\s+/g,' ').trim();

  // Month name day [year]
  let m; const rx1 = new RegExp(`\\b(${MONTH_RX})\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`,'ig');
  while ((m = rx1.exec(s))) {
    const mm = monoMonth(m[1]), dd = +m[2], yy = m[3] ? +m[3] : yearInfer(ref, mm, dd);
    tokens.push({mm,dd,yy,idx:m.index});
  }
  // day de Month [de year]
  const rx2 = new RegExp(`\\b(\\d{1,2})\\s*(?:de|del)\\s*(${MONTH_RX})(?:\\s*(?:de\\s*)?(\\d{4}))?`,'ig');
  while ((m = rx2.exec(s))) {
    const dd = +m[1], mm = monoMonth(m[2]), yy = m[3] ? +m[3] : yearInfer(ref, mm, dd);
    tokens.push({mm,dd,yy,idx:m.index});
  }
  // mm/dd[/yy] or mm-dd[-yy]
  const rx3 = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/ig;
  while ((m = rx3.exec(s))) {
    const mm = +m[1]-1, dd = +m[2];
    const yr = m[3] ? +m[3] : yearInfer(ref, mm, dd);
    const yy = yr < 100 ? 2000 + yr : yr;
    tokens.push({mm,dd,yy,idx:m.index});
  }

  // compact range: "Nov 13–18" or "13–18 de Noviembre"
  const c1 = new RegExp(`\\b(${MONTH_RX})\\s+(\\d{1,2})\\s*[–—-]\\s*(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`,'ig');
  while ((m = c1.exec(s))) {
    const mm = monoMonth(m[1]), dd1 = +m[2], dd2 = +m[3];
    const yy = m[4] ? +m[4] : yearInfer(ref, mm, dd1);
    tokens.push({mm,dd:dd1,yy,idx:m.index});
    tokens.push({mm,dd:dd2,yy,idx:m.index + m[0].length - String(dd2).length});
  }
  const c2 = new RegExp(`\\b(\\d{1,2})\\s*[–—-]\\s*(\\d{1,2})\\s*(?:de\\s*)?(${MONTH_RX})(?:\\s*(\\d{4}))?`,'ig');
  while ((m = c2.exec(s))) {
    const dd1 = +m[1], dd2 = +m[2], mm = monoMonth(m[3]);
    const yy = m[4] ? +m[4] : yearInfer(ref, mm, dd1);
    tokens.push({mm,dd:dd1,yy,idx:m.index});
    tokens.push({mm,dd:dd2,yy,idx:m.index + m[0].length - String(dd2).length});
  }

  tokens.sort((a,b)=>a.idx-b.idx);
  return tokens;
}

// ---------- segment builder ----------
// returns array of segments: [{startAt,endAt, serviceHint}]
export function parseSegments(text, ref = new Date()) {
  const toks = scanDateTokens(text, ref);
  const times = extractDropPickTimes(text);

  // Split by commas/ semicolons/ "and" to allow "12-15-2025, 12-24-2025 to 12-30-2025"
  // We'll build pairs when we see “to/–/hasta/al” after a date.
  const segs = [];
  if (!toks.length) return segs;

  // Greedy range builder: walk tokens in order, pair them if a connector "to" is nearby,
  // otherwise make a single-day segment.
  const connectors = new RegExp(`\\b(?:to|a|hasta|al|through|thru|–|—|-)\\b`, 'i');
  const textLower = text.toLowerCase();

  for (let i = 0; i < toks.length; i++) {
    const a = toks[i];
    let b = null;

    // look ahead one token; if a connector exists in between, treat a..b as a range
    if (i + 1 < toks.length) {
      const between = textLower.slice(toks[i].idx, toks[i+1].idx + 1);
      if (connectors.test(between)) {
        b = toks[i+1];
        i++; // consume next
      }
    }

    const startAt = new Date(a.yy, a.mm, a.dd);
    const endAt   = new Date(b ? b.yy : a.yy, b ? b.mm : a.mm, b ? b.dd : a.dd);

    if (times?.start) startAt.setHours(times.start.h, times.start.min, 0, 0);
    if (times?.end)   endAt.setHours(times.end.h,   times.end.min,   0, 0);
    if (!times?.start && !times?.end) { startAt.setHours(17,0,0,0); endAt.setHours(17,0,0,0); }
    if (endAt < startAt) endAt.setDate(endAt.getDate() + 1);

    const spanDays = Math.round((endAt - startAt) / (24*60*60*1000));
    const serviceHint = spanDays >= 1 ? 'Overnight' : 'Daycare';

    segs.push({ startAt, endAt, serviceHint });
  }

  return segs;
}

export function pickDateRange(text, ref = new Date()) {
  const segs = parseSegments(text, ref);
  return segs[0] ? { ...segs[0], text } : null;
}

export function classifyService(text='') {
  const t = text.toLowerCase();
  if (/\b(overnight|board(?:ing)?|sleep(?:over)?)\b/.test(t)) return 'Overnight';
  if (/\b(day ?care|doggy ?day ?care|guard[eé]ria)\b/.test(t)) return 'Daycare';
  if (/\b(drop[\s-]?in|check ?in|visita|visitar)\b/.test(t))   return 'Drop-in';
  if (/\bwalk(?:er|ing)?\b/.test(t)) return 'Walk'; // we’ll ban this later
  // implicit
  const rng = pickDateRange(text);
  if (rng) {
    const days = Math.round((rng.endAt - rng.startAt) / (24*60*60*1000));
    return days >= 1 ? 'Overnight' : 'Daycare';
  }
  return 'Unspecified';
}

export function extractPetNames(text='') {
  const names = new Set();
  const mom = text.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})’?'s\s+mom\b/);
  if (mom) names.add(mom[1]);
  const drop = text.match(/\bdrop\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})\s+off\b/i);
  if (drop) names.add(drop[1]);
  const forName = text.match(/\b(?:for|para)\s+(?:my|mi)?\s*(?:dog|perro)?\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})\b/i);
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

// ---- admin helper: reparse all inbound messages in a recent window ----
/**
 * Re-run keyword/date parsing on recent IN/SMS messages,
 * refresh each message's extracted fields,
 * and gently update attached PENDING bookings' dates/service when appropriate.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{days?: number, limit?: number}} opts
 */
export async function reparseAll(prisma, opts = {}) {
  const days  = Number.isFinite(opts.days) ? opts.days : 180;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 5000;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const msgs = await prisma.message.findMany({
    where: {
      direction: 'IN',
      channel: 'SMS',
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'asc' },
    take: limit
  });

  let updated = 0, touchedBookings = 0;

  for (const m of msgs) {
    const body = m.body || '';
    const receivedAt = m.createdAt || new Date();

    const keywords = findKeywords(body);
    const range    = pickDateRange(body, receivedAt);
    const isCandidate = keywords.length > 0 && !!range;

    // update message extracted fields
    await prisma.message.update({
      where: { id: m.id },
      data: {
        isBookingCandidate: isCandidate,
        extractedKeywordsJson: JSON.stringify(keywords),
        extractedDatesJson: serializeRange(range),
      }
    });
    updated++;

    // best-effort: gently refresh booking dates/service if message is already linked
    if (isCandidate && m.bookingId && range) {
      const booking = await prisma.booking.findUnique({ where: { id: m.bookingId } });
      if (booking && booking.status === 'PENDING') {
        const patch = {};

        // set service if still unspecified but we can infer now
        if ((booking.serviceType || 'Unspecified') === 'Unspecified') {
          const svc = classifyService(body);
          if (svc !== 'Unspecified') patch.serviceType = svc;
        }

        // refresh dates if they differ by > 1 minute
        const startAt = range.startAt;
        const endAt   = range.endAt;
        const diffStart = Math.abs(new Date(booking.startAt) - startAt);
        const diffEnd   = Math.abs(new Date(booking.endAt)   - endAt);

        if (Number.isFinite(diffStart) && Number.isFinite(diffEnd) && (diffStart > 60_000 || diffEnd > 60_000)) {
          patch.startAt = startAt;
          patch.endAt   = endAt;
        }

        if (Object.keys(patch).length) {
          await prisma.booking.update({ where: { id: booking.id }, data: patch });
          touchedBookings++;
        }
      }
    }
  }

  return { scanned: msgs.length, updated, touchedBookings, since };
}
