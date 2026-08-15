/**
 * URL base del Worker. En builds de producción definir EXPO_PUBLIC_API_URL.
 * Fallback solo para desarrollo local / compatibilidad.
 */
const FALLBACK =
  'https://lead-rescue-pipeline.marceloetcheverry990.workers.dev';

export const API_BASE_URL = (
  (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_API_URL) ||
  FALLBACK
).replace(/\/$/, '');
