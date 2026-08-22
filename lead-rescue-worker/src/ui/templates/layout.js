// src/ui/templates/layout.js
// HTML dinámico del body: header, sidebar, KPIs, tabs, panel flota, panel backlog, mapa.
// Recibe todos los datos ya calculados por calculosViaje.js.

import { APP_CONFIG } from '../server/appConfig.js';
import { makeSafeTripId, safeHttpUrl, countViajesFlotaVisibles, isViajeTerminalCompleto } from '../../utils.js';

export const renderLayout = ({
  money,
  escapeHTML,
  safeParseJSON,
  viajesSeguros,
  ordenesPendientes,
  perfilesSeguros,
  depotsSeguros = [],
  listaChoferes,
  totalDineroEnCalle,
  totalDineroRiesgo,
  otifProyectado,
  safeOrdenesJson,
  safeViajesJson,
  safeConfigJson,
  rawChoferesJson,
  aiWidgetHtml,
  operatorSession = null,
}) => {
  const flotaVisibleCount = countViajesFlotaVisibles(viajesSeguros);
  return `
    <body>

      <div id="leadRescueBanner" class="lead-rescue-banner" hidden></div>
      <div id="towerBusy" class="tower-busy-banner" hidden role="status">Optimizando rutas en el servidor… el mapa y el GPS siguen activos.</div>

      <header class="tower-header">
        <div class="tower-header-top">
          <div class="logo">📡 Torre de Control <span id="syncStatus" class="sync-badge">Cargando...</span></div>
          <div class="header-group header-group-actions">
            <div class="header-session" title="Operador en sesión">
              <span class="header-session-dot" aria-hidden="true"></span>
              <span class="header-operator">${escapeHTML((operatorSession && (operatorSession.display_name || operatorSession.username)) || 'Operador')}</span>
            </div>
            <button type="button" onclick="window.open('/dashboard/executive','_blank')" class="btn btn-dashboards">Dashboards</button>
            <button type="button" id="operatorLogout" class="btn btn-logout">Salir</button>
          </div>
        </div>

        <div class="tower-header-tools">
          <div class="header-group header-group-datos">
            <span class="header-group-label">Datos</span>
            <input type="text" id="excelUrl" class="input-base header-excel-url" placeholder="URL Excel / Docs">
            <div class="header-file-wrap">
              <button type="button" class="btn btn-compact btn-acepta">Acepta</button>
              <input type="file" id="aceptaFile" accept=".csv,text/csv" class="header-file-input" onchange="this.previousElementSibling.textContent = this.files[0] ? '✅ '+this.files[0].name.slice(0,10) : 'Acepta'">
            </div>
            <button type="button" id="btnSync" class="btn btn-compact btn-sync">Sync</button>
          </div>

          <div class="header-group header-group-ruteo">
            <span class="header-group-label">Ruteo</span>
            <select id="gpsInterval" class="input-base header-select-sm" title="Intervalo GPS">
              <option value="10000" selected>T. Real</option>
              <option value="60000">Ahorro</option>
              <option value="300000">Lento</option>
              <option value="0">Manual</option>
            </select>
            <select id="perfilRuteo" class="input-base header-select-md" title="Perfil">
              ${perfilesSeguros.map(p => `<option value="${p.perfil_id}" ${p.is_default ? 'selected' : ''}>${escapeHTML(p.nombre_perfil)}</option>`).join('')}
            </select>
            <select id="depotRuteo" class="input-base header-select-md" title="Bodega de salida">
              ${(depotsSeguros.length ? depotsSeguros : [{ depot_id: '', nombre: 'Bodega Central', is_default: true }]).map(d =>
                `<option value="${escapeHTML(d.depot_id || '')}" ${d.is_default ? 'selected' : ''}>${escapeHTML(d.nombre || d.depot_id || 'Bodega')}</option>`
              ).join('')}
            </select>
            <select id="climaRuteo" class="input-base header-select-sm" title="Clima">
              <option value="NORMAL" selected>Normal</option>
              <option value="LLUVIA">Lluvia</option>
              <option value="NIEBLA">Niebla</option>
            </select>
            <label class="header-trucks-wrap" title="Camiones disponibles">
              <span class="header-trucks-label">N°</span>
              <input type="number" id="camionesDisponibles" class="input-base header-trucks" value="3" min="1" max="50" step="1">
            </label>
            <button type="button" id="btnOptimize" class="btn-primary btn-compact" title="El ruteo se calcula en Cloudflare Workers (servidor). El navegador no corre el VRP.">Rutear</button>
            <button type="button" id="btnRecalcularRuteo" class="btn btn-compact" title="Elegí qué rutas ya armadas (todavía no salieron) recalcular con el perfil, N° de camiones y clima.">Recalcular</button>
            <button type="button" id="btnReoptMidday" class="btn btn-compact" title="Inserta pedidos nuevos en rutas ya activas sin romper entregas en curso">Re-opt</button>
            <button type="button" onclick="abrirRutaRapida()" class="btn btn-ruta-rapida" title="Crear ruta espontánea SPOT-">Ruta Rápida</button>
          </div>
        </div>
      </header>

      <div class="app-container">
        <aside class="sidebar">
          <div class="global-kpis">
            <div class="kpi-box" style="border-top-color: var(--primary);">
              <div class="kpi-title">Monto en Calle</div>
              <div class="kpi-val" id="kpiMontoCalle" style="color: var(--primary);">${money(totalDineroEnCalle)}</div>
            </div>
            <div class="kpi-box" style="border-top-color: var(--danger);">
              <div class="kpi-title" title="10% del monto de paradas abiertas cuyo ETA ya supera el SLA. No es multa histórica.">Riesgo SLA abierto</div>
              <div class="kpi-val" id="kpiRiesgoSla" style="color: var(--danger);">${money(totalDineroRiesgo)}</div>
            </div>
            <div class="kpi-box" style="border-top-color: var(--success);">
              <div class="kpi-title" title="Paradas en viaje sin quiebre de SLA / total de paradas abiertas. El OTIF cerrado está en Dashboards.">OTIF proyectado</div>
              <div class="kpi-val" id="kpiOtifProyectado" style="color: var(--success);">${otifProyectado}%</div>
            </div>
          </div>

          <div class="tabs-header" role="tablist">
            <button class="tab-btn active" role="tab" aria-selected="true" data-target="panel-flota">🚚 Flota (${flotaVisibleCount})</button>
            <button class="tab-btn" role="tab" aria-selected="false" data-target="panel-backlog">📋 Pedidos Pendientes (${ordenesPendientes.length})</button>
          </div>

          <div id="search-container" style="padding: 1rem 1rem 0 1rem;">
             <input type="text" id="tripSearch" class="input-base" style="width: 100%;" placeholder="🔍 Buscar Viaje, OT o Cliente...">
          </div>

          <div class="list-viewport">
            <div id="panel-flota" class="tab-content active" role="tabpanel">
              ${viajesSeguros.map(v => {
                // Auto-ocultar viajes donde el 100% de paradas están en estado terminal
                if (isViajeTerminalCompleto(v)) return ''; // Ocultar del panel

                const safeTripId = makeSafeTripId(v.trip_id);
                
                const metaViaje = safeParseJSON(v.detalle_paradas?.[0]?.metadata);
                const tagsViaje = metaViaje?.routing?.tags_viaje_exigidos || [];
                const costoOp = metaViaje?.routing?.costo_operacional || 0;
                const esRutaRapida = String(v.trip_id).startsWith('SPOT-');

                // --- [INYECCIÓN ARQUITECTURA: RESOLUCIÓN DATA CONTRACT] ---
                // Preferir km GPS de flota; si aún no hay telemetría, usar km planificado del ruteo
                const kmGps = Number(v.km_recorridos) || 0;
                const kmPlan = Number(metaViaje?.routing?.distancia_total_viaje_km) || 0;
                v.km_recorridos = kmGps > 0 ? kmGps : kmPlan;
                v.valor_total_viaje = (v.detalle_paradas || []).reduce((sum, p) => sum + Number(p.monto_total || p.valor || 0), 0);
                v.total_paradas = v.detalle_paradas?.length || 0;
                v.entregas_completadas = v.detalle_paradas?.filter(p => p.estado_operacional === APP_CONFIG.ESTADOS.ENTREGADO).length || 0;
                v.entregas_rechazadas = v.detalle_paradas?.filter(p => p.estado_operacional === APP_CONFIG.ESTADOS.RECHAZADO).length || 0;
                v.paradas_atrasadas = v._riesgo_dinamico || 0;
                // ---------------------------------------------------------

                const paradasRiesgo = Number(v.paradas_atrasadas);
                const slaEmpirico = Number(v.sla_risk_score) >= 50;
                const tieneRiesgo = Number(v.entregas_rechazadas) > 0 || paradasRiesgo > 0 || slaEmpirico;
                const badgeSla = slaEmpirico
                  ? `<span class="badge b-red" title="${escapeHTML(v.sla_risk_reason || '')}">⚠️ Quiebra SLA${v.sla_risk_cliente ? ' · ' + escapeHTML(String(v.sla_risk_cliente).slice(0, 28)) : ''}</span>`
                  : (tieneRiesgo ? `<span class="badge b-red">🔴 Riesgo</span>` : `<span class="badge b-green">🟢 OK</span>`);
                const ESTADOS_EN_CALLE = ['EN_RUTA', 'EN_SITIO', 'ENTREGADO', 'RECHAZADO'];
                const tripEnCalle = (v.detalle_paradas || []).some(p =>
                  ESTADOS_EN_CALLE.includes(String(p.estado_operacional || '').toUpperCase())
                );
                const choferLocked = tripEnCalle && !!v.chofer_id;
                return `
                <div class="trip-card" id="card-${safeTripId}" tabindex="0" role="button" aria-expanded="false" data-safe-trip="${safeTripId}" data-real-trip="${encodeURIComponent(v.trip_id)}" data-search="${escapeHTML(v._search_str)}">
                  <div class="card-header">
                    <div>
                      <div class="trip-title" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                        <span>${escapeHTML(v.trip_id)}</span>
                        <div style="display: flex; gap: 6px; position: relative; z-index: 10;">
                          <button class="btn-share-route" data-trip="${escapeHTML(v.trip_id)}" onclick="event.stopPropagation(); if(typeof window.generarEnlacePublico === 'function') window.generarEnlacePublico(this);" style="padding: 4px 8px; font-size: 0.75rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.2s; position: relative; z-index: 100; pointer-events: auto;" title="Compartir ruta pública">📤 Compartir
                          </button>
                          <button class="btn-chat-trigger" data-trip="${escapeHTML(v.trip_id)}" data-rut="${v.chofer_id || ''}" onclick="event.stopPropagation(); if(typeof window.abrirChat === 'function') window.abrirChat(this);" style="position: relative; z-index: 100; pointer-events: auto;">💬 Chat
                          </button>
                          ${esRutaRapida ? `<button class="btn-cancel-spot" data-trip="${escapeHTML(v.trip_id)}" onclick="event.stopPropagation();window.handleCancelSpot(this)" style="padding:4px 8px;font-size:0.75rem;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid #ef4444;border-radius:6px;cursor:pointer;font-weight:600;z-index:100;position:relative;pointer-events:auto;" title="Cancelar ruta r&aacute;pida">&#128465;&#65039; Cancelar</button>` : ''}
                        </div>
                      </div>
                      <div class="trip-subtitle" style="margin-top: 4px;">
                        ${v.entregas_completadas}/${v.total_paradas} Stops • 📍 ${Number(v.km_recorridos || 0).toFixed(1)} km • <b>${money(v.valor_total_viaje)}</b> • Costo Op: <span style="color:var(--danger);">${money(costoOp)}</span>${(() => {
                          const tieneGuia = (v.detalle_paradas || []).some((p) => {
                            const ge = String(p.guia_estado || '').toUpperCase();
                            return ['EMITIDA', 'STUB', 'SKIPPED', 'REVIEW', 'ERROR', 'PENDING', 'EMITTING'].includes(ge);
                          });
                          return tieneGuia
                            ? ' <span style="color:#34d399;font-weight:700;">• clic para ver guías</span>'
                            : '';
                        })()}
                      </div>
                    </div>
                    ${badgeSla}
                  </div>

                  <div class="card-body">
                    <div style="display: flex; gap: 0.5rem; width: 100%;">
                      <select id="select-${safeTripId}" class="chofer-select ${v.chofer_id ? 'assigned' : ''} ${choferLocked ? 'locked' : ''}" style="flex: 1;" data-real-trip="${encodeURIComponent(v.trip_id)}" data-previous="${v.chofer_id || ''}" ${choferLocked ? 'disabled title="Chofer bloqueado: el viaje ya está en ruta"' : ''}>
                        ${choferLocked ? '' : '<option value="">-- Asignar Chofer --</option>'}
                        ${listaChoferes.map(c => `<option value="${escapeHTML(c.chofer_id)}" ${String(v.chofer_id) === String(c.chofer_id) ? 'selected' : ''}>${escapeHTML(c.nombre_completo)} (⭐${c.skill_score})</option>`).join('')}
                      </select>
                      
                      ${(() => {
                        if (!v.chofer_id) return '';
                        const choferAsig = listaChoferes.find(c => String(c.chofer_id) === String(v.chofer_id));
                        if (!choferAsig) return '';
                        
                        const intv = choferAsig.gps_interval_seconds || 60;
                        return `
                        <select class="gps-interval-select" data-rut="${choferAsig.rut}" style="width: 90px; font-size: 0.75rem; padding: 0.4rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text-main); cursor: pointer;" title="Frecuencia GPS de la App">
                          <option value="10" ${intv == 10 ? 'selected' : ''}>⚡ 10s</option>
                          <option value="30" ${intv == 30 ? 'selected' : ''}>🚗 30s</option>
                          <option value="60" ${intv == 60 ? 'selected' : ''}>📱 1m</option>
                          <option value="300" ${intv == 300 ? 'selected' : ''}>🐢 5m</option>
                        </select>
                        `;
                      })()}
                    </div>
                    <div id="save-status-${safeTripId}" style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); display: none; text-align: center; margin-top: 4px;"></div>
                  </div>

                  <div class="card-details">
                    <div style="padding: 1rem 1rem 0.5rem 1rem; display: flex; justify-content: space-between; align-items: center;">
                      <span style="font-size: 0.7rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase;">Manifiesto de Ruta</span>
                      ${Number(v._multa_calculada) > 0 ? `<span style="font-size:0.7rem; font-weight:bold; color:var(--danger);">Multa est: ${money(v._multa_calculada)}</span>` : ''}
                    </div>
                    <div>
                      ${(v.detalle_paradas || []).map(p => {
                        const meta = safeParseJSON(p.metadata);
                        const isLate = Boolean(p.eta && p.fecha_hora_sla && new Date(p.eta).getTime() > new Date(p.fecha_hora_sla).getTime());
                        const isEntregado = p.estado_operacional === APP_CONFIG.ESTADOS.ENTREGADO;
                        const dotColor = isEntregado ? 'var(--success)' : (isLate ? 'var(--danger)' : 'var(--primary)');
                        const isRetiro = p.tipo_movimiento === 'RETIRO';
                        const movBadge = isRetiro ? `<span class="badge b-orange" style="margin-left:4px; font-size:0.6rem;">⬆️ Retiro</span>` : `<span class="badge b-green" style="margin-left:4px; font-size:0.6rem;">⬇️ Entrega</span>`;

                        let colacionHtml = '';
                        if (meta.routing?.pausa_colacion_aplicada === true) {
                            colacionHtml = `
                            <div class="stop-item" style="background: rgba(245,158,11,0.1); border-left: 3px solid #f59e0b;">
                                <div class="stop-num" style="background: transparent; font-size: 1.1rem; border: none;">🍔</div>
                                <div class="stop-info">
                                    <div style="font-size: 0.85rem; font-weight: 700; color: #854d0e;">Pausa Legal Colación (1 Hora)</div>
                                </div>
                            </div>
                            `;
                        }
                        
                        return `
                        ${colacionHtml}
                        <div class="stop-item" style="${isLate && !isEntregado ? 'background: rgba(239,68,68,0.12); border-left: 3px solid #ef4444;' : ''}">
                          <div class="stop-num" style="background: ${dotColor};">${p.stop_sequence || '-'}</div>
                          <div class="stop-info">
                            <div style="font-size: 0.85rem; font-weight: 600; display:flex; align-items:center; flex-wrap:wrap;">
                              ${escapeHTML(p.cliente)} ${movBadge}
                            </div>
                            <div style="font-size: 0.7rem; color: var(--text-muted); display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-top:0.4rem;">
                               <span>${escapeHTML(p.ot_id)} • ${money(p.monto_total || p.valor)}</span>
                               ${safeHttpUrl(p.uri)
                                 ? `<a href="${safeHttpUrl(p.uri)}" target="_blank" rel="noopener noreferrer" class="btn-doc">📄 Ver Documento</a>`
                                 : `<button disabled class="btn-doc">Documento Pendiente</button>`}
                            </div>
                          </div>
                          <div style="text-align: right; margin-left: auto;">
                            <div class="badge ${isEntregado ? 'b-green' : (p.estado_operacional === APP_CONFIG.ESTADOS.RECHAZADO ? 'b-red' : (p.estado_operacional === 'EN_SITIO' ? 'b-orange' : 'b-orange'))}" style="font-size:0.6rem; margin-bottom: 2px;"> ${escapeHTML(p.estado_operacional || p.estado || 'PENDIENTE')}</div>
                              <div style="font-size: 0.65rem; font-weight: ${isLate && !isEntregado ? '800' : '500'}; color: ${isLate && !isEntregado ? 'var(--danger)' : 'var(--text-muted)'};">
                              ${(() => {
                                if (isEntregado || p.estado_operacional === APP_CONFIG.ESTADOS.RECHAZADO) {
                                  let comparativaHtml = '';
                                  if (p.eta && p.hora_real) {
                                    const etaTime = new Date(p.eta).getTime();
                                    const realTime = new Date(p.hora_real).getTime();
                                    const diffMin = Math.round((realTime - etaTime) / 60000);
                                    const diffAbs = Math.abs(diffMin);
                                    let diffColor, diffIcon, diffText;
                                    if (diffMin < -5) {
                                      diffColor = '#10b981'; diffIcon = '⚡'; diffText = `${diffAbs}m antes`;
                                    } else if (diffMin > 5) {
                                      diffColor = '#ef4444'; diffIcon = '⏰'; diffText = `+${diffAbs}m tarde`;
                                    } else {
                                      diffColor = '#10b981'; diffIcon = '✓'; diffText = 'A tiempo';
                                    }
                                    comparativaHtml = `<div style="font-size:0.6rem; margin-top:2px; color:${diffColor}; font-weight:700;">${diffIcon} ${diffText} (ETA: ${p._eta_str})</div>`;
                                  }
                                  const statusIcon = isEntregado ? '✅' : '❌';
                                  const statusColor = isEntregado ? 'var(--success)' : 'var(--danger)';
                                  return `<span style="color: ${statusColor};">${statusIcon} Real: ${p._hora_real_str}</span>${comparativaHtml}`;
                                } else {
                                  return `⏳ ETA: ${p._eta_str} · SLA: ${p._fecha_sla_str || '--:--'}`;
                                }
                              })()}
                            </div>
                          </div>
                        </div>
                        `
                      }).join('')}
                    </div>
                  </div>
                </div>
              `}).join('')}
            </div>

            <div id="panel-backlog" class="tab-content" role="tabpanel">
              ${ordenesPendientes.map(o => {
                const metaBacklog = safeParseJSON(o.metadata);
                const tagsBacklog = metaBacklog?.routing?.tags_viaje_exigidos || [];
                const montoNum = Number(o.monto_total != null ? o.monto_total : o.valor_oc_clp);
                const montoTxt = Number.isFinite(montoNum) && montoNum > 0 ? money(montoNum) : '—';
                const latNum = Number(o.lat);
                const lngNum = Number(o.lng);
                const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum);
                return `
                <div class="backlog-item${hasCoords ? ' has-coords' : ''}" data-lat="${hasCoords ? latNum : ''}" data-lng="${hasCoords ? lngNum : ''}" ${hasCoords ? 'role="button" tabindex="0"' : ''}>
                  <div style="display:flex; justify-content:space-between;">
                    <div>
                      <div style="font-weight:700; font-size:0.9rem; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                        ${escapeHTML(o.cliente)}
                        ${tagsBacklog.map(t => `<span class="badge b-neutral" style="font-size:0.65rem;">${escapeHTML(t)}</span>`).join('')}
                      </div>
                      <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${escapeHTML(o.ot_id)}</div>
                    </div>
                    <div style="color:var(--success); font-weight:800;">${montoTxt}</div>
                  </div>
                </div>
                `;
              }).join('')}
            </div>
          </div>
        </aside>

        <main class="map-container">
          <div id="map"></div>
        </main>
      </div>

      <!-- AI COPILOT WIDGET INJECTION -->
      ${aiWidgetHtml}

      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script id="ordenes-json" type="application/json">${safeOrdenesJson}</script>
      <script id="viajes-json" type="application/json">${safeViajesJson}</script>
      <script id="config-json" type="application/json">${safeConfigJson}</script>
      <script id="choferes-json" type="application/json">${rawChoferesJson}</script>
`;
};
