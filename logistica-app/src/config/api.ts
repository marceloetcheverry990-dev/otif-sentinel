/**
 * URL base del Worker.
 * - Nativo (Android/iOS): usa EXPO_PUBLIC_API_URL o el Worker de producción directo.
 * - Web: usa la misma origen (window.location.origin) para que el proxy local
 *   reenvíe /api/* al Worker sin problemas de CORS.
 */
import { Platform } from 'react-native';

const FALLBACK =
  'https://lead-rescue-pipeline.marceloetcheverry990.workers.dev';

export const API_BASE_URL = (() => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return (
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_API_URL) ||
    FALLBACK
  );
})().replace(/\/$/, '');
