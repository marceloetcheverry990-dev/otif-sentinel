/**
 * Multi-bodega: catálogo depots + fallback a Bodega Central Maipú.
 */

import { withDb } from '../db.js';
import { DEFAULT_DEPOT } from './vrp-solver.js';

export const FALLBACK_DEPOT = Object.freeze({
  depot_id: 'bodega-central',
  nombre: 'Bodega Central',
  lat: DEFAULT_DEPOT.lat,
  lng: DEFAULT_DEPOT.lng,
  is_default: true,
  activo: true,
});

export async function ensureDepotsSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS depots (
      depot_id    VARCHAR(64)  PRIMARY KEY,
      tenant_id   VARCHAR(64)  NOT NULL,
      nombre      VARCHAR(128) NOT NULL,
      lat         DOUBLE PRECISION NOT NULL,
      lng         DOUBLE PRECISION NOT NULL,
      is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
      activo      BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  // Res. 154: origen postal del traslado
  await client.query(`
    ALTER TABLE depots
      ADD COLUMN IF NOT EXISTS direccion TEXT,
      ADD COLUMN IF NOT EXISTS comuna VARCHAR(64)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_depots_tenant_activo
      ON depots (tenant_id, activo)
  `);
  try {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_depots_one_default_per_tenant
        ON depots (tenant_id)
        WHERE is_default AND activo
    `);
  } catch (_) {
    /* índice parcial puede fallar en engines viejos — no bloquear */
  }
}

/** Si el tenant no tiene bodegas, siembra la central. */
export async function ensureDefaultDepot(client, tenantId) {
  await ensureDepotsSchema(client);
  const tid = String(tenantId || '').trim();
  if (!tid) return FALLBACK_DEPOT;

  const existing = await client.query(
    `SELECT depot_id FROM depots WHERE tenant_id = $1 AND activo = TRUE LIMIT 1`,
    [tid]
  );
  if (existing.rowCount > 0) return null;

  const depotId = `${tid}-bodega-central`.slice(0, 64);
  await client.query(
    `INSERT INTO depots (depot_id, tenant_id, nombre, lat, lng, is_default, activo)
     VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
     ON CONFLICT (depot_id) DO NOTHING`,
    [depotId, tid, FALLBACK_DEPOT.nombre, FALLBACK_DEPOT.lat, FALLBACK_DEPOT.lng]
  );
  return { ...FALLBACK_DEPOT, depot_id: depotId, tenant_id: tid };
}

export function normalizeDepotRow(row) {
  if (!row) return { ...FALLBACK_DEPOT };
  return {
    depot_id: row.depot_id,
    nombre: row.nombre || FALLBACK_DEPOT.nombre,
    lat: Number(row.lat),
    lng: Number(row.lng),
    is_default: !!row.is_default,
    activo: row.activo !== false,
    tenant_id: row.tenant_id || null,
    direccion: row.direccion || null,
    comuna: row.comuna || null,
  };
}

export async function listDepots(env, tenantId) {
  try {
    return await withDb(env, async (client) => {
      await ensureDefaultDepot(client, tenantId);
      const res = await client.query(
        `SELECT depot_id, tenant_id, nombre, lat, lng, is_default, activo, direccion, comuna
         FROM depots
         WHERE tenant_id = $1 AND activo = TRUE
         ORDER BY is_default DESC, nombre ASC`,
        [tenantId]
      );
      return (res.rows || []).map(normalizeDepotRow);
    });
  } catch (e) {
    console.warn('[DEPOTS] list fallback:', e.message);
    return [{ ...FALLBACK_DEPOT, tenant_id: tenantId }];
  }
}

/**
 * Resuelve depot por id o el default del tenant.
 * @returns {{ depot_id, nombre, lat, lng, is_default }}
 */
export async function resolveDepot(env, tenantId, depotId = null) {
  try {
    return await withDb(env, async (client) => {
      await ensureDefaultDepot(client, tenantId);
      if (depotId) {
        const res = await client.query(
          `SELECT depot_id, tenant_id, nombre, lat, lng, is_default, activo, direccion, comuna
           FROM depots
           WHERE tenant_id = $1 AND depot_id = $2 AND activo = TRUE
           LIMIT 1`,
          [tenantId, depotId]
        );
        if (res.rowCount) return normalizeDepotRow(res.rows[0]);
      }
      const def = await client.query(
        `SELECT depot_id, tenant_id, nombre, lat, lng, is_default, activo, direccion, comuna
         FROM depots
         WHERE tenant_id = $1 AND activo = TRUE
         ORDER BY is_default DESC, nombre ASC
         LIMIT 1`,
        [tenantId]
      );
      if (def.rowCount) return normalizeDepotRow(def.rows[0]);
      return { ...FALLBACK_DEPOT, tenant_id: tenantId };
    });
  } catch (e) {
    console.warn('[DEPOTS] resolve fallback:', e.message);
    return { ...FALLBACK_DEPOT, tenant_id: tenantId };
  }
}

/** Forma esperada por el mapa Torre: CONFIG.BODEGA */
export function depotToAppConfig(depot) {
  const d = depot || FALLBACK_DEPOT;
  return {
    LAT: Number(d.lat),
    LNG: Number(d.lng),
    NOMBRE: d.nombre || 'Bodega',
    depot_id: d.depot_id || null,
  };
}

export function depotToSolver(depot) {
  const d = depot || FALLBACK_DEPOT;
  const lat = Number(d.lat ?? d.LAT);
  const lng = Number(d.lng ?? d.LNG);
  return {
    lat: Number.isFinite(lat) ? lat : FALLBACK_DEPOT.lat,
    lng: Number.isFinite(lng) ? lng : FALLBACK_DEPOT.lng,
  };
}
