import { describe, expect, it } from 'vitest';

const ENV = {
  JWT_SECRET: 'test-jwt-secret-with-enough-bytes-32+',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
};

describe('R4 endpoint guards', () => {
  it('upload-evidence sin auth → 401', async () => {
    const { handleUploadEvidence } = await import('./upload-evidence.js');
    const req = new Request('https://example.com/api/upload-evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: 'empresa_base', photo: 'x' }),
    });
    const res = await handleUploadEvidence(req, ENV);
    expect(res.status).toBe(401);
  });

  it('mobile-sync sin auth → 401', async () => {
    const { handleMobileSync } = await import('./mobile-sync.js');
    const req = new Request('https://example.com/api/mobile-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: 'empresa_base',
        rut: '1-9',
        path: '/viajes/estado',
        payload: { estado: 'X', trip_id: 't1' },
      }),
    });
    const res = await handleMobileSync(req, ENV);
    expect(res.status).toBe(401);
  });

  it('validateRemoteUrl bloquea SSRF típico usado por sync', async () => {
    const { validateRemoteUrl } = await import('../helpers/safe-remote-fetch.js');
    expect(validateRemoteUrl('https://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(validateRemoteUrl('http://evil.com/csv').ok).toBe(false);
  });
});
