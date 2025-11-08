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
  'paseo','pasear','desde','hasta','dejar','recoger',
  // seasonal / travel cues that often imply bookings
  'thanksgiving','christmas','holiday','travel'
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
  // rule: if no year, assume current year; if that date is >7 days in the past, bump to next year
  const y = ref.getFullYear();
  const d = new Date(y, mm, dd);
  const sevenDaysAgo = new Date(ref.getTime() - 7*24*60*60*1000);
  return d < sevenDaysAgo ? y + 1 : y;
}

// ===== Natural-language helpers =====
const WEEKDAYS = { sun:0, sunday:0, mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, weds:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };

function clone(d){ return new Date(d.getTime()); }
function startOfDay(d){ const x = clone(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d){ const x = clone(d); x.setHours(23,59,59,999); return x; }

function addDays(d, n){ const x = clone(d); x.setDate(x.getDate()+n); return x; }
function setHM(d,h=17,m=0){ const x = clone(d); x.setHours(h,m,0,0); return x; }

function nextWeekday(ref, wd) {
  const x = startOfDay(ref);
  const cur = x.getDay();
  const diff = (wd - cur + 7) % 7 || 7; // always future (>=1 day)
  return addDays(x, diff);
}

function thisOrNextWeekday(ref, wd) {
  const x = startOfDay(ref);
  const cur = x.getDay();
  const diff = (wd - cur + 7) % 7;
  return addDays(x, diff);
}

function weekSpan(ref, which /* 'this'|'next' */) {
  // Mon..Sun weeks (common for scheduling)
  const x = startOfDay(ref);
  const day = x.getDay();
  const mondayOffset = (day === 0 ? -6 : 1 - day); // go to Monday of this week
  let start = addDays(x, mondayOffset);
  if (which === 'next') start = addDays(start, 7);
  const end = addDays(start, 6);
  return { start, end };
}

// nth weekday of a month: e.g., 4th Thursday of November (Thanksgiving)
function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
  const first = new Date(year, monthIndex, 1);
  const firstWd = first.getDay();
  const offset = (weekday - firstWd + 7) % 7;
  const day = 1 + offset + 7*(n-1);
  return new Date(year, monthIndex, day);
}

// US holiday resolver (observed **date**, not time) — extend as needed
function usHolidays(year) {
  const y = year;
  const newYearsDay = new Date(y, 0, 1);
  const mlkDay = nthWeekdayOfMonth(y, 0, 1, 3);   // 3rd Monday Jan
  const presidentsDay = nthWeekdayOfMonth(y, 1, 1, 3); // 3rd Monday Feb
  const memorialDay = (()=>{ // last Monday May
    const last = new Date(y, 4, 31);
    const d = last.getDay();
    return addDays(last, -((d+6)%7));
  })();
  const independenceDay = new Date(y, 6, 4);
  const laborDay = nthWeekdayOfMonth(y, 8, 1, 1); // 1st Monday Sep
  const columbusDay = nthWeekdayOfMonth(y, 9, 1, 2); // 2nd Monday Oct
  const halloween = new Date(y, 9, 31);
  const thanksgiving = nthWeekdayOfMonth(y, 10, 4, 4); // 4th Thu Nov
  const christmasEve = new Date(y, 11, 24);
  const christmas = new Date(y, 11, 25);
  const newYearsEve = new Date(y, 11, 31);

  return {
    "new year": newYearsDay,
    "new year's": newYearsDay,
    "new year's day": newYearsDay,
    "new year's eve": newYearsEve,
    "christmas": christmas,
    "christmas day": christmas,
    "christmas eve": christmasEve,
    "thanksgiving": thanksgiving,
    "halloween": halloween,
    "memorial day": memorialDay,
    "independence day": independenceDay,
    "labor day": laborDay,
    "columbus day": columbusDay,
    "mlk day": mlkDay,
    "presidents day": presidentsDay
  };
}

// map a holiday mention in text to a concrete {year, monthIndex} anchor
function holidayContextMonth(text = '', ref = new Date()) {
  const t = text.toLowerCase();
  const names = [
    "thanksgiving","christmas","christmas day","christmas eve",
    "new year","new year's","new year's day","new year's eve",
    "halloween","mlk day","presidents day","memorial day",
    "independence day","labor day","columbus day"
  ];
  const hit = names.find(n => t.includes(n));
  if (!hit) return null;
  const y0 = ref.getFullYear();
  // prefer the *upcoming* occurrence of that holiday
  let d = usHolidays(y0)[hit];
  if (!d || d < ref) d = usHolidays(y0 + 1)[hit];
  if (!d) return null;
  return { year: d.getFullYear(), month: d.getMonth() };
}

// coarse day-part → hour mapping
function dayPartToHour(word /* 'morning'|'afternoon'|'evening'|'night' */) {
  const w = (word||'').toLowerCase();
  if (w.includes('morning'))   return 9;
  if (w.includes('afternoon')) return 14;
  if (w.includes('evening'))   return 18;
  if (w.includes('night'))     return 20;
  return 17; // default 5pm
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
  const segs = [];
  const src = String(text || '').trim();
  if (!src) return segs;

  const norm = src
    .replace(/\u2013|\u2014/g, '-')     // –— -> -
    .replace(/\s+to\s+/gi, ' to ')
    .replace(/\s+through\s+/gi, ' through ')
    .replace(/\s+until\s+/gi, ' until ')
    .replace(/\s+till\s+/gi, ' till ');

  // local helpers
  function mk(y,m,d,t){
    const dt = new Date(y,m,d);
    if (t?.h != null) dt.setHours(t.h, t.min||0, 0, 0);
    else dt.setHours(17,0,0,0);
    return dt;
  }
  function spanHint(a,b){
    const days = Math.round((b - a) / (24*60*60*1000));
    return days >= 1 ? 'Overnight' : 'Daycare';
  }
  const times = extractDropPickTimes(src);

  // detect optional day-parts near each side of a range: "morning of the 27th ... to ... morning of the 28th"
  const leftPart  = (src.match(/(morning|afternoon|evening|night)[^]{0,40}?\b(?:of\s+)?(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b/i) || [])[1] || null;
  const rightPart = (src.match(/\bto\b[^]{0,80}?(morning|afternoon|evening|night)/i) || [])[1] || null;

  // ---------- A) explicit Rover-style: mm/dd[/yy] <connector> mm/dd[/yy] ----------
  const rxFast = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s*(?:to|through|thru|until|till|a|hasta|al|-\s*|\s*-\s*)\s*(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/i;
  const mFast = norm.match(rxFast);
  if (mFast) {
    const [ , m1, d1, y1, m2, d2, y2 ] = mFast;
    const mm1 = +m1 - 1, dd1 = +d1;
    const mm2 = +m2 - 1, dd2 = +d2;
    const Y1 = y1 ? (+y1 < 100 ? 2000 + +y1 : +y1) : yearInfer(ref, mm1, dd1);
    const Y2 = y2 ? (+y2 < 100 ? 2000 + +y2 : +y2) : yearInfer(ref, mm2, dd2);
    const startAt = mk(Y1, mm1, dd1, times?.start || null);
    const endAt   = mk(Y2, mm2, dd2, times?.end   || null);
    if (endAt < startAt) endAt.setDate(endAt.getDate() + 1);
    segs.push({ startAt, endAt, serviceHint: spanHint(startAt, endAt) });
    return segs;
  }

  // ---------- B) Relative single-day: today / tomorrow / tonight ----------
  if (/\btoday\b/i.test(norm)) {
    const s = setHM(startOfDay(ref), times?.start?.h ?? 17, times?.start?.min ?? 0);
    const e = setHM(startOfDay(ref), times?.end?.h ?? 17, times?.end?.min ?? 0);
    segs.push({ startAt: s, endAt: (e < s ? addDays(e,1) : e), serviceHint: spanHint(s,(e<s?addDays(e,1):e)) });
    return segs;
  }
  if (/\btonight\b/i.test(norm)) {
    const base = clone(ref);
    const s = setHM(base, 19, 0); // 7pm tonight
    const e = addDays(setHM(base, 8, 0), 1); // 8am tomorrow
    segs.push({ startAt: s, endAt: e, serviceHint: spanHint(s,e) });
    return segs;
  }
  if (/\btomorrow\b/i.test(norm)) {
    const tmr = addDays(startOfDay(ref), 1);
    const s = setHM(tmr, times?.start?.h ?? 17, times?.start?.min ?? 0);
    const e = setHM(tmr, times?.end?.h ?? 17, times?.end?.min ?? 0);
    segs.push({ startAt: s, endAt: (e < s ? addDays(e,1) : e), serviceHint: spanHint(s,(e<s?addDays(e,1):e)) });
    return segs;
  }

  // ---------- C) Weeks: "this week", "next week" ----------
  const wk = norm.match(/\b(this|next)\s+week\b/i);
  if (wk) {
    const which = wk[1].toLowerCase();
    const { start, end } = weekSpan(ref, which);
    const s = setHM(start, times?.start?.h ?? 9, times?.start?.min ?? 0);
    const e = setHM(end,   times?.end?.h ?? 17, times?.end?.min ?? 0);
    segs.push({ startAt: s, endAt: e, serviceHint: spanHint(s,e) });
    return segs;
  }

  // ---------- D) Weekends ----------
  // "this weekend" -> Fri 5pm .. Sun 5pm; "next weekend" similar
  const wknd = norm.match(/\b(this|next)\s+(long\s+)?weekend\b/i);
  if (wknd) {
    const which = wknd[1].toLowerCase();
    const isLong = !!wknd[2];
    // compute the Friday (this or next)
    let fri = thisOrNextWeekday(ref, 5);
    if (which === 'next') fri = nextWeekday(ref, 5);
    const start = setHM(fri, 17, 0);
    let endBase = addDays(fri, isLong ? 3 : 2); // long weekend -> through Monday
    const end = setHM(endBase, 17, 0);
    segs.push({ startAt: start, endAt: end, serviceHint: spanHint(start,end) });
    return segs;
  }

  // "fri-sun", "saturday to monday", "thu–sat"
  const wdRange = norm.match(new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})\\s*(?:to|-)\\s*(${Object.keys(WEEKDAYS).join('|')})\\b`, 'i'));
  if (wdRange) {
    const a = WEEKDAYS[wdRange[1].toLowerCase()];
    const b = WEEKDAYS[wdRange[2].toLowerCase()];
    const startW = thisOrNextWeekday(ref, a);
    let endW = thisOrNextWeekday(startW, b);
    if (endW <= startW) endW = addDays(endW, 7);
    const s = setHM(startW, times?.start?.h ?? 9, times?.start?.min ?? 0);
    const e = setHM(endW,   times?.end?.h ?? 17, times?.end?.min ?? 0);
    segs.push({ startAt: s, endAt: e, serviceHint: spanHint(s,e) });
    return segs;
  }

  // "this friday", "next tuesday"
  const singleWd = norm.match(new RegExp(`\\b(this|next)\\s+(${Object.keys(WEEKDAYS).join('|')})\\b`, 'i'));
  if (singleWd) {
    const which = singleWd[1].toLowerCase();
    const wd = WEEKDAYS[singleWd[2].toLowerCase()];
    const day = which === 'next' ? nextWeekday(ref, wd) : thisOrNextWeekday(ref, wd);
    const s = setHM(day, times?.start?.h ?? 9, times?.start?.min ?? 0);
    const e = setHM(day, times?.end?.h ?? 17, times?.end?.min ?? 0);
    if (e <= s) e.setHours(s.getHours() + 8);
    segs.push({ startAt: s, endAt: e, serviceHint: spanHint(s,e) });
    return segs;
  }

  // ---------- E) Holidays ----------
  const holWords = [
    "new year", "new year's", "new year's day", "new year's eve",
    "christmas", "christmas day", "christmas eve",
    "thanksgiving", "halloween", "memorial day", "independence day",
    "labor day", "columbus day", "mlk day", "presidents day"
  ];
  const holRx = new RegExp(`\\b(${holWords.map(w=>w.replace(/[\s']/g, m=> m===' ' ? '\\s+' : m)).join('|')})\\b`, 'i');
  const mh = norm.match(holRx);
  if (mh) {
    const yNow = ref.getFullYear();
    let day = usHolidays(yNow)[mh[1].toLowerCase()];
    if (!day || day < addDays(ref,-7)) { // if it looks past, try next year
      day = usHolidays(yNow+1)[mh[1].toLowerCase()];
    }
    if (day) {
      const s = setHM(day, times?.start?.h ?? 9, times?.start?.min ?? 0);
      const e = setHM(day, times?.end?.h ?? 17, times?.end?.min ?? 0);
      if (e <= s) e.setHours(s.getHours() + 8);
      segs.push({ startAt: s, endAt: e, serviceHint: spanHint(s,e) });
      return segs;
    }
  }

  // ---------- F) "first weekend of dec" / "2nd weekend of november" ----------
  const wkendOf = norm.match(new RegExp(`\\b(\\d+(?:st|nd|rd|th)|first|second|third|fourth)\\s+weekend\\s+of\\s+(${MONTH_RX})\\b`, 'i'));
  if (wkendOf) {
    const ordWord = wkendOf[1].toLowerCase();
    const ordMap = { first:1, second:2, third:3, fourth:4 };
    const n = ordMap[ordWord] || parseInt(ordWord,10);
    const mm = monoMonth(wkendOf[2]);
    const y = ref.getFullYear();
    // find the nth Saturday of that month (weekend = Sat..Sun)
    const firstOfMonth = new Date(y, mm, 1);
    let count = 0, sat = null;
    for (let d=1; d<=31; d++){
      const dt = new Date(y, mm, d);
      if (dt.getMonth() !== mm) break;
      if (dt.getDay() === 6) { // Saturday
        count++;
        if (count === n) { sat = dt; break; }
      }
    }
    if (sat) {
      const sun = addDays(sat, 1);
      const s = setHM(sat, 9, 0);
      const e = setHM(sun, 17, 0);
      segs.push({ startAt: s, endAt: e, serviceHint: spanHint(s,e) });
      return segs;
    }
  }

  // ---------- G) “this month on the 19th”, “next month 12-19”, “first of dec” ----------
  const relMonthMatch = norm.match(/\b(this|next)\s+month\b/i);
  if (relMonthMatch) {
    const which = relMonthMatch[1].toLowerCase();
    const base  = new Date(ref);
    if (which === 'next') base.setMonth(base.getMonth()+1);
    const Y = base.getFullYear(), M = base.getMonth();

    const mRange = norm.match(/\bmonth[^0-9]*(\d{1,2})\s*[-]\s*(\d{1,2})\b/i);
    if (mRange) {
      const d1 = +mRange[1], d2 = +mRange[2];
      const s = mk(Y,M,d1,times?.start||null);
      const e = mk(Y,M,d2,times?.end||null);
      if (e < s) e.setDate(e.getDate()+1);
      segs.push({ startAt:s, endAt:e, serviceHint: spanHint(s,e) });
      return segs;
    }
    const mDay = norm.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i) || norm.match(/\bmonth[^0-9]*(\d{1,2})\b/i);
    if (mDay) {
      const d = +mDay[1];
      const s = mk(Y,M,d,times?.start||null);
      const e = mk(Y,M,d,times?.end||null);
      if (e < s) e.setDate(e.getDate()+1);
      segs.push({ startAt:s, endAt:e, serviceHint: spanHint(s,e) });
      return segs;
    }
  }
  const mFirst = norm.match(new RegExp(`\\b(first|1st)\\s+of\\s+(${MONTH_RX})\\b`, 'i'));
  if (mFirst) {
    const mm = monoMonth(mFirst[2]);
    const yy = yearInfer(ref, mm, 1);
    const s = mk(yy,mm,1,times?.start||null);
    const e = mk(yy,mm,1,times?.end||null);
    segs.push({ startAt:s, endAt:e, serviceHint: spanHint(s,e) });
    return segs;
  }

  // ---------- H) Fallback: robust token scanner + holiday-anchored bare ordinals ----------
  let toks = scanDateTokens(norm, ref);

  // If we didn't find explicit month tokens, try bare ordinals anchored by a holiday in the same message.
  if (!toks.length) {
    const anchor = holidayContextMonth(src, ref);
    const ords = [...norm.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)].map(m => +m[1]).filter(d => d>=1 && d<=31);
    if (anchor && ords.length) {
      toks = ords.map((dd,i) => ({ mm: anchor.month, dd, yy: anchor.year, idx: i }));
    }
  }

  if (!toks.length) return segs;

  const connectors = new RegExp(`\\b(?:to|a|hasta|al|through|thru|until|till|-)\\b`, 'i');
  const lower = norm.toLowerCase();

  for (let i = 0; i < toks.length; i++) {
    const a = toks[i];
    let b = null;
    if (i + 1 < toks.length) {
      const between = lower.slice(toks[i].idx, toks[i+1].idx + 1);
      if (connectors.test(between)) { b = toks[i+1]; i++; }
    }
    const startH = times?.start?.h ?? dayPartToHour(leftPart || '');
    const endH   = times?.end?.h   ?? dayPartToHour(rightPart || '');
    const startAt = mk(a.yy, a.mm, a.dd, { h: startH, min: times?.start?.min ?? 0 });
    const endAt   = mk(b ? b.yy : a.yy, b ? b.mm : a.mm, b ? b.dd : a.dd, { h: endH, min: times?.end?.min ?? 0 });
    if (endAt < startAt) endAt.setDate(endAt.getDate() + 1);
    segs.push({ startAt, endAt, serviceHint: spanHint(startAt, endAt) });
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
    // accept date-only or keyword-only as candidates (date-only is the main win here)
    const isCandidate = !!range || keywords.length > 0;

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
