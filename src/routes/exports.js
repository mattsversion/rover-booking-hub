// src/routes/exports.js
import express from 'express';
import { prisma } from '../db.js';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export const exportsRouter = express.Router();

// helper: consistently format in Eastern Time
function fmt(dt){
  const d = new Date(dt);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }).format(d);
}

// HTML view (nice for preview / browser print)
exportsRouter.get('/exports/confirmed', async (_req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: { startAt: 'asc' },
    include: { pets: true }
  });

  res.render('export-confirmed', {
    bookings,
    generatedAt: Date.now(),
    fmt // pass formatter to EJS
  });
});

// Real PDF (renders the same EJS server-side, then prints to PDF)
exportsRouter.get('/exports/confirmed.pdf', async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: { startAt: 'asc' },
    include: { pets: true }
  });

  // Render EJS to HTML string
  const html = await new Promise((resolve, reject) => {
    req.app.render('export-confirmed', {
      bookings,
      generatedAt: Date.now(),
      fmt
    }, (err, str) => err ? reject(err) : resolve(str));
  });

  // launch headless for serverless (Render) using sparticuz/chromium
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: ['load', 'domcontentloaded'] });

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '14mm', left: '14mm', right: '14mm', bottom: '14mm' }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="confirmed.pdf"');
    return res.send(pdf);
  } finally {
    await browser.close().catch(()=>{});
  }
});
