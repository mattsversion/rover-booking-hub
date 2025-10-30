// src/server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { prisma } from './db.js';
import { api } from './routes/api.js';
import expressLayouts from 'express-ejs-layouts';
import { webhooks } from './routes/webhooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, _res, next) => {
  console.log('REQ', req.method, req.url);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/webhooks', webhooks);
app.use('/api', api);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(expressLayouts);
app.set('layout', 'layout'); // views/layout.ejs by default

app.use('/public', express.static(path.join(__dirname, '../public')));

/** simple dashboard auth */
function requireAuth(req, res, next){
  if (req.path.startsWith('/webhooks')) return next();
  if (req.path === '/login' || req.path === '/do-login') return next();
  if (req.cookies?.sess === process.env.DASH_PASSWORD) return next();
  return res.redirect('/login');
}
app.use(requireAuth);

app.get('/login', (_req, res) => res.render('login'));
app.post('/do-login', (req, res) => {
  if ((req.body.password || '') === process.env.DASH_PASSWORD) {
    res.cookie('sess', process.env.DASH_PASSWORD, { httpOnly:true, sameSite:'lax' });
    return res.redirect('/');
  }
  res.render('login', { error:'Wrong Password' });
});

/** HOME: Unread / Pending / Booked */
app.get('/', async (_req, res) => {
  const unread = await prisma.booking.findMany({
    where: { messages: { some: { direction: 'IN', isRead: false } } },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'desc' } }, pets: true }
  });

  const pending = await prisma.booking.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'desc' } }, pets: true }
  });

  const booked = await prisma.booking.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: { startAt: 'asc' },
    include: { messages: { orderBy: { createdAt: 'desc' } }, pets: true }
  });

  res.render('inbox', { unread, pending, booked });
});

/** BOOKING DETAIL: mark inbound messages as read */
app.get('/booking/:id', async (req, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } }, pets: true }
  });
  if (!booking) return res.status(404).send('Not found');

  await prisma.message.updateMany({
    where: { bookingId: booking.id, direction: 'IN', isRead: false },
    data: { isRead: true }
  });

  res.render('booking', { booking });
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () =>
  console.log(`Listening on http://localhost:${port}`)
);

// start OAuth
app.get('/api/auth/google/start', (_req, res) => {
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const url = o.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly'
    ]
  });
  res.redirect(url);
});

// callback -> prints refresh token once
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const o = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await o.getToken(req.query.code);
    res.send(`<pre>Copy this REFRESH TOKEN into .env as GOOGLE_REFRESH_TOKEN:\n\n${tokens.refresh_token || '(none)'}\n\nThen restart the server.</pre>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth error. Check console.');
  }
});
