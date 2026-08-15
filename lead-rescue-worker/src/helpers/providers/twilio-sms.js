/**
 * Twilio SMS provider (env-gated).
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 */

export async function sendTwilioSms(env, { to, body }) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    return { ok: false, skipped: true, error: 'twilio_not_configured' };
  }
  if (!to) return { ok: false, skipped: true, error: 'missing_to' };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = btoa(`${sid}:${token}`);
  const form = new URLSearchParams({ To: String(to), From: String(from), Body: String(body || '') });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `twilio_http_${res.status}`, detail: text.slice(0, 300) };
    }
    let json = {};
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { ok: true, provider_id: json.sid || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
