// src/services/classifier.js
// Strict, regex-first classifier with safe parsing and an AI fallback only if enabled.
// It never invents dates. If we can't parse confidently, we return no segments.

function thisYearBase(now = new Date()) {
  // if today is, say, 2025-11-04, base is 2025
  return now.getFullYear();
}

// Accept forms like: 12-15, 12/15, dec 15, december 1st, nov 20 to nov 23, 12-24 to 12-30
// No year => infer to current year, but if inferred date is >7 days in the past, bump to next year.
const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december'
];
const MONTH_RX = MONTH_NAMES.join('|');

function normalizePiece(p='') {
  return p.replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
}

function toISO(year, monthIndex, day) {
  const d = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0)); // noon UTC avoids tz edge cases
  return isNaN(d) ? null : d.toISOString();
}

function maybeBumpYear(iso, now = new Date()) {
  if (!iso) return iso;
  const d = new Date(iso);
  const sevenDaysAgo = new Date(now.getTime() - 7*24*60*60*1000);
  if (d < sevenDaysAgo) {
    const bumped = new Date(Date.UTC(d.getUTCFullYear()+1, d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
    return bumped.toISOString();
  }
  return iso;
}

function parseSegments(text, now = new Date()) {
  const t = (text || '').toLowerCase();

  const segments = [];

  // 1) Range with numeric months: 12-24 to 12-30 OR 12/24 to 12/30
  const numRange = [...t.matchAll(
    /\b(\d{1,2})[\/\-](\d{1,2})\s*(?:to|-|–|—)\s*(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g
  )];
  for (const m of numRange) {
    const [, m1, d1, m2, d2, maybeYear] = m.map(s => s && normalizePiece(s));
    const baseYear = maybeYear ? Number(maybeYear.length === 2 ? '20'+maybeYear : maybeYear)
                               : thisYearBase(now);
    const sISO = toISO(baseYear, Number(m1)-1, Number(d1));
    const eISO = toISO(baseYear, Number(m2)-1, Number(d2));
    let startAt = sISO, endAt = eISO;
    if (!maybeYear) { startAt = maybeBumpYear(startAt, now); endAt = maybeBumpYear(endAt, now); }
    if (startAt && endAt) segments.push({ startAt, endAt });
  }

  // 2) Single numeric day: 12-15 or 12/15 (daycare)
  const singleNum = [...t.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g)];
  for (const m of singleNum) {
    const [, mm, dd, maybeYear] = m.map(s => s && normalizePiece(s));
    // skip ones already consumed in a range above (simple heuristic: if "to" is near, the range handler covers it)
    if (/to|-|–|—/.test(t.slice(m.index-5, m.index+10))) continue;
    const baseYear = maybeYear ? Number(maybeYear.length === 2 ? '20'+maybeYear : maybeYear)
                               : thisYearBase(now);
    let startAt = toISO(baseYear, Number(mm)-1, Number(dd));
    if (!maybeYear) startAt = maybeBumpYear(startAt, now);
    if (startAt) segments.push({ startAt, endAt: null });
  }

  // 3) Word month range: dec 15 to dec 18, december 1 to december 3
  const wordRange = [...t.matchAll(
    new RegExp(`\\b(${MONTH_RX})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|-|–|—)\\s*(${MONTH_RX})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'g')
  )];
  for (const m of wordRange) {
    const [, m1, d1, m2, d2, maybeYear] = m.map(s => s && normalizePiece(s));
    const month1 = MONTH_NAMES.indexOf(m1);
    const month2 = MONTH_NAMES.indexOf(m2);
    const baseYear = maybeYear ? Number(maybeYear) : thisYearBase(now);
    let startAt = toISO(baseYear, month1, Number(d1));
    let endAt   = toISO(baseYear, month2, Number(d2));
    if (!maybeYear) { startAt = maybeBumpYear(startAt, now); endAt = maybeBumpYear(endAt, now); }
    if (startAt && endAt) segments.push({ startAt, endAt });
  }

  // 4) Single word month day: december 15th
  const singleWord = [...t.matchAll(
    new RegExp(`\\b(${MONTH_RX})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'g')
  )];
  for (const m of singleWord) {
    const [, mon, dd, maybeYear] = m.map(s => s && normalizePiece(s));
    // if a "to" within the same vicinity, skip; range handled above
    if (/to|-|–|—/.test(t.slice(m.index-5, m.index+10))) continue;
    const month = MONTH_NAMES.indexOf(mon);
    const baseYear = maybeYear ? Number(maybeYear) : thisYearBase(now);
    let startAt = toISO(baseYear, month, Number(dd));
    if (!maybeYear) startAt = maybeBumpYear(startAt, now);
    if (startAt) segments.push({ startAt, endAt: null });
  }

  // de-dupe identical segments
  const key = s => `${s.startAt || ''}|${s.endAt || ''}`;
  const seen = new Set();
  return segments.filter(s => {
    const k = key(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function hasBookingKeywords(text='') {
  const t = text.toLowerCase();
  // Your stated policy: no walks; treat multi-day as boarding, single-day as daycare.
  // Keywords for intent (Rover + natural)
  const intent = /(book|booking|reserve|reservation|overnight|board|boarding|day ?care|drop[\s-]?in|request|inquiry|rover)/i.test(t);
  // If we have date segments, that’s also a strong signal even without the words.
  return intent;
}

function inferService(segments) {
  // any segment with an endAt => Overnight/Boarding, else Daycare
  if (!segments?.length) return null;
  return segments.some(s => s.endAt) ? 'Overnight' : 'Daycare';
}

export async function classifyMessage(text) {
  const segments = parseSegments(text);
  const hasDates = segments.length > 0;
  const intent   = hasBookingKeywords(text);

  // Strict rule: a message is a booking candidate only if it has
  //   (dates) OR (explicit booking keywords)
  const isCandidate = hasDates || intent;

  const label = isCandidate ? 'BOOKING_REQUEST' : 'GENERAL';
  const extracted = isCandidate ? {
    serviceType: inferService(segments),
    segments
  } : null;

  // Optional: AI refinement (will never invent dates; we only accept dates we already parsed)
  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const prompt = `
You refine classification for a dog-sitting inbox. NEVER invent dates.
Dates/segments are already parsed below. Only update "label" to GENERAL if clearly not booking related.
Input:
Text: ${JSON.stringify(text||'')}
Segments: ${JSON.stringify(segments)}

Return JSON: {"label":"BOOKING_REQUEST"|"GENERAL"}
`.trim();
      const resp = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Return only JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0
      });
      const raw = resp?.choices?.[0]?.message?.content || '{}';
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.label === 'GENERAL' && !hasDates) {
          return { label: 'GENERAL', score: 0.2, extracted: null };
        }
      } catch {}
    } catch {}
  }

  return { label, score: isCandidate ? 0.8 : 0.2, extracted };
}
