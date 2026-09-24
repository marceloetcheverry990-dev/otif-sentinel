-- 029: modo explícito por perfil de ruteo.
-- Antes el comportamiento se deducía del nombre (regex en perfil-pesos.js):
-- renombrar "Modo VIP" a "Clientes Premium" lo convertía en Equilibrado sin aviso.
-- Idempotente.

ALTER TABLE perfiles_optimizacion
  ADD COLUMN IF NOT EXISTS modo TEXT;

-- Backfill con la misma regla que usaba el código (perfilKeyFromNombre)
UPDATE perfiles_optimizacion
SET modo = CASE
  WHEN nombre_perfil ~* '(ahorro|bencina|corta)' THEN 'ahorro'
  WHEN nombre_perfil ~* '(vip|monto)' THEN 'vip'
  WHEN nombre_perfil ~* '(salva|multa)' THEN 'salvavidas'
  ELSE 'equilibrado'
END
WHERE modo IS NULL;

ALTER TABLE perfiles_optimizacion
  ALTER COLUMN modo SET DEFAULT 'equilibrado',
  ALTER COLUMN modo SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'perfiles_optimizacion_modo_chk'
  ) THEN
    ALTER TABLE perfiles_optimizacion
      ADD CONSTRAINT perfiles_optimizacion_modo_chk
      CHECK (modo IN ('equilibrado', 'ahorro', 'vip', 'salvavidas'));
  END IF;
END $$;
