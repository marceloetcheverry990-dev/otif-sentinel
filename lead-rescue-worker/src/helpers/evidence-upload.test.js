import { describe, expect, it } from 'vitest';
import {
  decodeBase64Image,
  detectImageMagic,
  isTrustedEvidenceUrl,
} from './evidence-upload.js';

describe('evidence-upload', () => {
  it('detecta JPEG por magic bytes', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(detectImageMagic(jpeg)).toEqual({ ok: true, mime: 'image/jpeg', ext: 'jpg' });
  });

  it('rechaza bytes sin magic de imagen', () => {
    const junk = new Uint8Array(20).fill(1);
    expect(detectImageMagic(junk).ok).toBe(false);
  });

  it('decodeBase64Image valida JPEG mínimo', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = btoa(binary);
    const r = decodeBase64Image(b64);
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('image/jpeg');
  });

  it('isTrustedEvidenceUrl solo acepta storage del tenant', () => {
    const env = { SUPABASE_URL: 'https://abc.supabase.co' };
    expect(
      isTrustedEvidenceUrl(
        'https://abc.supabase.co/storage/v1/object/public/evidencias/empresa_base/x.jpg',
        env,
        'empresa_base'
      )
    ).toBe(true);
    expect(
      isTrustedEvidenceUrl(
        'https://abc.supabase.co/storage/v1/object/public/evidencias/otro/x.jpg',
        env,
        'empresa_base'
      )
    ).toBe(false);
    expect(isTrustedEvidenceUrl('https://evil.com/x.jpg', env, 'empresa_base')).toBe(false);
  });
});
