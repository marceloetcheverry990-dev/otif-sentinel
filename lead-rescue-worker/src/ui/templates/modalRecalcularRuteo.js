// src/ui/templates/modalRecalcularRuteo.js
// HTML estático: elegir qué viajes sin salir se recalculan. 0 interpolaciones de servidor.

export const MODAL_RECALCULAR_RUTEO = `
      <div id="modalRecalcularRuteo" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;align-items:center;justify-content:center;padding:20px;" onclick="if(event.target===this)cerrarModalRecalcularRuteo()">
        <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,0.5);" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 style="font-size:1.15rem;font-weight:800;color:#e2e8f0;margin:0;">Recalcular rutas</h2>
            <button type="button" onclick="cerrarModalRecalcularRuteo()" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;">✕</button>
          </div>
          <p id="recalcResumenValores" style="font-size:12px;color:#94a3b8;margin:0 0 12px 0;"></p>
          <p style="font-size:13px;color:#cbd5e1;margin:0 0 10px 0;">Elegí qué viajes recalcular. Solo aparecen los que <strong>todavía no salieron</strong>. El perfil, el clima y el <strong>N° de camiones</strong> del header se aplican a esas rutas (parte o junta). Un chofer de un viaje no marcado no se usa.</p>
          <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <button type="button" onclick="marcarTodosRecalcTrips(true)" style="padding:5px 10px;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#94a3b8;cursor:pointer;font-size:12px;">Todas</button>
            <button type="button" onclick="marcarTodosRecalcTrips(false)" style="padding:5px 10px;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#94a3b8;cursor:pointer;font-size:12px;">Ninguna</button>
          </div>
          <p id="recalcTripsVacio" hidden style="font-size:13px;color:#fbbf24;margin:8px 0;">No hay rutas sin salir para recalcular.</p>
          <div id="listaRecalcTrips" class="recalc-trip-list"></div>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:12px;margin-top:14px;background:rgba(15,23,42,0.6);border:1px solid #334155;border-radius:8px;">
            <input type="checkbox" id="recalcIncluirBacklog" style="width:16px;height:16px;margin-top:2px;accent-color:#3b82f6;">
            <span>
              <span style="font-size:13px;font-weight:600;color:#e2e8f0;display:block;">Incluir pedidos pendientes (backlog)</span>
              <span id="recalcBacklogCount" style="font-size:12px;color:#64748b;">No se mezclan salvo que lo marques.</span>
            </span>
          </label>
          <div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end;">
            <button type="button" onclick="cerrarModalRecalcularRuteo()" style="padding:10px 20px;border:1px solid #334155;border-radius:8px;background:#1e293b;cursor:pointer;font-weight:600;color:#94a3b8;">Cancelar</button>
            <button type="button" id="btnConfirmarRecalcular" onclick="confirmarRecalcularRuteo()" style="padding:10px 22px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;">Recalcular elegidas</button>
          </div>
        </div>
      </div>
`;
