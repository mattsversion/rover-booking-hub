// src/services/classifier.js
<<<<<<< HEAD
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * classifyMessage(text: string) -> { label, score, extracted }
 */
export async function classifyMessage(text) {
  // ultra-compact prompt tuned for short SMS
  const sys = `You are a booking-intake classifier for a dog sitting business.
Output strict JSON with keys: label, score (0..1), extracted {startAt?, endAt?, serviceType?, dogsCount?, clientName?}.
Labels: BOOKING_REQUEST, DATE_QUESTION, GENERAL, SPAM. Be conservative. Dates ISO if explicit.`;

  const user = `Text:\n"""${text}"""`;

  const resp = await client.responses.create({
    model: "gpt-4.1-mini", // small/fair cost; change if you prefer
    input: [{ role: "system", content: sys }, { role: "user", content: user }],
    temperature: 0.1,
  });

  // pull first JSON object from response
  const raw = resp.output_text || "{}";
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const { label = "GENERAL", score = 0, extracted = {} } = parsed;
  return { label, score: Number(score) || 0, extracted };
=======
// Uses OpenAI if both the package and OPENAI_API_KEY are available.
// Falls back to a heuristic otherwise.

export async function classifyMessage(text) {
  // Fallback first (keeps server safe)
  const fallback = () => {
    const t = (text || '').toLowerCase();
    const hasBookingWord = /\b(book|booking|reserve|reservation|overnight|day ?care|drop[\s-]?in|walk|sitter?)\b/.test(t);
    return { label: hasBookingWord ? 'BOOKING_REQUEST' : 'OTHER', score: hasBookingWord ? 0.6 : 0.2, extracted: null };
  };

  if (!process.env.OPENAI_API_KEY) return fallback();

  // Lazy import so startup doesn't fail if package isn't present
  let OpenAI;
  try {
    OpenAI = (await import('openai')).default;
  } catch {
    return fallback();
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Keep the prompt tiny + JSON-only for easy parsing
    const prompt = `
You classify dog-sitting messages.
Return compact JSON: {"label":"BOOKING_REQUEST"|"OTHER","score":0..1,"startAt":null|ISO,"endAt":null|ISO}
Text: ${JSON.stringify(text || '')}
`.trim();

    // Works with OpenAI v4 client (chat.completions is widely supported)
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Return only JSON, no prose.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    });

    const raw = resp?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return fallback(); }

    const label = parsed.label === 'BOOKING_REQUEST' ? 'BOOKING_REQUEST' : 'OTHER';
    const score = Number(parsed.score) || 0;
    const extracted =
      parsed.startAt || parsed.endAt
        ? { startAt: parsed.startAt || null, endAt: parsed.endAt || null }
        : null;

    return { label, score, extracted };
  } catch {
    return fallback();
  }
>>>>>>> 9e30856 (classifier: lazy import openai + JSON output with fallback)
}
