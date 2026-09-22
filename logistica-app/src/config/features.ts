/**
 * Feature flags de producto (piloto vs producción).
 * El código de QR/scan sigue en ScanOtModal; solo se desconecta del flujo ENTREGA.
 *
 * Para reactivar escaneo: EXPO_PUBLIC_POD_SCAN_ENABLED=true (y POD_SCAN_ENABLED=true en Worker).
 */
function envFlag(name: string, defaultValue = false): boolean {
  const raw =
    (typeof process !== 'undefined' && process.env?.[name]) ||
    (typeof process !== 'undefined' && (process.env as Record<string, string | undefined>)?.[`EXPO_PUBLIC_${name}`]);
  if (raw == null || raw === '') return defaultValue;
  const v = String(raw).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Piloto: false → entrega con foto/firma sin abrir escáner QR. */
export const POD_SCAN_ENABLED = envFlag('POD_SCAN_ENABLED', false);
