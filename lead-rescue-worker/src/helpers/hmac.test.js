// src/helpers/hmac.test.js
// Wave 4 — T5.1: Tests del helper compartido hmac.js
// Tests 19-21 del design.md sección Testing Strategy

import { describe, it, expect } from 'vitest';
import { importHmacKey, base64urlEncode, base64urlDecode, HMAC_ALGO } from './hmac.js';

const VALID_SECRET = 'test-secret-exactly-32-bytes!!!!';

describe('hmac.js', () => {

  // Test 19: Round-trip base64url
  describe('base64url round-trip', () => {
    it('round-trip con buffer de 0 bytes', () => {
      const input = new Uint8Array(0);
      const encoded = base64urlEncode(input.buffer);
      const decoded = base64urlDecode(encoded);
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded.length).toBe(0);
    });

    it('round-trip con buffer de 1 byte', () => {
      const input = new Uint8Array([0xab]);
      const encoded = base64urlEncode(input.buffer);
      const decoded = base64urlDecode(encoded);
      expect(Array.from(decoded)).toEqual([0xab]);
    });

    it('round-trip con buffer de 32 bytes (longitud de clave tipica)', () => {
      const input = new Uint8Array(32).map((_, i) => i);
      const encoded = base64urlEncode(input.buffer);
      const decoded = base64urlDecode(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    });

    it('round-trip con buffer de 64 bytes', () => {
      const input = new Uint8Array(64).map((_, i) => (i * 3) % 256);
      const encoded = base64urlEncode(input.buffer);
      const decoded = base64urlDecode(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    });

    it('el resultado de encode no contiene +, / ni =', () => {
      // Usar un buffer que en base64 estándar produciría esos caracteres
      const input = new Uint8Array([0xfb, 0xff, 0xfe]);
      const encoded = base64urlEncode(input.buffer);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    });
  });

  // Test 20: importHmacKey valida longitud del secreto
  describe('importHmacKey — validación de longitud', () => {
    it('string vacío lanza error con prefijo [hmac]', async () => {
      await expect(importHmacKey('')).rejects.toThrow('[hmac]');
    });

    it('string de 31 bytes lanza error con prefijo [hmac]', async () => {
      const shortSecret = 'a'.repeat(31); // 31 bytes ASCII
      await expect(importHmacKey(shortSecret)).rejects.toThrow('[hmac]');
    });

    it('string de exactamente 32 bytes no lanza error', async () => {
      const key = await importHmacKey(VALID_SECRET);
      expect(key).toBeDefined();
      expect(key.type).toBe('secret');
    });

    it('string de 64 bytes no lanza error', async () => {
      const longSecret = 'b'.repeat(64);
      const key = await importHmacKey(longSecret);
      expect(key).toBeDefined();
    });
  });

  // Test 21: Consistencia cruzada entre módulos
  // Simula que operator-auth.js y driver-auth.js llaman a importHmacKey por separado
  // con la misma clave, y verifican que el resultado es funcionalmente idéntico
  // (firman el mismo mensaje y producen el mismo HMAC)
  describe('consistencia cruzada — importHmacKey produce resultados idénticos en llamadas separadas', () => {
    it('dos llamadas a importHmacKey con el mismo secreto producen HMACs idénticos sobre el mismo mensaje', async () => {
      const mensaje = new TextEncoder().encode('test-message-for-consistency');

      // Simular llamada desde operator-auth.js
      const key1 = await importHmacKey(VALID_SECRET, ['sign']);
      const mac1 = await crypto.subtle.sign(HMAC_ALGO, key1, mensaje);

      // Simular llamada desde driver-auth.js (segunda importación independiente)
      const key2 = await importHmacKey(VALID_SECRET, ['sign']);
      const mac2 = await crypto.subtle.sign(HMAC_ALGO, key2, mensaje);

      // Los dos HMACs deben ser byte a byte idénticos
      expect(Array.from(new Uint8Array(mac1))).toEqual(Array.from(new Uint8Array(mac2)));
    });

    it('verify con key2 acepta firma generada con key1 (mismo secreto, llamadas separadas)', async () => {
      const mensaje = new TextEncoder().encode('cross-module-test');

      const keySign   = await importHmacKey(VALID_SECRET, ['sign']);
      const keyVerify = await importHmacKey(VALID_SECRET, ['verify']);

      const mac = await crypto.subtle.sign(HMAC_ALGO, keySign, mensaje);
      const valid = await crypto.subtle.verify(HMAC_ALGO, keyVerify, mac, mensaje);

      expect(valid).toBe(true);
    });
  });

});
