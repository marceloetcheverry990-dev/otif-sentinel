/**
 * D4 — disciplina multi-tenant (lint estático + fail-closed).
 *
 * HONESTIDAD: esto NO prueba que cada query filtre por tenant_id.
 * Solo verifica que el guard requireTenantId aparece en handlers sensibles.
 * La protección real de filas requiere Hyperdrive=otif_app + setTenantContext (mig 009).
 */
import { describe, it, expect } from 'vitest';
import { requireTenantId } from '../config.js';

/** Fuentes de handlers sensibles (Vite/Workers: ?raw via glob) */
const HANDLER_SOURCES = import.meta.glob(
  [
    '../api/gps.js',
    '../api/lead-rescue.js',
    '../api/dashboard.js',
    '../api/choferes.js',
    '../api/app-chofer-login.js',
    '../api/app-chofer-rutas.js',
    '../api/app-chofer-sync.js',
    '../api/app-chofer-evento.js',
    '../api/app-chofer-activate.js',
    '../api/sync.js',
    '../api/mobile-sync.js',
    '../api/chat.js',
    '../api/quick-route.js',
    '../api/depots.js',
    '../api/eta-accuracy.js',
    '../api/reoptimizar-midday.js',
    '../api/recalcular-ruteo.js',
  ],
  { query: '?raw', import: 'default', eager: true }
);

describe('requireTenantId (fail-closed)', () => {
  it('rechaza null / vacío / no-string', async () => {
    for (const bad of [null, undefined, '', '   ', 123]) {
      const res = requireTenantId(bad);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/tenant_id/i);
    }
  });

  it('acepta tenant no vacío', () => {
    expect(requireTenantId('empresa_base')).toBeNull();
  });
});

describe('D4 checklist: handlers sensibles usan requireTenantId', () => {
  it('carga los 17 handlers sensibles', () => {
    expect(Object.keys(HANDLER_SOURCES).length).toBe(17);
  });

  for (const [path, src] of Object.entries(HANDLER_SOURCES)) {
    const file = path.split('/').pop();
    it(`${file} importa/usa requireTenantId`, () => {
      expect(typeof src).toBe('string');
      expect(src).toMatch(/requireTenantId/);
    });
  }
});
