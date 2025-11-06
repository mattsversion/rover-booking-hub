// src/routes/exports.js
import express from 'express';
import { prisma } from '../db.js';

export const exportsRouter = express.Router();

// Helper to collect confirmed bookings + pets
async function fetchConfirmed() {
  const now = new Date();
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', endAt: { gte: now } },
    orderBy: [{ startAt: 'asc' }],
    include: { pets: true }
  });
  return { bookings, generatedAt: Date.now() };
}

// HTML view (print-friendly)
exportsRouter.get('/exports/confirmed', async (req, res) => {
  const data = await fetchConfirmed();
  res.render('export-confirmed.ejs', data);
});

// Real PDF generation using Chromium (falls back to HTML on failure)
exportsRouter.get('/exports/confirmed.pdf', async (req, res) => {
  const data = await fetchConfirmed();

  try {
    // Render EJS to HTML string
    const html = await new Promise((resolve, reject) => {
      req.app.render('export-confirmed.ejs', data, (err, out) => {
        if (err) reject(err); else resolve(out);
      });
    });

    // Lazy import only when needed
    const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
      import('@sparticuz/chromium'),
      import('puppeteer-core')
    ]);

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: ['domcontentloaded', 'networkidle0'] });

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' }
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="confirmed.pdf"');
    return res.send(pdf);
  } catch (e) {
    console.error('[exports] PDF generation failed:', e);
    // Fallback: show the HTML so you can still print
    const msg = 'PDF generation failed on the server; showing the printable HTML instead.';
    res.status(200);
    return res.render('export-confirmed.ejs', { ...data, pdfError: msg });
  }
});
