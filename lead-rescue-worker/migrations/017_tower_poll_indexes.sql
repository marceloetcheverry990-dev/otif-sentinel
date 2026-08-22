-- Hot-path indexes for Torre poll (/api/control-tower-viajes, /api/gps/live)
CREATE INDEX IF NOT EXISTS idx_ordenes_pendientes_tenant_trip
  ON ordenes_pendientes (tenant_id, trip_id)
  WHERE trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flota_vehiculos_live
  ON flota_vehiculos (tenant_id)
  WHERE trip_id_actual IS NOT NULL AND ultima_lat IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eta_accuracy_tenant_chofer_fecha
  ON eta_accuracy_metrics (tenant_id, chofer_id, fecha);
