// src/routes/admin-classify.js
import { Router } from 'express';
import { prisma } from '../db.js';
import { classifyMessage } from '../services/classifier.js';

export const adminClassify = Router();

adminClassify.post('/admin/reclassify', async (_req, res) => {
  const messages = await prisma.message.findMany({ orderBy: { createdAt: 'asc' }, take: 2000 });
  for (const m of messages) {
    const { label, score, extracted } = await classifyMessage(m.body || '');
    await prisma.message.update({
      where: { id: m.id },
      data: {
        isBookingCandidate: label === 'BOOKING_REQUEST' && score >= 0.6,
        classifyLabel: label,
        classifyScore: score,
        extractedJson: extracted
      }
    });
  }
  res.redirect('/'); // or return JSON
});
