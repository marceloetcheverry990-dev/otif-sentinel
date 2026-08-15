// src/ui/templates/aiWidget.js
// Widget flotante de IA — aparece si y solo si riesgosSla.length > 0.
// INVARIANTE (Property 4): la condición riesgosSla.length > 0 no se puede alterar.

export const renderAiWidget = (riesgosSla, escapeHTML) => {
  if (!riesgosSla || riesgosSla.length === 0) return '';
  return `
      <div id="ai-copilot-widget" class="collapsed">
        <div class="widget-header" id="ai-widget-toggle">
          <div><span class="pulse-alert"></span> ⚠️ ${riesgosSla.length} Riesgos de SLA</div>
          <span class="toggle-icon">▲</span>
        </div>
        <div class="widget-body">
          <p style="color: var(--text-main); font-weight: 600;">Órdenes superando el tiempo límite de entrega:</p>
          <ul class="ai-list">
            ${riesgosSla.slice(0, 3).map(r => `<li>OT: ${escapeHTML(r.ot_id)} (Viaje: ${escapeHTML(r.trip_id)})</li>`).join('')}
            ${riesgosSla.length > 3 ? `<li style="font-style: italic;">...y ${riesgosSla.length - 3} paradas más</li>` : ''}
          </ul>
          <button id="btn-ai-action" class="ai-btn">🤖 Solicitar Plan de Acción IA</button>
          <div id="ai-result" class="ai-recommendation"></div>
        </div>
      </div>
      `;
};
