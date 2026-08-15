// src/ui/server/appConfig.js
// Magic strings y configuración estática del Worker. No modificar sin revisar
// todos los módulos que lo importan.

export const deepFreeze = obj => {
  Object.keys(obj).forEach(prop => {
    if (typeof obj[prop] === 'object' && obj[prop] !== null) deepFreeze(obj[prop]);
  });
  return Object.freeze(obj);
};

export const APP_CONFIG = deepFreeze({
  BODEGA: { LAT: -33.5132, LNG: -70.7672, NOMBRE: "Bodega Central" },
  ESTADOS: {
    PENDIENTE: 'PENDIENTE_RUTEO',
    ASIGNADO: 'CAMION_ASIGNADO',
    EN_RUTA: 'EN_RUTA',
    ENTREGADO: 'ENTREGADO',
    RECHAZADO: 'RECHAZADO',
    CANCELADO: 'CANCELADO_PLANILLA',
    RETORNO: 'RETORNO_BODEGA'
  },
  UI: {
    COLORS: { EXITO: '#10b981', ALERTA: '#ef4444', NEUTRAL: '#2563eb', WARNING: '#f59e0b' }
  }
});
