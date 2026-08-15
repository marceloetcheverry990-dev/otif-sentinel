// src/helpers/driver-auth.test.js
// Wave 2 — T2: Smoke tests del helper criptográfico
// Deben pasar antes de que se toque ningún endpoint (Wave 3).
//
// Este archivo también recibirá los tests de T9 (bug condition exploratorio)
// y T10 (fix checking + preservation) en sus respectivas waves.
//
// El pool @cloudflare/vitest-pool-workers expone crypto.subtle nativamente
// (mismo runtime que el Worker). No se necesita mock de crypto.

import { describe, it, expect } from 'vitest';
import { signDriverToken, verifyDriverToken } from './driver-auth.js';

// ─── Fixture compartido ───────────────────────────────────────────────────────

const TEST_ENV = { JWT_SECRET: 'test-secret-32-bytes-minimum-len!!' };

const TEST_PAYLOAD = {
  chofer_id: 'chofer-001',
  rut: '12345678-9',
  tenant_id: 'empresa_demo',
};

// Helper: construir un Request con Bearer token
function makeRequest(token) {
  return new Request('https://worker.test/api/app-chofer-rutas', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── T2: Smoke tests del helper ───────────────────────────────────────────────

describe('driver-auth - smoke tests (Wave 2 gate)', () => {
  it('signDriverToken genera un token con exactamente 3 partes separadas por punto', async () => {
    const token = await signDriverToken(TEST_PAYLOAD, TEST_ENV);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    // Cada parte debe ser una string base64url no vacía
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      // base64url no debe contener +, / ni =
      expect(part).not.toMatch(/[+/=]/);
    }
  });

  it('verifyDriverToken valida correctamente un token firmado con el mismo secreto', async () => {
    const token = await signDriverToken(TEST_PAYLOAD, TEST_ENV);
    const request = makeRequest(token);
    const result = await verifyDriverToken(request, TEST_ENV);

    expect(result.ok).toBe(true);
    expect(result.payload.chofer_id).toBe(TEST_PAYLOAD.chofer_id);
    expect(result.payload.rut).toBe(TEST_PAYLOAD.rut);
    expect(result.payload.tenant_id).toBe(TEST_PAYLOAD.tenant_id);
    // exp debe estar en el futuro (~10h desde ahora)
    expect(result.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('verifyDriverToken rechaza un token firmado con un secreto distinto', async () => {
    const token = await signDriverToken(TEST_PAYLOAD, TEST_ENV);
    const request = makeRequest(token);

    // Verificar con secreto diferente — debe fallar
    const wrongEnv = { JWT_SECRET: 'otro-secreto-completamente-diferente!!' };
    const result = await verifyDriverToken(request, wrongEnv);

    expect(result.ok).toBe(false);
    const body = await result.response.json();
    expect(result.response.status).toBe(401);
    expect(body.code).toBe('token_invalido');
  });
});

// ─── Validación de secreto ausente / débil ────────────────────────────────────

describe('driver-auth - validacion de secreto', () => {
  it('signDriverToken lanza error si JWT_SECRET es undefined', async () => {
    await expect(
      signDriverToken(TEST_PAYLOAD, { JWT_SECRET: undefined })
    ).rejects.toThrow('[driver-auth] JWT_SECRET no está configurado');
  });

  it('signDriverToken lanza error si JWT_SECRET tiene menos de 32 bytes', async () => {
    await expect(
      signDriverToken(TEST_PAYLOAD, { JWT_SECRET: 'corto' })
    ).rejects.toThrow('demasiado corto');
  });

  it('verifyDriverToken lanza error si JWT_SECRET es undefined', async () => {
    const token = await signDriverToken(TEST_PAYLOAD, TEST_ENV);
    const request = makeRequest(token);
    await expect(
      verifyDriverToken(request, { JWT_SECRET: undefined })
    ).rejects.toThrow('[driver-auth] JWT_SECRET no está configurado');
  });
});

// ─── Bug: token sin campo exp ─────────────────────────────────────────────────
// Un token firmado válidamente pero sin campo exp en el payload pasaba antes
// porque `undefined < número` evalúa false en JS — el token nunca expiraba.
// Requiere construir el token manualmente sin pasar exp a signDriverToken.

describe('driver-auth - token sin exp', () => {
  it('verifyDriverToken rechaza un token validamente firmado pero sin campo exp', async () => {
    // Construir token manualmente: mismo algoritmo que signDriverToken,
    // pero el payload no incluye exp — simula un token malformado o externo.
    const enc = new TextEncoder();
    const algorithm = { name: 'HMAC', hash: 'SHA-256' };

    function b64url(buf) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    const headerB64 = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    // Payload sin exp
    const bodyB64 = b64url(enc.encode(JSON.stringify({ chofer_id: 'x', rut: '1-1', tenant_id: 'demo' })));
    const signingInput = `${headerB64}.${bodyB64}`;

    const key = await crypto.subtle.importKey(
      'raw', enc.encode(TEST_ENV.JWT_SECRET), algorithm, false, ['sign']
    );
    const sig = await crypto.subtle.sign(algorithm, key, enc.encode(signingInput));
    const token = `${signingInput}.${b64url(sig)}`;

    const request = makeRequest(token);
    const result = await verifyDriverToken(request, TEST_ENV);

    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    // Debe ser token_invalido, no token_expirado — un token sin exp es inválido por construcción
    expect(body.code).toBe('token_invalido');
  });
});
