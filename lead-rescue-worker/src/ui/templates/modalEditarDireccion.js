// src/ui/templates/modalEditarDireccion.js
// HTML estático del modal de edición de dirección (paradas SPOT-) — 0 interpolaciones.
// Extraído de src/ui.js (Fase 1, Req 5). No modificar atributos, ids ni clases.

export const MODAL_EDITAR_DIRECCION = `
      <!-- ✏️ MODAL EDITAR DIRECCIÓN (solo Rutas Rápidas SPOT-) -->
      <div id="modalEditarDireccion" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;align-items:center;justify-content:center;padding:20px;" onclick="if(event.target===this)cerrarEditarDireccion()">
        <div style="background:#1e293b;border:1px solid #6366f1;border-radius:16px;padding:28px;width:100%;max-width:500px;box-shadow:0 25px 60px rgba(0,0,0,0.6);" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <h2 style="font-size:1.2rem;font-weight:800;color:#e2e8f0;">&#9998; Editar Direcci&#243;n</h2>
            <button onclick="cerrarEditarDireccion()" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;">&#10005;</button>
          </div>
          <input type="hidden" id="editOtId">
          <div style="margin-bottom:16px;">
            <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;display:block;margin-bottom:6px;">Parada</label>
            <div id="editOtIdDisplay" style="font-size:13px;font-weight:700;color:#818cf8;"></div>
          </div>
          <div style="margin-bottom:16px;">
            <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;display:block;margin-bottom:6px;">Direcci&#243;n Actual</label>
            <div id="editDirActual" style="font-size:13px;color:#94a3b8;padding:8px;background:#0f172a;border-radius:6px;border:1px solid #334155;"></div>
          </div>
          <div style="margin-bottom:20px;">
            <label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;display:block;margin-bottom:6px;">Nueva Direcci&#243;n *</label>
            <input id="editNuevaDireccion" type="text" placeholder="Ej: Av Providencia 1234, Providencia, Santiago" style="width:100%;padding:10px;border:1px solid #334155;border-radius:8px;font-size:14px;background:#0f172a;color:#e2e8f0;box-sizing:border-box;" onkeydown="if(event.key==='Enter')guardarNuevaDireccion()">
            <p style="font-size:11px;color:#64748b;margin-top:6px;">Inclu&#237; la ciudad para mayor precisi&#243;n.</p>
          </div>
          <div id="editResultado" style="min-height:22px;font-size:13px;margin-bottom:16px;"></div>
          <div style="display:flex;gap:12px;justify-content:flex-end;">
            <button onclick="cerrarEditarDireccion()" style="padding:10px 20px;border:1px solid #334155;border-radius:8px;background:#1e293b;cursor:pointer;font-weight:600;color:#94a3b8;">Cancelar</button>
            <button id="btnGuardarDireccion" onclick="guardarNuevaDireccion()" style="padding:10px 24px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;">&#128190; Guardar Direcci&#243;n</button>
          </div>
        </div>
      </div>
`;
