-- migrations/015_res154_audit_fixes.sql
-- Auditoría Res.154: device ts audit, stub seguro, DTE por tenant.

BEGIN;

-- S1: hora de recepción del servidor vs hora del device (created_at)
ALTER TABLE bitacora_viajes
  ADD COLUMN IF NOT EXISTS server_received_at TIMESTAMPTZ;

-- S0: identidad tributaria del emisor por tenant
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS dte_rut_emisor VARCHAR(32),
  ADD COLUMN IF NOT EXISTS dte_razon_social VARCHAR(255),
  ADD COLUMN IF NOT EXISTS dte_ambiente VARCHAR(32),
  ADD COLUMN IF NOT EXISTS dte_provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS dte_api_token TEXT;

-- S4: estado STUB (sin folio sintético que bloquee reemisión)
ALTER TABLE guias_despacho DROP CONSTRAINT IF EXISTS guias_despacho_estado_chk;
ALTER TABLE guias_despacho
  ADD CONSTRAINT guias_despacho_estado_chk
  CHECK (estado IN ('PENDING', 'EMITTING', 'EMITIDA', 'ERROR', 'SKIPPED', 'STUB'));

-- Filas envenenadas por stub anterior: liberar para reemisión real
UPDATE guias_despacho
   SET estado = 'STUB',
       folio = NULL,
       track_id = NULL,
       error = COALESCE(error, 'Migrado desde stub con folio sintético'),
       updated_at = NOW()
 WHERE estado = 'SKIPPED'
   AND folio LIKE 'STUB-%';

COMMIT;
