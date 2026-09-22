import { describe, expect, it } from 'vitest';
import { validateRemoteUrl } from './safe-remote-fetch.js';

describe('validateRemoteUrl', () => {
  it('acepta HTTPS público', () => {
    const r = validateRemoteUrl('https://example.com/file.csv');
    expect(r.ok).toBe(true);
  });

  it('rechaza http', () => {
    expect(validateRemoteUrl('http://example.com/a').ok).toBe(false);
  });

  it('rechaza localhost y RFC1918', () => {
    expect(validateRemoteUrl('https://localhost/x').ok).toBe(false);
    expect(validateRemoteUrl('https://127.0.0.1/x').ok).toBe(false);
    expect(validateRemoteUrl('https://10.0.0.5/x').ok).toBe(false);
    expect(validateRemoteUrl('https://192.168.1.1/x').ok).toBe(false);
    expect(validateRemoteUrl('https://169.254.169.254/latest').ok).toBe(false);
  });

  it('respeta allowlist', () => {
    expect(validateRemoteUrl('https://evil.com/a', { allowedHosts: ['docs.google.com'] }).ok).toBe(false);
    expect(validateRemoteUrl('https://docs.google.com/a', { allowedHosts: ['docs.google.com'] }).ok).toBe(true);
  });

  it('rechaza IPv6 privadas/reservadas literales', () => {
    expect(validateRemoteUrl('https://[::1]/x').ok).toBe(false);
    expect(validateRemoteUrl('https://[fe80::1]/x').ok).toBe(false);
    expect(validateRemoteUrl('https://[fd00::1]/x').ok).toBe(false);
  });

  it('rechaza IPv4 embebida en IPv6 (bypass vía ::ffff:...) — metadata cloud y loopback', () => {
    // Forma mapeada dotted-quad
    expect(validateRemoteUrl('https://[::ffff:169.254.169.254]/latest').ok).toBe(false);
    expect(validateRemoteUrl('https://[::ffff:127.0.0.1]/x').ok).toBe(false);
    expect(validateRemoteUrl('https://[::ffff:10.0.0.5]/x').ok).toBe(false);
    // Forma compatible deprecated (sin ffff)
    expect(validateRemoteUrl('https://[::127.0.0.1]/x').ok).toBe(false);
    // Forma toda en hex: 169.254.169.254 = a9fe:a9fe
    expect(validateRemoteUrl('https://[::ffff:a9fe:a9fe]/latest').ok).toBe(false);
  });

  it('sigue aceptando IPv6 públicas legítimas', () => {
    // 2001:4860:4860::8888 = DNS público de Google, no debe bloquearse
    expect(validateRemoteUrl('https://[2001:4860:4860::8888]/x').ok).toBe(true);
  });
});
