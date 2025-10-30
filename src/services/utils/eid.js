import crypto from 'crypto';

/** Build a stable message EID from platform/thread/provider id (or fallback). */
export function buildEID({ platform, threadId, providerMessageId, from, body, timestamp }) {
  const raw = (platform && threadId && providerMessageId)
    ? `${platform}::${threadId}::${providerMessageId}`
    : `${platform || 'sms'}::${from || ''}::${timestamp || ''}::${String(body || '').slice(0, 120)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}
