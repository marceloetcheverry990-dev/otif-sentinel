// src/ui.test.js
// Snapshot tests para renderControlTowerDashboard — Fase 0 (BLOQUEANTE)
// Fija el output HTML de referencia como contrato de corrección del refactor.
//
// Para correr: npx vitest run --config vitest.config.ui.js src/ui.test.js
// (usa vitest.config.ui.js con environment: 'node' — ui.js es función pura sin CF APIs)

import { describe, it, expect } from 'vitest';
import { renderControlTowerDashboard } from './ui.js';

// ---------------------------------------------------------------------------
// Implementación mínima de escapeHTML para los tests
// ---------------------------------------------------------------------------
const escapeHTML = (text) =>
  String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// FIXTURE — datos representativos con todos los casos requeridos
// ---------------------------------------------------------------------------

// Fechas de referencia para SLA
const ahora = new Date('2025-07-01T15:00:00.000Z');
const slaFuturo = new Date('2025-07-01T18:00:00.000Z').toISOString();  // no vencido
const slaPasado = new Date('2025-07-01T13:00:00.000Z').toISOString();  // vencido
const etaAtrasada = new Date('2025-07-01T16:00:00.000Z').toISOString(); // eta > slaPasado → riesgo
const etaOk = new Date('2025-07-01T14:00:00.000Z').toISOString();      // eta < slaFuturo → sin riesgo

// ─── Caso A: viaje con riesgosSla > 0 ──────────────────────────────────────
// Una parada donde eta > fecha_hora_sla y estado != ENTREGADO → activa widget IA
const viajeConRiesgo = {
  trip_id: 'VIAJE-001',
  chofer: 'Juan Pérez',
  chofer_id: 'CHF-01',
  detalle_paradas: [
    {
      ot_id: 'OT-1001',
      cliente: 'Empresa Alpha',
      monto_total: 500000,
      estado_operacional: 'EN_RUTA',
      eta: etaAtrasada,         // eta > slaPasado → es tarde
      fecha_hora_sla: slaPasado,
      hora_real: null,
      metadata: null,
    },
    {
      ot_id: 'OT-1002',
      cliente: 'Empresa Beta',
      monto_total: 300000,
      estado_operacional: 'CAMION_ASIGNADO',
      eta: etaOk,
      fecha_hora_sla: slaFuturo,
      hora_real: null,
      metadata: null,
    },
  ],
};

// ─── Caso B: viaje sin riesgosSla ─────────────────────────────────────────
// Ninguna parada tiene eta > fecha_hora_sla → no genera riesgo SLA
const viajeSinRiesgo = {
  trip_id: 'VIAJE-002',
  chofer: 'María González',
  chofer_id: 'CHF-02',
  detalle_paradas: [
    {
      ot_id: 'OT-2001',
      cliente: 'Empresa Gamma',
      monto_total: 200000,
      estado_operacional: 'EN_RUTA',
      eta: etaOk,               // eta < slaFuturo → sin riesgo
      fecha_hora_sla: slaFuturo,
      hora_real: null,
      metadata: null,
    },
    {
      ot_id: 'OT-2002',
      cliente: 'Empresa Delta',
      monto_total: 150000,
      estado_operacional: 'ENTREGADO', // ya entregado — aunque eta fuera tardía, no cuenta
      eta: etaAtrasada,
      fecha_hora_sla: slaPasado,
      hora_real: new Date('2025-07-01T12:30:00.000Z').toISOString(),
      metadata: null,
    },
  ],
};

// ─── Caso C: viaje con TODAS las paradas en estado terminal ───────────────
// Debe ser auto-ocultado del panel flota (todasTerminales = true)
const viajeTotalmenteTerminal = {
  trip_id: 'VIAJE-003',
  chofer: 'Pedro Soto',
  chofer_id: 'CHF-03',
  detalle_paradas: [
    {
      ot_id: 'OT-3001',
      cliente: 'Empresa Epsilon',
      monto_total: 100000,
      estado_operacional: 'ENTREGADO',
      eta: etaOk,
      fecha_hora_sla: slaFuturo,
      hora_real: new Date('2025-07-01T10:00:00.000Z').toISOString(),
      metadata: null,
    },
    {
      ot_id: 'OT-3002',
      cliente: 'Empresa Zeta',
      monto_total: 75000,
      estado_operacional: 'RECHAZADO',
      eta: etaOk,
      fecha_hora_sla: slaFuturo,
      hora_real: new Date('2025-07-01T11:00:00.000Z').toISOString(),
      metadata: null,
    },
  ],
};

// ─── Caso D: strings con backtick (`) y ${ en cliente y ot_id ────────────
// Ejercita la sanitización safeVal/escapeHTML para template literals
const viajeConCaracteresEspeciales = {
  trip_id: 'VIAJE-004',
  chofer: 'Ana `Backtick` Ruiz',
  chofer_id: 'CHF-04',
  detalle_paradas: [
    {
      ot_id: 'OT-`${xss}`',
      cliente: 'Empresa `${alert(1)}` Corp',
      monto_total: 250000,
      estado_operacional: 'EN_RUTA',
      eta: etaOk,
      fecha_hora_sla: slaFuturo,
      hora_real: null,
      metadata: null,
    },
  ],
};

// ─── Órdenes pendientes ────────────────────────────────────────────────────
const ordenes = [
  {
    ot_id: 'OT-PEND-001',
    cliente: 'Cliente Pendiente A',
    tenant_id: 'empresa_demo',
    trip_id: '',                          // sin viaje asignado
    estado_operacional: 'PENDIENTE_RUTEO',
    monto_total: 180000,
    direccion: 'Av. Las Condes 1234, Santiago',
    lat: -33.41,
    lng: -70.55,
  },
  {
    ot_id: 'OT-PEND-002',
    cliente: 'Cliente Pendiente B',
    tenant_id: 'empresa_demo',
    trip_id: null,
    estado_operacional: 'PENDIENTE_RUTEO',
    monto_total: 95000,
    direccion: 'Calle Tocopilla 567, Providencia, Santiago',
    lat: -33.43,
    lng: -70.61,
  },
];

// ─── Perfiles de ruteo ────────────────────────────────────────────────────
const perfiles = [
  { perfil_id: 'perfil-01', nombre_perfil: 'Estándar', is_default: true },
  { perfil_id: 'perfil-02', nombre_perfil: 'Express', is_default: false },
];

// ─── Lista de choferes ────────────────────────────────────────────────────
// Con al menos 1 chofer con chofer_id, nombre_completo, gps_interval_seconds
const listaChoferes = [
  {
    chofer_id: 'CHF-01',
    nombre_completo: 'Juan Pérez Morales',
    gps_interval_seconds: 10,
    telefono: '+56912345678',
    activo: true,
  },
  {
    chofer_id: 'CHF-02',
    nombre_completo: 'María González López',
    gps_interval_seconds: 30,
    telefono: '+56987654321',
    activo: true,
  },
];

// ---------------------------------------------------------------------------
// Fixture completo (todos los viajes — incluyendo casos A, B, C, D)
// ---------------------------------------------------------------------------
const viajesActivos = [
  viajeConRiesgo,       // Caso A — riesgosSla > 0 → widget IA visible
  viajeSinRiesgo,       // Caso B — sin riesgo (parada atrasada pero ENTREGADA)
  viajeTotalmenteTerminal, // Caso C — auto-ocultar del panel
  viajeConCaracteresEspeciales, // Caso D — sanitización
];

// ---------------------------------------------------------------------------
// Argumentos para los dos casos de snapshot
// ---------------------------------------------------------------------------

// inputConRiesgos: incluye el viaje con riesgo SLA → widget IA aparece
const inputConRiesgos = [
  ordenes,
  perfiles,
  null,          // moneyFormatterUser: null → fallback interno a CLP
  escapeHTML,
  '2025-07-01T14:00:00.000Z',  // lastSyncDate como string
  viajesActivos,
  listaChoferes,
];

// inputSinRiesgos: solo viajes sin riesgo SLA activo → widget IA ausente
const viajesSoloSinRiesgo = [
  viajeSinRiesgo,          // Caso B
  viajeTotalmenteTerminal, // Caso C — terminal, auto-oculto
];

const inputSinRiesgos = [
  ordenes,
  perfiles,
  null,
  escapeHTML,
  null,                    // lastSyncDate como null
  viajesSoloSinRiesgo,
  listaChoferes,
];

// ---------------------------------------------------------------------------
// Tests snapshot
// ---------------------------------------------------------------------------
describe('renderControlTowerDashboard — Snapshot Fase 0', () => {
  it('snapshot — output byte-idéntico con riesgos SLA activos', () => {
    expect(renderControlTowerDashboard(...inputConRiesgos)).toMatchSnapshot();
  });

  it('snapshot — output byte-idéntico sin riesgos SLA (widget IA ausente)', () => {
    expect(renderControlTowerDashboard(...inputSinRiesgos)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Tests de humo (verificaciones básicas sin snapshot)
// ---------------------------------------------------------------------------
describe('renderControlTowerDashboard — Tests de humo', () => {
  it('retorna un string HTML que comienza con <!DOCTYPE html>', () => {
    const html = renderControlTowerDashboard(...inputConRiesgos);
    expect(typeof html).toBe('string');
    expect(html.trim()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('widget IA aparece cuando hay riesgos SLA activos', () => {
    const html = renderControlTowerDashboard(...inputConRiesgos);
    expect(html).toContain('id="ai-copilot-widget"');
  });

  it('widget IA NO aparece cuando no hay riesgos SLA', () => {
    const html = renderControlTowerDashboard(...inputSinRiesgos);
    expect(html).not.toContain('id="ai-copilot-widget"');
  });

  it('config-json contiene JSON válido con claves BODEGA, ESTADOS, UI', () => {
    const html = renderControlTowerDashboard(...inputConRiesgos);
    const match = html.match(/<script id="config-json"[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const obj = JSON.parse(match[1]);
    expect(obj).toHaveProperty('BODEGA');
    expect(obj).toHaveProperty('ESTADOS');
    expect(obj).toHaveProperty('UI');
    // Fase 2: tenant_id y last_sync_date deben estar presentes
    expect(obj).toHaveProperty('tenant_id');
    expect(obj).toHaveProperty('last_sync_date');
  });

  it('los backticks y ${ del Caso D están escapados en atributos HTML y data-attributes', () => {
    const html = renderControlTowerDashboard(...inputConRiesgos);

    // safeVal escapa ` → &#96; y ${ → &#36;{
    // Los valores del Caso D deben aparecer en atributos HTML escapados, nunca crudos.
    // En atributos como data-search y data-trip, el escapeHTML (con override safeVal) se aplica.
    // Nota: en los bloques <script type="application/json"> (safeOrdenesJson, safeViajesJson)
    // los backticks aparecen como caracteres JSON normales dentro de strings — eso es seguro
    // porque el parser JSON los trata como texto, no como delimitadores de template literal.

    // Verificamos que en los atributos HTML el backtick del cliente fue escapado:
    // El campo _search_str incluye ot_id + cliente, y se pone en data-search con escapeHTML.
    // escapeHTML sobreescrito también aplica safeVal (backtick → &#96;)
    expect(html).toContain('&#96;'); // el backtick fue escapado en algún atributo HTML
  });

  it('acepta lastSyncDate como null sin lanzar excepción', () => {
    expect(() => renderControlTowerDashboard(...inputSinRiesgos)).not.toThrow();
  });

  it('la función es determinista — mismo input produce mismo output', () => {
    const html1 = renderControlTowerDashboard(...inputConRiesgos);
    const html2 = renderControlTowerDashboard(...inputConRiesgos);
    expect(html1).toBe(html2);
  });

  it('mantiene todos los módulos cliente dentro del script principal', () => {
    const html = renderControlTowerDashboard(...inputConRiesgos);
    for (const marker of [
      'const appState = new Proxy',
      'window.guardarNuevaDireccion',
      'LIVE REFRESH VIAJES',
      "credentials: 'same-origin'",
    ]) {
      const markerIndex = html.indexOf(marker);
      const scriptOpen = html.lastIndexOf('<script>', markerIndex);
      const firstScriptClose = html.indexOf('</script>', scriptOpen);

      expect(markerIndex).toBeGreaterThan(scriptOpen);
      expect(firstScriptClose).toBeGreaterThan(markerIndex);
    }
  });

  it('choferes-json escapa </script> para no romper el HTML', () => {
    const html = renderControlTowerDashboard(
      [],
      [],
      null,
      escapeHTML,
      null,
      [],
      [{
        chofer_id: 'CHF-X',
        nombre_completo: 'Evil</script><script>alert(1)</script>',
        skill_score: 1,
        rut: '1-9',
      }],
    );
    const match = html.match(/<script id="choferes-json"[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(match[1]).not.toContain('</script>');
    expect(match[1]).toContain('\\u003c');
    const parsed = JSON.parse(match[1]);
    expect(parsed[0].nombre_completo).toContain('</script>');
  });
});
