// src/services/rover.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import Stealth from 'puppeteer-extra-plugin-stealth';

puppeteer.use(Stealth());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOKIES_FILE = path.join(__dirname, '../../storage/rover.cookies.json');

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

/** robustly focus a field and type value (clears previous text) */
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

  await handle.click({ clickCount: 3 }); // select-all
  await page.keyboard.press('Backspace');
  await handle.type(value ?? '', { delay: 20 });
}

async function clickSubmit(page){
  // try common selectors
  const candidates = [
    'button[type=submit]',
    'button[data-qa="sign-in-submit"]',
    'form button'
  ];

  for (const sel of candidates){
    const btn = await page.$(sel);
    if (btn){
      try {
        // normal Puppeteer click
        await Promise.all([
          btn.click(),
          page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);
        return;
      } catch {
        // fallback: force click inside DOM
        await page.evaluate(el => el.click(), btn);
        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }); } catch {}
        return;
      }
    }
  }

  // fallback: submit first form
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


/** Ensure we’re logged in using the /account/continue entrypoint. */
export async function ensureSession(){
  const browser = await puppeteer.launch({
    headless: false, // first run visible for 2FA; switch to true after cookies saved
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36');
  await loadCookies(page);

  const SIGNIN_CONTINUE = 'https://www.rover.com/account/continue/?bep=event%3Dnavigation-sign-in&action=sign_in&next=/';
  const SIGNIN_DIRECT   = 'https://www.rover.com/account/sign-in/?next=/account/';
  const ACCOUNT_HOME    = 'https://www.rover.com/account/';

  async function isLoggedIn(){
    return !!(await page.$('a[href*="/account/settings"], a[href*="/account/logout"], [data-qa="profile-menu"]'));
  }
  async function looksLikeSignup(){
    const url = page.url();
    if (/sign-?up/i.test(url)) return true;
    // presence of ZIP or "Create account" button is a sign-up form
    const zip = await page.$('input[name*="zip"], input#zip, input[autocomplete="postal-code"]');
    if (zip) return true;
    const hasCreate = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a'));
      return !!els.find(el => /create\s+account/i.test(el.textContent || ''));
    });
    return hasCreate;
  }

  // 1) Start at continue link
  await goto(page, SIGNIN_CONTINUE);

  // If we ended up in account already, done.
  if (await isLoggedIn()){
    await saveCookies(page);
    return { browser, page };
  }

  // 2) If that dropped us into sign-up, force sign-in
  if (await looksLikeSignup()) {
    await goto(page, SIGNIN_DIRECT);
  }

  // 3) Some flows have a “Sign in with email” step. Click it if present (text search via DOM).
  try {
    const clickedEmailEntry = await page.evaluate(() => {
      const clickable = Array.from(document.querySelectorAll('button, a'))
        .find(el => /sign\s*in\s*with\s*email/i.test(el.textContent || ''));
      if (clickable) { clickable.click(); return true; }
      return false;
    });
    if (clickedEmailEntry) {
      try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }); } catch {}
    }
  } catch {}

  // If already logged in after the above, save + return.
  if (await isLoggedIn()){
    await saveCookies(page);
    return { browser, page };
  }

  // 4) Fill EMAIL + PASSWORD robustly (multiple selector options + fallback)
  async function robustType(selectorList, value){
    try {
      await typeField(page, selectorList, value);
    } catch {
      // Fallback: set value via DOM (sometimes overlays intercept clicks)
      await page.evaluate((sels, val) => {
        const list = Array.isArray(sels) ? sels : [sels];
        for (const sel of list) {
          const el = document.querySelector(sel);
          if (el) { el.value = val || ''; el.dispatchEvent(new Event('input', { bubbles:true })); return; }
        }
      }, selectorList, value);
    }
  }

  await robustType(['input[type="email"]','input[name="email"]','input#email','input[autocomplete="email"]'], process.env.ROVER_EMAIL || '');
  await robustType(['input[type="password"]','input[name="password"]','input#password','input[autocomplete="current-password"]'], process.env.ROVER_PASSWORD || '');

  // 5) Submit the form
  await clickSubmit(page);

  // 6) If 2FA/challenge appears, complete it manually in the visible browser
  try {
    await page.waitForFunction(() => location.pathname.startsWith('/account'), { timeout: 30000 });
  } catch {}

  // 7) Final check
  if (!(await isLoggedIn())) {
    throw new Error('Login didn’t complete. Finish any 2FA/verification in the window, then try again.');
  }

  // 8) Save cookies for future headless runs
  await saveCookies(page);
  // Optionally go to account home to standardize state
  await goto(page, ACCOUNT_HOME);
  return { browser, page };
}

/**
 * Fetch pet profiles for a booking by opening Rover messages or request page
 * and scraping visible pet cards. `hint` can be { externalId } or { relay }.
 */
export async function fetchPetsFromRover(hint){
  const { browser, page } = await ensureSession();
  try {
    if (hint?.externalId) {
      await goto(page, `https://www.rover.com/account/requests/${hint.externalId}/`);
    } else {
      // Open messages and click a thread whose text contains the relay digits
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

    // Scrape pet cards (selectors may change over time)
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

    return pets;
  } finally {
    await browser.close();
  }
}

/** Fetch a single pet from a Rover dog profile URL (…/dogs/XXXX/). */
export async function fetchPetFromProfileUrl(url){
  const { browser, page } = await ensureSession();
  try {
    await goto(page, url);

    const pet = await page.evaluate(() => {
      const clean = (s) => (s || '').trim();

      const nameEl = document.querySelector('h1, h2');
      const name = clean(nameEl?.textContent);

      // breed line near the name
      let breed = null;
      const header = nameEl?.closest('section, div') || document.body;
      const near = header.querySelector('h1,h2')?.parentElement?.querySelector('p, div');
      if (near) breed = clean(near.textContent);

      const textNear = clean(header.innerText || '');
      const ageMatch = textNear.match(/(\d+)\s*years?/i);
      const weightMatch = textNear.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)/i);

      // look for care instructions within "About"
      let instructions = null;
      const aboutHeader = [...document.querySelectorAll('h2,h3')].find(h => /about/i.test(h.textContent));
      if (aboutHeader) {
        const area = aboutHeader.parentElement;
        const care = [...area.querySelectorAll('*')].find(n => /care instructions?/i.test(n.textContent));
        if (care) {
          const p = care.parentElement?.querySelector('p, div + p, p + p');
          if (p) instructions = clean(p.textContent);
        } else {
          const p = area.querySelector('p');
          if (p) instructions = clean(p.textContent);
        }
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

    return pet;
  } finally {
    await browser.close();
  }
}
