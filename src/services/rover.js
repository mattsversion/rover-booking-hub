// src/services/rover.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Where we persist cookies for future headless runs
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOKIES_FILE = path.join(__dirname, '../../storage/rover.cookies.json');

// ---------- Public API ----------

/**
 * Ensure we have a Rover session (logged in), returning { browser, page } when
 * the puppeteer stack is available. If puppeteer stack is missing, throws a
 * controlled error that callers can handle (e.g., by using a fallback path).
 */
export async function ensureSession() {
  const stack = await getPuppeteerStack();
  if (!stack) {
    throw new Error('puppeteer_stack_unavailable');
  }
  const { puppeteer, chromium } = stack;

  const headless = String(process.env.HEADLESS || '').toLowerCase() !== 'false';
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    executablePath,
    headless: chromium.headless ?? headless,
    args: chromium.args,
    defaultViewport: chromium.defaultViewport
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
  );

  await loadCookies(page);

  const SIGNIN_CONTINUE = 'https://www.rover.com/account/continue/?bep=event%3Dnavigation-sign-in&action=sign_in&next=/';
  const SIGNIN_DIRECT   = 'https://www.rover.com/account/sign-in/?next=/account/';
  const ACCOUNT_HOME    = 'https://www.rover.com/account/';

  const isLoggedIn = async () =>
    !!(await page.$('a[href*="/account/settings"], a[href*="/account/logout"], [data-qa="profile-menu"]'));

  const looksLikeSignup = async () => {
    const url = page.url();
    if (/sign-?up/i.test(url)) return true;
    const zip = await page.$('input[name*="zip"], input#zip, input[autocomplete="postal-code"]');
    if (zip) return true;
    const hasCreate = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a'));
      return !!els.find(el => /create\s+account/i.test(el.textContent || ''));
    });
    return hasCreate;
  };

  await goto(page, SIGNIN_CONTINUE);

  if (await isLoggedIn()) {
    await saveCookies(page);
    return { browser, page };
  }

  if (await looksLikeSignup()) {
    await goto(page, SIGNIN_DIRECT);
  }

  // Try “Sign in with email” if that interstitial appears
  try {
    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a'))
        .find(x => /sign\s*in\s*with\s*email/i.test(x.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    });
    if (clicked) {
      try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }); } catch {}
    }
  } catch {}

  if (await isLoggedIn()) {
    await saveCookies(page);
    return { browser, page };
  }

  // Robustly type into email/password (multiple selectors + DOM set fallback)
  const robustType = async (selectorList, value) => {
    try {
      await typeField(page, selectorList, value);
    } catch {
      await page.evaluate((sels, val) => {
        const list = Array.isArray(sels) ? sels : [sels];
        for (const sel of list) {
          const el = document.querySelector(sel);
          if (el) { el.value = val || ''; el.dispatchEvent(new Event('input', { bubbles:true })); return; }
        }
      }, selectorList, value);
    }
  };

  await robustType(['input[type="email"]','input[name="email"]','input#email','input[autocomplete="email"]'], process.env.ROVER_EMAIL || '');
  await robustType(['input[type="password"]','input[name="password"]','input#password','input[autocomplete="current-password"]'], process.env.ROVER_PASSWORD || '');

  await clickSubmit(page);

  try {
    await page.waitForFunction(() => location.pathname.startsWith('/account'), { timeout: 30000 });
  } catch {}

  if (!(await isLoggedIn())) {
    // If running headless=false locally: finish any 2FA manually in the visible window, then call again.
    throw new Error('rover_login_incomplete');
  }

  await saveCookies(page);
  await goto(page, ACCOUNT_HOME);
  return { browser, page };
}

/**
 * Scrape pets from a Rover request/conversation page.
 * hint can be { externalId } or { relay } (Samsung relay number digits).
 */
export async function fetchPetsFromRover(hint) {
  const stack = await getPuppeteerStack();
  if (!stack) {
    // Without puppeteer, we can’t click around the authed UI
    return [];
  }
  const { browser, page } = await ensureSession();
  try {
    if (hint?.externalId) {
      await goto(page, `https://www.rover.com/account/requests/${hint.externalId}/`);
    } else {
      await goto(page, 'https://www.rover.com/account/messages/');
      if (hint?.relay) {
        const digits = String((hint.relay || '').replace(/\D/g, ''));
        const href = await page.evaluate((needle) => {
          const links = Array.from(document.querySelectorAll('a'));
          const ln = links.find(a => (a.textContent || '').replace(/\D/g,'').includes(needle));
          return ln ? ln.href : null;
        }, digits);
        if (href) await goto(page, href);
      }
    }

    const pets = await page.$$eval('.pet-card, [data-component="pet-card"], .petProfileCard', cards => {
      const clean = s => (s||'').trim();
      return cards.map(card => {
        const name = clean(card.querySelector('.pet-name, .PetName, [data-qa="pet-name"]')?.textContent);
        const breed = clean(card.querySelector('.pet-breed, [data-qa="pet-breed"]')?.textContent);
        const stats = clean(card.querySelector('.pet-stats, .PetStats')?.textContent || '');
        const ageMatch = stats.match(/(\d+)\s*year/i);
        const weightMatch = stats.match(/(\d+(?:\.\d+)?)\s*(lb|lbs|pound)/i);
        const instructions = clean(card.querySelector('.pet-notes, .notes, [data-qa="pet-notes"]')?.textContent);
        const img = card.querySelector('img')?.src;
        return {
          name: name || 'Dog',
          breed: breed || null,
          ageYears: ageMatch ? Number(ageMatch[1]) : null,
          weightLbs: weightMatch ? Number(weightMatch[1]) : null,
          instructions: instructions || null,
          photoUrl: img || null
        };
      });
    });

    return pets || [];
  } finally {
    try { await browser.close(); } catch {}
  }
}

/**
 * Scrape a single public Rover dog profile page.
 * Uses puppeteer if available; otherwise falls back to fetch + light parsing.
 */
export async function fetchPetFromProfileUrl(url) {
  const stack = await getPuppeteerStack();
  if (stack) {
    // Puppeteer path (auth not required for public profile, but works both ways)
    const { browser, page } = await ensureSession();
    try {
      await goto(page, url);
      const pet = await page.evaluate(() => {
        const clean = (s) => (s || '').trim();

        const nameEl = document.querySelector('h1, h2');
        const name = clean(nameEl?.textContent);

        let breed = null;
        const header = nameEl?.closest('section, div') || document.body;
        const near = header.querySelector('h1,h2')?.parentElement?.querySelector('p, div');
        if (near) breed = clean(near.textContent);

        const textNear = clean(header.innerText || '');
        const ageMatch = textNear.match(/(\d+)\s*years?/i);
        const weightMatch = textNear.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)/i);

        const aboutHeader = [...document.querySelectorAll('h2,h3')].find(h => /about/i.test(h.textContent));
        let instructions = null;
        if (aboutHeader) {
          const area = aboutHeader.parentElement;
          const p = area.querySelector('p');
          if (p) instructions = clean(p.textContent);
        }

        const img = document.querySelector('img')?.src;

        return {
          name: name || 'Dog',
          breed: breed || null,
          ageYears: ageMatch ? Number(ageMatch[1]) : null,
          weightLbs: weightMatch ? Number(weightMatch[1]) : null,
          instructions: instructions || null,
          photoUrl: img || null
        };
      });

      return pet || null;
    } finally {
      try { await browser.close(); } catch {}
    }
  }

  // Fallback: no puppeteer on the platform — use fetch + regex/loose parsing
  return await scrapeWithFetch(url);
}

// ---------- Internal helpers ----------

async function getPuppeteerStack() {
  try {
    const [{ default: puppeteerExtra }, { default: Stealth }, { default: chromium }] =
      await Promise.all([
        import('puppeteer-extra'),
        import('puppeteer-extra-plugin-stealth'),
        import('@sparticuz/chromium')
      ]);

    // Bind stealth to puppeteer-extra and ensure it uses puppeteer-core under the hood
    puppeteerExtra.use(Stealth());

    // If puppeteer-core is not present, puppeteer-extra still provides launch,
    // but in our deps we do include puppeteer-core, so this is fine.
    return { puppeteer: puppeteerExtra, chromium };
  } catch {
    // One or more modules missing in this environment
    return null;
  }
}

async function loadCookies(page){
  try {
    const json = await fs.readFile(COOKIES_FILE, 'utf8');
    const cookies = JSON.parse(json);
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
    }
  } catch {}
}

async function saveCookies(page){
  const cookies = await page.cookies();
  await fs.mkdir(path.dirname(COOKIES_FILE), { recursive: true });
  await fs.writeFile(COOKIES_FILE, JSON.stringify(cookies, null, 2), 'utf8');
}

async function goto(page, url){
  await page.goto(url, { waitUntil: 'networkidle2' });
}

async function typeField(page, selectorList, value){
  const selectors = Array.isArray(selectorList) ? selectorList : [selectorList];
  let handle = null;
  for (const sel of selectors){
    try {
      handle = await page.waitForSelector(sel, { timeout: 4000 });
      if (handle) break;
    } catch {}
  }
  if (!handle) throw new Error(`Field not found for selectors: ${selectors.join(', ')}`);

  await handle.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await handle.type(value ?? '', { delay: 20 });
}

async function clickSubmit(page){
  const candidates = [
    'button[type=submit]',
    'button[data-qa="sign-in-submit"]',
    'form button'
  ];

  for (const sel of candidates){
    const btn = await page.$(sel);
    if (btn){
      try {
        await Promise.all([
          btn.click(),
          page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);
        return;
      } catch {
        await page.evaluate(el => el.click(), btn);
        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }); } catch {}
        return;
      }
    }
  }

  const didSubmit = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; }
    return false;
  });
  if (didSubmit) {
    try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }); } catch {}
  } else {
    throw new Error('Could not find Sign In button');
  }
}

async function scrapeWithFetch(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const html = await res.text();

  const name =
    matchText(html, /<h1[^>]*>(.*?)<\/h1>/i) ||
    matchText(html, /<title[^>]*>(.*?)<\/title>/i)?.replace(/[-|•].*$/, '').trim() ||
    'Dog';

  const breed =
    matchText(html, /(Breed|breed)[^<:]*[:>]\s*([^<\n\r]+)/) ||
    matchText(html, /"breed"\s*:\s*"([^"]+)"/i) ||
    null;

  const photoUrl =
    matchAttr(html, /<img[^>]+src="([^"]+)"[^>]*>/i) ||
    null;

  return {
    name,
    breed,
    ageYears: null,
    weightLbs: null,
    instructions: null,
    photoUrl
  };
}

function matchText(html, re) {
  const m = re.exec(html);
  if (!m) return null;
  return decodeHtml(m[1] || m[2] || '').trim();
}
function matchAttr(html, re) {
  const m = re.exec(html);
  if (!m) return null;
  return m[1];
}
function decodeHtml(s) {
  return String(s)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}
