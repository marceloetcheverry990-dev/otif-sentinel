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
});
