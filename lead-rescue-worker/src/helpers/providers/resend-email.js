/**
 * Resend email provider (env-gated).
 * Requires: RESEND_API_KEY, optional RESEND_FROM_EMAIL
 */

export async function sendResendEmail(env, { to, subject, html, text }) {
  const key = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL || 'OTIF Sentinel <onboarding@resend.dev>';
  if (!key) return { ok: false, skipped: true, error: 'resend_not_configured' };
  if (!to) return { ok: false, skipped: true, error: 'missing_to' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [String(to)],
        subject: subject || 'Actualización de tu entrega',
        html: html || undefined,
        text: text || undefined,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `resend_http_${res.status}`, detail: JSON.stringify(body).slice(0, 300) };
    }
    return { ok: true, provider_id: body.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
