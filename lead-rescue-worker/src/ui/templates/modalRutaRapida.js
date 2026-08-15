// src/ui/templates/modalRutaRapida.js
// HTML estático del modal de Ruta Rápida — 0 interpolaciones de servidor.
// Extraído de src/ui.js (Fase 1, Req 5). No modificar atributos, ids ni clases.

export const MODAL_RUTA_RAPIDA = `
      <!-- ⚡ MODAL RUTA RÁPIDA -->
      <div id="modalRutaRapida" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;align-items:center;justify-content:center;padding:20px;">
        <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;width:100%;max-width:720px;max-height:90vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,0.5);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <h2 style="font-size:1.4rem;font-weight:800;color:#e2e8f0;">⚡ Nueva Ruta Rápida</h2>
            <button onclick="cerrarRutaRapida()" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;">✕</button>
          </div>

          <div style="background:rgba(245,158,11,0.1);border:1px solid #f59e0b;border-radius:8px;padding:12px;margin-bottom:20px;font-size:13px;color:#fbbf24;">
            💡 <strong>Ruta espontánea:</strong> elegí una sugerencia con <strong>✓ N° exacto</strong> (punto de casa para el chofer). Solo calle no alcanza para navegar a la puerta. Luego <strong>Validar</strong> y <strong>Despachar</strong>. Hasta 24 paradas.
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
            <div>
              <label style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;display:block;margin-bottom:6px;">Chofer *</label>
              <select id="rrChofer" style="width:100%;padding:10px;border:1px solid #334155;border-radius:8px;font-size:14px;background:#0f172a;color:#e2e8f0;">
                <option value="">-- Seleccionar chofer --</option>
              </select>
            </div>
            <div>
              <label style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;display:block;margin-bottom:6px;">Descripción de la Carga</label>
              <input id="rrDescCarga" type="text" placeholder="Ej: 6 libros de muestra editorial" style="width:100%;padding:10px;border:1px solid #334155;border-radius:8px;font-size:14px;background:#0f172a;color:#e2e8f0;box-sizing:border-box;">
            </div>
          </div>

          <div style="margin-bottom:20px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px;background:rgba(16,185,129,0.1);border:1px solid #065f46;border-radius:8px;">
              <input type="checkbox" id="rrCamionListo" style="width:18px;height:18px;accent-color:#10b981;">
              <span style="font-size:14px;font-weight:600;color:#34d399;">✅ Camión ya cargado — salir inmediatamente</span>
            </label>
            <p style="font-size:12px;color:#64748b;margin-top:6px;padding-left:4px;">Sin marcar: la ruta queda en estado "Pendiente de carga" hasta que bodega confirme.</p>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <label style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;">Paradas</label>
            <button onclick="agregarParadaRR()" style="background:#2563eb;color:white;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">+ Agregar parada</button>
          </div>

          <div id="rrParadas"></div>

          <!-- Panel de resultados de validación — visible solo después de validar -->
          <div id="rrValidacionPanel" style="display:none;margin-top:16px;padding:12px;background:rgba(15,23,42,0.6);border-radius:8px;border:1px solid #334155;">
            <div id="rrValidacionResumen" style="font-size:13px;font-weight:700;margin-bottom:8px;"></div>
            <div id="rrKpisPanel" style="display:none;font-size:12px;color:#94a3b8;"></div>
          </div>

          <div style="display:flex;gap:12px;margin-top:24px;justify-content:flex-end;flex-wrap:wrap;">
            <a href="/api/quick-route/export" download style="padding:10px 16px;border:1px solid #334155;border-radius:8px;background:#1e293b;cursor:pointer;font-weight:600;color:#94a3b8;text-decoration:none;font-size:14px;">📥 Exportar CSV</a>
            <button onclick="cerrarRutaRapida()" style="padding:10px 20px;border:1px solid #334155;border-radius:8px;background:#1e293b;cursor:pointer;font-weight:600;color:#94a3b8;">Cancelar</button>
            <button id="btnValidarRR" onclick="validarDireccionesRR()" style="padding:10px 24px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:15px;">🔍 Validar Direcciones</button>
            <button id="btnEnviarRR" onclick="enviarRutaRapida()" disabled style="padding:10px 24px;background:#334155;color:#64748b;border:none;border-radius:8px;cursor:not-allowed;font-weight:700;font-size:15px;opacity:0.5;">⚡ Crear y Despachar</button>
          </div>
        </div>
      </div>
`;
