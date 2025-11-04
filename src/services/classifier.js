// src/services/classifier.js
// Uses OpenAI if available; otherwise falls back to lightweight heuristics.

export async function classifyMessage(text) {
  const fallback = () => {
    const t = (text || '').toLowerCase();
    const hasBookingWord = /\b(book|booking|reserve|reservation|overnight|board|day ?care|drop[\s-]?in|walk|walker|sitter|sitting)\b/.test(
      t
    );
    return {
      label: hasBookingWord ? 'BOOKING_REQUEST' : 'GENERAL',
      score: hasBookingWord ? 0.6 : 0.2,
      extracted: {},
    };
  };

  if (!process.env.OPENAI_API_KEY) return fallback();

  let OpenAI;
  try {
    OpenAI = (await import('openai')).default;
  } catch {
    return fallback();
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const sys =
      'You are a booking-intake classifier for a dog-sitting business. Return ONLY JSON.';
    const user = `
Classify this SMS text and extract details when explicit.
Return JSON: {"label":"BOOKING_REQUEST"|"DATE_QUESTION"|"GENERAL"|"SPAM","score":0..1,"extracted":{"startAt":ISO|null,"endAt":ISO|null,"serviceType":string|null,"dogsCount":number|null,"clientName":string|null}}
Text: ${JSON.stringify(text || '')}
`.trim();

    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });

    const raw = resp?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback();
    }

    const {
      label = 'GENERAL',
      score = 0,
      extracted = {},
    } = parsed || {};
    return {
      label,
      score: Number(score) || 0,
      extracted: extracted || {},
    };
  } catch {
    return fallback();
  }
}
