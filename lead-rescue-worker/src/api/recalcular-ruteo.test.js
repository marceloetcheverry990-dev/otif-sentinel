import { describe, expect, it } from 'vitest';
import { recalcularRuteo } from './recalcular-ruteo.js';

describe('recalcularRuteo', () => {
  it('403 sin tenant de operador', async () => {
    const res = await recalcularRuteo(
      new Request('https://x/api/recalcular-ruteo', { method: 'POST', body: '{}' }),
      {},
      {},
      null,
    );
    expect(res.status).toBe(403);
  });

  it('400 si flota es 0', async () => {
    const res = await recalcularRuteo(
      new Request('https://x/api/recalcular-ruteo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flota_disponible: 0 }),
      }),
      {},
      {},
      { tenant_id: 't1' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FLOTA_INVALIDA');
  });

  it('400 si faltan trip_ids', async () => {
    const res = await recalcularRuteo(
      new Request('https://x/api/recalcular-ruteo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flota_disponible: 3 }),
      }),
      {},
      {},
      { tenant_id: 't1' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('TRIPS_REQUIRED');
  });
});
