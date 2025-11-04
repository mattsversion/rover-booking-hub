// src/services/classifier.js
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
}
