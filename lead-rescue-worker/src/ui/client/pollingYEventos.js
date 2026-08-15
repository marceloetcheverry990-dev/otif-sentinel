// src/ui/client/pollingYEventos.js
// renderPanelFlota client-side, formatHoraCL, appState, actualizarUI, DOMContentLoaded y polling.
// Extraido de src/ui.js Script #1 y Script #2 (Fase 3, Req 4). No ejecutar en el Worker.

export const POLLING_EVENTOS_SCRIPT = `
        // Regla §3: tenant_id leído desde config-json (inyectado por el servidor, no hardcodeado aquí).
        window._TENANT_ID = CONFIG.tenant_id || 'empresa_base';
        // Lista de choferes - cargada desde script tag (evita problemas de escape en template literal)
        try { window._listaChoferes = JSON.parse(document.getElementById('choferes-json').textContent); } catch(e) { window._listaChoferes = []; }

        // Reintento de guías Res. 154 (badge "Guía ERR" en panel de flota)
        window.retryGuiaTrip = async function(tripId) {
          if (!tripId) return;
          if (!confirm('¿Reintentar emisión de guías para el viaje ' + tripId + '?')) return;
          try {
            var res = await fetch('/api/guias-despacho/retry', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ trip_id: tripId })
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error al reintentar');
            alert('Reintento: emitidas=' + (data.emitted || 0) + ' errores=' + (data.errors || 0) + ' omitidas=' + (data.skipped || 0));
            if (typeof window.actualizarViajesSilencioso === 'function') window.actualizarViajesSilencioso();
          } catch (e) {
            alert('No se pudo reintentar: ' + (e.message || e));
          }
        };

        // ============================================================================
        // TIME_CL y formatHoraCL — disponibles globalmente en el cliente
        // (duplicadas desde el scope del servidor para que renderMensajesChat pueda usarlas)
        // ============================================================================
        var _TIME_CL = new Intl.DateTimeFormat('es-CL', {
          timeZone: 'America/Santiago',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
        function formatHoraCL(fecha) {
          if (!fecha) return '--:--';
          var d = new Date(fecha);
          if (isNaN(d.getTime())) return '--:--';
          return _TIME_CL.format(d);
        }

        // ============================================================================
        // window.renderPanelFlota — Re-renderizado cliente para el live polling
        // IMPORTANTE: Esta función usa concatenación de strings, NO template literals,
        // para evitar conflictos con el template literal del servidor que la contiene.
        // ============================================================================
        window.renderPanelFlota = function(viajes) {
          if (!viajes || viajes.length === 0) {
            return '<div style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.85rem;">No hay viajes activos.</div>';
          }

          var money = function(val) { return '$' + Number(val || 0).toLocaleString('es-CL'); };

          var safeStr = function(s) {
            return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          };
          var safeHref = function(u) {
            var s = String(u == null ? '' : u).trim();
            if (!/^https?:\\/\\//i.test(s)) return '';
            return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;');
          };
          var makeSafeTripId = function(tripId) {
            return 'trip_' + Array.from(String(tripId == null ? '' : tripId)).map(function(c) {
              return c.charCodeAt(0).toString(16).padStart(2, '0');
            }).join('');
          };

          window._choferPin = window._choferPin || {};

          var ESTADOS_ENTREGADO = 'ENTREGADO';
          var ESTADOS_RECHAZADO = 'RECHAZADO';
          var ESTADOS_TERMINALES_FILTER = ['ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'];

          return viajes.map(function(v) {
            // Auto-ocultar viajes donde el 100% de paradas están en estado terminal
            var paradasV = v.detalle_paradas || [];
            if (paradasV.length > 0 && paradasV.every(function(p) { return ESTADOS_TERMINALES_FILTER.indexOf(p.estado_operacional) !== -1; })) {
              return ''; // Viaje completado — no renderizar
            }

            // Pin local: evita que el poll borre el chofer recién asignado / desasignado
            if (Object.prototype.hasOwnProperty.call(window._choferPin, String(v.trip_id))) {
              var pinnedChofer = window._choferPin[String(v.trip_id)];
              if (pinnedChofer === '' || pinnedChofer == null) {
                if (!v.chofer_id) {
                  delete window._choferPin[String(v.trip_id)];
                } else {
                  v.chofer_id = null;
                  v.chofer = 'Sin Asignar';
                }
              } else if (v.chofer_id != null && String(v.chofer_id) === String(pinnedChofer)) {
                delete window._choferPin[String(v.trip_id)];
              } else {
                v.chofer_id = pinnedChofer;
              }
            }

            var safeTripId = makeSafeTripId(v.trip_id);
            var esRutaRapidaClient = String(v.trip_id).startsWith('SPOT-');

            var metaViaje = {};
            try {
              var p0 = v.detalle_paradas && v.detalle_paradas[0];
              if (p0 && p0.routing) {
                metaViaje = { routing: p0.routing };
              } else {
                var raw = p0 && p0.metadata;
                metaViaje = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
              }
            } catch(e) {}

            // Preferir km GPS de flota; si aún no hay telemetría, usar km planificado del ruteo
            var kmGps = Number(v.km_recorridos) || 0;
            var kmPlan = Number(metaViaje.routing && metaViaje.routing.distancia_total_viaje_km) || 0;
            v.km_recorridos = kmGps > 0 ? kmGps : kmPlan;
            v.valor_total_viaje = (v.detalle_paradas || []).reduce(function(s,p){ return s + Number(p.monto_total || p.valor || 0); }, 0);
            v.total_paradas = (v.detalle_paradas || []).length;
            v.entregas_completadas = (v.detalle_paradas || []).filter(function(p){ return p.estado_operacional === ESTADOS_ENTREGADO; }).length;
            v.entregas_rechazadas = (v.detalle_paradas || []).filter(function(p){ return p.estado_operacional === ESTADOS_RECHAZADO; }).length;
            v.paradas_atrasadas = v._riesgo_dinamico || 0;

            var slaEmpirico = Number(v.sla_risk_score) >= 50;
            var tieneRiesgo = v.entregas_rechazadas > 0 || v.paradas_atrasadas > 0 || slaEmpirico;
            var badgeSlaHtml = slaEmpirico
              ? '<span class="badge b-red" title="' + safeStr(v.sla_risk_reason || '') + '">&#9888;&#65039; Quiebra SLA' +
                (v.sla_risk_cliente ? ' · ' + safeStr(String(v.sla_risk_cliente).slice(0, 28)) : '') + '</span>'
              : (tieneRiesgo ? '<span class="badge b-red">&#128308; Riesgo</span>' : '<span class="badge b-green">&#128994; OK</span>');
            var searchStr = (String(v.trip_id) + ' ' + String(v.chofer || '') + ' ' + (v.detalle_paradas || []).map(function(p){ return (p.ot_id||'') + ' ' + (p.cliente||''); }).join(' ')).toLowerCase();
            var multaCalc = Number(v._multa_calculada || 0);
            var costoOp = (metaViaje.routing && metaViaje.routing.costo_operacional) || 0;
            var ESTADOS_EN_CALLE = ['EN_RUTA', 'EN_SITIO', 'ENTREGADO', 'RECHAZADO'];
            var tripEnCalle = (v.detalle_paradas || []).some(function(p) {
              return ESTADOS_EN_CALLE.indexOf(String(p.estado_operacional || '').toUpperCase()) !== -1;
            });
            var choferLocked = tripEnCalle && !!v.chofer_id;

            // ── card-details: iterar paradas ──────────────────────────────────
            var paradasHtml = (v.detalle_paradas || []).map(function(p) {
              // Calcular strings de hora aquí — el polling devuelve p.eta y p.hora_real
              // como strings ISO crudos, sin los campos _eta_str/_hora_real_str pre-calculados
              // que el servidor genera en el forEach inicial. Los calculamos defensivamente.
              var etaStr      = (typeof formatHoraCL === 'function') ? formatHoraCL(p._eta_str      || p.eta)       : (p._eta_str      || '--:--');
              var horaRealStr = (typeof formatHoraCL === 'function') ? formatHoraCL(p._hora_real_str || p.hora_real) : (p._hora_real_str || '--:--');

              var isLate = Boolean(p.eta && p.fecha_hora_sla && new Date(p.eta).getTime() > new Date(p.fecha_hora_sla).getTime());
              var isEntregado = p.estado_operacional === ESTADOS_ENTREGADO;
              var isRechazado = p.estado_operacional === ESTADOS_RECHAZADO;
              // Máquina de estados: EN_SITIO es el estado real que escribe el backend
              var isEnSitio = p.estado_operacional === 'EN_SITIO';

              // ── Niveles visuales de tiempo de espera (ajuste solicitado) ──────────
              // Verde < 15 min | Amarillo 15-30 min | Naranja 30-60 min | Rojo > 60 min
              var enSitioColor = 'var(--warning)';
              var enSitioLabel = 'EN SITIO';
              var minutosEspera = 0;
              if (isEnSitio && p.hora_llegada_chofer) {
                minutosEspera = Math.floor((Date.now() - new Date(p.hora_llegada_chofer).getTime()) / 60000);
                if (minutosEspera < 15) {
                  enSitioColor = 'var(--success)';
                  enSitioLabel = 'EN SITIO (' + minutosEspera + 'm)';
                } else if (minutosEspera < 30) {
                  enSitioColor = 'var(--warning)';
                  enSitioLabel = 'ESPERA ' + minutosEspera + 'm';
                } else if (minutosEspera < 60) {
                  enSitioColor = '#f97316'; // naranja intenso
                  enSitioLabel = '&#9888; ESPERA ' + minutosEspera + 'm';
                } else {
                  enSitioColor = 'var(--danger)';
                  enSitioLabel = '&#128680; ESPERA ' + minutosEspera + 'm';
                }
              }

              var dotColor = isEntregado ? 'var(--success)' : (isEnSitio ? enSitioColor : (isLate ? 'var(--danger)' : 'var(--primary)'));
              var isRetiro = p.tipo_movimiento === 'RETIRO';
              var movBadge = isRetiro
                ? '<span class="badge b-orange" style="margin-left:4px;font-size:0.6rem;">&#11014;&#65039; Retiro</span>'
                : '<span class="badge b-green" style="margin-left:4px;font-size:0.6rem;">&#11015;&#65039; Entrega</span>';

              var colacionHtml = '';
              try {
                var pMeta = p.metadata ? (typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata) : {};
                if (pMeta.routing && pMeta.routing.pausa_colacion_aplicada === true) {
                  colacionHtml = '<div class="stop-item" style="background:rgba(245,158,11,0.1);border-left:3px solid #f59e0b;">' +
                    '<div class="stop-num" style="background:transparent;font-size:1.1rem;border:none;">&#127828;</div>' +
                    '<div class="stop-info"><div style="font-size:0.85rem;font-weight:700;color:#854d0e;">Pausa Legal Colaci&#243;n (1 Hora)</div></div>' +
                  '</div>';
                }
              } catch(e) {}

              var horaHtml;
              if (isEntregado) {
                // Calcular comparativa ETA vs Real
                var comparativaHtml = '';
                if (p.eta && p.hora_real) {
                  var etaTime = new Date(p.eta).getTime();
                  var realTime = new Date(p.hora_real).getTime();
                  var diffMin = Math.round((realTime - etaTime) / 60000);
                  var diffAbs = Math.abs(diffMin);
                  
                  var diffColor, diffIcon, diffText;
                  if (diffMin < -5) {
                    diffColor = '#10b981';
                    diffIcon = '&#9889;'; // ⚡
                    diffText = diffAbs + 'm antes';
                  } else if (diffMin > 5) {
                    diffColor = '#ef4444';
                    diffIcon = '&#9200;'; // ⏰
                    diffText = '+' + diffAbs + 'm tarde';
                  } else {
                    diffColor = '#10b981';
                    diffIcon = '&#10003;'; // ✓
                    diffText = 'A tiempo';
                  }
                  
                  var etaStrCalc = (typeof formatHoraCL === 'function') ? formatHoraCL(p.eta) : '--:--';
                  comparativaHtml = '<div style="font-size:0.6rem;margin-top:2px;color:' + diffColor + ';font-weight:700;">' + diffIcon + ' ' + diffText + ' (ETA: ' + etaStrCalc + ')</div>';
                }
                horaHtml = '<span style="color:var(--success);">&#9989; Real: ' + safeStr(horaRealStr) + '</span>' + comparativaHtml;
              } else if (isRechazado) {
                // Calcular comparativa ETA vs Real para rechazados también
                var comparativaHtml = '';
                if (p.eta && p.hora_real) {
                  var etaTime = new Date(p.eta).getTime();
                  var realTime = new Date(p.hora_real).getTime();
                  var diffMin = Math.round((realTime - etaTime) / 60000);
                  var diffAbs = Math.abs(diffMin);
                  
                  var diffColor = diffMin > 5 ? '#ef4444' : '#10b981';
                  var diffIcon = diffMin > 5 ? '&#9200;' : '&#10003;';
                  var diffText = diffMin > 5 ? ('+' + diffAbs + 'm tarde') : (diffMin < -5 ? (diffAbs + 'm antes') : 'A tiempo');
                  
                  var etaStrCalc = (typeof formatHoraCL === 'function') ? formatHoraCL(p.eta) : '--:--';
                  comparativaHtml = '<div style="font-size:0.6rem;margin-top:2px;color:' + diffColor + ';font-weight:700;">' + diffIcon + ' ' + diffText + ' (ETA: ' + etaStrCalc + ')</div>';
                }
                horaHtml = '<span style="color:var(--danger);">&#10060; Real: ' + safeStr(horaRealStr) + '</span>' + comparativaHtml;
              } else if (isEnSitio) {
                // Mostrar hora de llegada + tiempo de espera acumulado
                var llegadaStr = (typeof formatHoraCL === 'function')
                  ? formatHoraCL(p.hora_llegada_chofer)
                  : '--:--';
                horaHtml = '<span style="color:' + enSitioColor + ';">&#128205; Llegó: ' + safeStr(llegadaStr) + (minutosEspera > 0 ? ' (+' + minutosEspera + 'm)' : '') + '</span>';
              } else {
                horaHtml = '&#9203; ETA: ' + safeStr(etaStr);
              }

              // Badge con nivel de urgencia para EN_SITIO
              var badgeClass = isEntregado ? 'b-green' : (isRechazado ? 'b-red' : (isEnSitio ? 'b-orange' : 'b-orange'));
              var badgeStyle = isEnSitio ? 'background:' + enSitioColor + ';color:white;' : '';
              var badgeLabel = isEntregado ? 'ENTREGADO' : (isRechazado ? 'RECHAZADO' : (isEnSitio ? enSitioLabel : safeStr(p.estado_operacional || p.estado || 'PENDIENTE')));

              // Badge guía Res. 154 (STUB ≠ OK — no bloquea reemisión real)
              var guiaHtml = '';
              var ge = String(p.guia_estado || '').toUpperCase();
              if (ge === 'EMITIDA') {
                guiaHtml = '<div class="badge b-green" style="font-size:0.55rem;margin-top:2px;" title="Folio ' + safeStr(p.guia_folio || '') + '">Gu&#237;a OK</div>';
              } else if (ge === 'SKIPPED' && p.guia_folio && String(p.guia_folio).indexOf('STUB-') !== 0) {
                guiaHtml = '<div class="badge b-green" style="font-size:0.55rem;margin-top:2px;" title="Folio ' + safeStr(p.guia_folio || '') + '">Gu&#237;a OK</div>';
              } else if (ge === 'STUB' || (ge === 'SKIPPED' && (!p.guia_folio || String(p.guia_folio).indexOf('STUB-') === 0))) {
                guiaHtml = '<div class="badge b-orange" style="font-size:0.55rem;margin-top:2px;cursor:pointer;" title="Stub — sin DTE real. Clic para reintentar" onclick="event.stopPropagation();window.retryGuiaTrip &amp;&amp; window.retryGuiaTrip(\'' + safeStr(v.trip_id).replace(/'/g, '') + '\')">Gu&#237;a STUB</div>';
              } else if (ge === 'REVIEW') {
                guiaHtml = '<div class="badge b-orange" style="font-size:0.55rem;margin-top:2px;cursor:pointer;" title="' + safeStr(p.guia_error || 'Confirmar hora de emisi\u00f3n') + '" onclick="event.stopPropagation();window.retryGuiaTrip &amp;&amp; window.retryGuiaTrip(\'' + safeStr(v.trip_id).replace(/'/g, '') + '\')">Gu&#237;a REV</div>';
              } else if (ge === 'ERROR') {
                guiaHtml = '<div class="badge b-red" style="font-size:0.55rem;margin-top:2px;cursor:pointer;" title="' + safeStr(p.guia_error || 'Error') + '" onclick="event.stopPropagation();window.retryGuiaTrip &amp;&amp; window.retryGuiaTrip(\'' + safeStr(v.trip_id).replace(/'/g, '') + '\')">Gu&#237;a ERR</div>';
              } else if (ge === 'PENDING' || ge === 'EMITTING') {
                guiaHtml = '<div class="badge b-orange" style="font-size:0.55rem;margin-top:2px;">Gu&#237;a…</div>';
              }
              var hrefDoc = safeHref(p.uri);
              var docBtn = hrefDoc
                ? '<a href="' + hrefDoc + '" target="_blank" rel="noopener noreferrer" class="btn-doc">&#128196; Ver Documento</a>'
                : '<button disabled class="btn-doc">Documento Pendiente</button>';
              var hrefFoto = safeHref(p.evidencia_url);
              var hrefFirma = safeHref(p.firma_url);
              var podLinks = '';
              if (hrefFoto || hrefFirma) {
                podLinks = '<span style="display:inline-flex;gap:4px;">' +
                  (hrefFoto ? '<a href="' + hrefFoto + '" target="_blank" rel="noopener noreferrer" style="font-size:0.65rem;color:#38bdf8;">Foto</a>' : '') +
                  (hrefFirma ? '<a href="' + hrefFirma + '" target="_blank" rel="noopener noreferrer" style="font-size:0.65rem;color:#a78bfa;">Firma</a>' : '') +
                  '</span>';
              }

              // Botón de edición — solo para paradas de Ruta Rápida (ot_id empieza con SPOT-)
              var editBtn = '';
              if (String(p.ot_id || '').startsWith('SPOT-') && !isEntregado && !isRechazado) {
                var otIdSafe = safeStr(p.ot_id);
                var dirActualEdit = '';
                try {
                  var pMetaEdit = p.metadata ? (typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata) : {};
                  dirActualEdit = safeStr(pMetaEdit.direccion_entrega || '');
                } catch(e) {}
                editBtn = '<button class="btn-edit-dir" data-ot="' + otIdSafe + '" data-dir="' + dirActualEdit.replace(/"/g, '&quot;') + '" onclick="event.stopPropagation();window.handleEditDir(this)" style="padding:3px 8px;font-size:0.7rem;background:rgba(99,102,241,0.2);color:#818cf8;border:1px solid #6366f1;border-radius:4px;cursor:pointer;font-weight:600;" title="Editar direcci&#243;n de entrega">&#9998; Editar</button>';
              }

              // Override dispatcher: ↑ ↓ mover (paradas abiertas; no canceladas)
              var isCancelado = String(p.estado_operacional || '').toUpperCase() === 'CANCELADO_PLANILLA';
              var overrideBtns = '';
              if (!isEntregado && !isRechazado && !isEnSitio && !isCancelado) {
                overrideBtns =
                  '<span class="stop-override" style="display:inline-flex;gap:4px;margin-left:4px;">' +
                  '<button type="button" class="btn-stop-up" data-trip="' + safeStr(v.trip_id) + '" data-ot="' + safeStr(p.ot_id) + '" title="Subir" style="padding:2px 6px;font-size:0.7rem;cursor:pointer;">&#8593;</button>' +
                  '<button type="button" class="btn-stop-down" data-trip="' + safeStr(v.trip_id) + '" data-ot="' + safeStr(p.ot_id) + '" title="Bajar" style="padding:2px 6px;font-size:0.7rem;cursor:pointer;">&#8595;</button>' +
                  '<button type="button" class="btn-stop-move" data-trip="' + safeStr(v.trip_id) + '" data-ot="' + safeStr(p.ot_id) + '" title="Mover a otro viaje" style="padding:2px 6px;font-size:0.65rem;cursor:pointer;">Mover</button>' +
                  '</span>';
              }

              return colacionHtml +
                '<div class="stop-item" style="' + (isLate && !isEntregado ? 'background:rgba(239,68,68,0.12);border-left:3px solid #ef4444;' : '') + '">' +
                  '<div class="stop-num" style="background:' + dotColor + ';">' + safeStr(p.stop_sequence || '-') + '</div>' +
                  '<div class="stop-info">' +
                    '<div style="font-size:0.85rem;font-weight:600;display:flex;align-items:center;flex-wrap:wrap;">' +
                      safeStr(p.cliente) + ' ' + movBadge +
                    '</div>' +
                    '<div style="font-size:0.7rem;color:var(--text-muted);display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-top:0.4rem;">' +
                      '<span>' + safeStr(p.ot_id) + ' &bull; ' + money(p.monto_total || p.valor) + '</span>' +
                      docBtn +
                      podLinks +
                      editBtn +
                      overrideBtns +
                    '</div>' +
                  '</div>' +
                  '<div style="text-align:right;margin-left:auto;">' +
                    '<div class="badge ' + badgeClass + '" style="font-size:0.6rem;margin-bottom:2px;' + badgeStyle + '">' + badgeLabel + '</div>' +
                    guiaHtml +
                    '<div style="font-size:0.65rem;font-weight:' + (isLate && !isEntregado ? '800' : '500') + ';color:' + (isLate && !isEntregado ? 'var(--danger)' : 'var(--text-muted)') + ';">' +
                      horaHtml +
                    '</div>' +
                  '</div>' +
                '</div>';
            }).join('');

            // ── card completa ─────────────────────────────────────────────────
            return '<div class="trip-card" id="card-' + safeTripId + '" tabindex="0" role="button" aria-expanded="false"' +
              ' data-safe-trip="' + safeTripId + '"' +
              ' data-real-trip="' + encodeURIComponent(v.trip_id) + '"' +
              ' data-search="' + safeStr(searchStr) + '">' +
              '<div class="card-header">' +
                '<div>' +
                  '<div class="trip-title" style="display:flex;align-items:center;justify-content:space-between;width:100%;">' +
                    '<span>' + safeStr(v.trip_id) + '</span>' +
                    '<div style="display:flex;gap:6px;position:relative;z-index:10;">' +
                      '<button class="btn-share-route" data-trip="' + safeStr(v.trip_id) + '" style="padding:4px 8px;font-size:0.75rem;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;transition:all 0.2s;position:relative;z-index:100;" title="Compartir ruta pública">&#128228; Compartir</button>' +
                      '<button class="btn-chat-trigger" data-trip="' + safeStr(v.trip_id) + '" data-rut="' + safeStr(v.chofer_id || '') + '" style="position:relative;z-index:100;">&#128172; Chat</button>' +
                      (esRutaRapidaClient ? '<button class="btn-cancel-spot" data-trip="' + safeStr(v.trip_id) + '" onclick="event.stopPropagation();window.handleCancelSpot(this)" style="padding:4px 8px;font-size:0.75rem;background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid #ef4444;border-radius:6px;cursor:pointer;font-weight:600;z-index:100;position:relative;" title="Cancelar ruta r&#225;pida">&#128465;&#65039; Cancelar</button>' : '') +
                    '</div>' +
                  '</div>' +
                  '<div class="trip-subtitle" style="margin-top:4px;">' +
                    v.entregas_completadas + '/' + v.total_paradas + ' Stops' +
                    ' &bull; &#128205; ' + Number(v.km_recorridos || 0).toFixed(1) + ' km' +
                    ' &bull; <b>' + money(v.valor_total_viaje) + '</b>' +
                    ' &bull; Costo Op: <span style="color:var(--danger);">' + money(costoOp) + '</span>' +
                  '</div>' +
                '</div>' +
                badgeSlaHtml +
              '</div>' +
              '<div class="card-body">' +
                '<div style="display:flex;gap:0.5rem;width:100%;">' +
                  '<select id="select-' + safeTripId + '" class="chofer-select ' + (v.chofer_id ? 'assigned' : '') + (choferLocked ? ' locked' : '') + '" style="flex:1;" data-real-trip="' + encodeURIComponent(v.trip_id) + '" data-previous="' + safeStr(v.chofer_id || '') + '"' +
                    (choferLocked ? ' disabled title="Chofer bloqueado: el viaje ya está en ruta"' : '') + '>' +
                    (choferLocked ? '' : '<option value="">-- Asignar Chofer --</option>') +
                    (window._listaChoferes || []).map(function(c) {
                      return '<option value="' + safeStr(c.chofer_id) + '" ' + (String(v.chofer_id) === String(c.chofer_id) ? 'selected' : '') + '>' +
                        safeStr(c.nombre_completo) + ' (\u2b50' + safeStr(c.skill_score) + ')</option>';
                    }).join('') +
                  '</select>' +
                  (function() {
                    if (!v.chofer_id) return '';
                    var choferAsig = (window._listaChoferes || []).find(function(c) { return String(c.chofer_id) === String(v.chofer_id); });
                    if (!choferAsig) return '';
                    var intv = choferAsig.gps_interval_seconds || 60;
                    return '<select class="gps-interval-select" data-rut="' + safeStr(choferAsig.rut) + '" style="width:90px;font-size:0.75rem;padding:0.4rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text-main);cursor:pointer;" title="Frecuencia GPS">' +
                      '<option value="10" ' + (intv == 10 ? 'selected' : '') + '>&#9889; 10s</option>' +
                      '<option value="30" ' + (intv == 30 ? 'selected' : '') + '>&#128663; 30s</option>' +
                      '<option value="60" ' + (intv == 60 ? 'selected' : '') + '>&#128241; 1m</option>' +
                      '<option value="300" ' + (intv == 300 ? 'selected' : '') + '>&#128034; 5m</option>' +
                    '</select>';
                  })() +
                '</div>' +
                '<div id="save-status-' + safeTripId + '" style="font-size:0.7rem;font-weight:700;color:var(--text-muted);display:none;text-align:center;margin-top:4px;"></div>' +
              '</div>' +
              '<div class="card-details">' +
                '<div style="padding:1rem 1rem 0.5rem 1rem;display:flex;justify-content:space-between;align-items:center;">' +
                  '<span style="font-size:0.7rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;">Manifiesto de Ruta</span>' +
                  (multaCalc > 0 ? '<span style="font-size:0.7rem;font-weight:bold;color:var(--danger);">Multa est: ' + money(multaCalc) + '</span>' : '') +
                '</div>' +
                '<div>' + paradasHtml + '</div>' +
              '</div>' +
            '</div>';
          }).join('');
        };
        const appState = new Proxy({
          activeTripId: null,
          activeTab: 'panel-flota',
          searchTerm: ''
        }, {
          set(target, property, value) {
            target[property] = value;
            actualizarUI(property, value);
            return true;
          }
        });

        // ============================================================================
        // LÓGICA DE UI REACTIVA
        // ============================================================================
        function actualizarUI(propiedad, valor) {
          if (propiedad === 'activeTab') {
            document.querySelectorAll('.tab-btn').forEach(t => {
              const isActive = t.dataset.target === valor;
              t.classList.toggle('active', isActive);
              t.setAttribute('aria-selected', isActive);
            });
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(valor).classList.add('active');
            
            document.getElementById('search-container').style.display = valor === 'panel-flota' ? 'block' : 'none';
            if(valor === 'panel-backlog') appState.activeTripId = null;
          }

          if (propiedad === 'activeTripId') {
            document.querySelectorAll('.trip-card').forEach(card => {
              const isActive = card.dataset.safeTrip === valor;
              card.classList.toggle('active', isActive);
              card.setAttribute('aria-expanded', isActive);
              
              if (isActive) {
                 const select = document.getElementById('select-' + valor);
                 if (select) setTimeout(() => select.focus(), 50);
              }
            });
            dibujarRutaEnMapa(valor);
          }

          if (propiedad === 'searchTerm') {
            const term = valor.toLowerCase();
            document.querySelectorAll('.trip-card').forEach(card => {
               if (card.dataset.search.includes(term)) {
                  card.style.display = 'block';
               } else {
                  card.style.display = 'none';
                  if (appState.activeTripId === card.dataset.safeTrip) appState.activeTripId = null;
               }
            });
          }
        }

        // ============================================================================
        // LÓGICA DE MAPAS CON PROGRAMACIÓN DEFENSIVA
        // ============================================================================
        // ============================================================================
        // EVENT LISTENERS DE DOM
        // ============================================================================
        document.addEventListener('DOMContentLoaded', () => {
          try {
            initMap();
            
            let gpsTimer;
            const configurarIntervaloGps = (intervalo) => {
              if (gpsTimer) clearInterval(gpsTimer);
              rastrearFlotaEnVivo(); 
              if (intervalo > 0) {
                gpsTimer = setInterval(rastrearFlotaEnVivo, intervalo);
              }
            };
            configurarIntervaloGps(10000);

      // ======================================================
      // LIVE REFRESH VIAJES (sin reload)
      // Regla §4: document.hidden guard — no pollear con pestaña oculta
      // Regla §3: tenant_id inyectado desde el servidor, no hardcodeado
      // ======================================================

      // El tenant_id se lee desde window._TENANT_ID, inyectado por el servidor antes de este script.

      // ======================================================
      // LEAD RESCUE — banner Dead Man's Switch + modal candidatos
      // ======================================================
      window._fleetAlerts = window._fleetAlerts || [];

      function ensureLeadRescueModal() {
        var el = document.getElementById('leadRescueModal');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'leadRescueModal';
        el.hidden = true;
        el.innerHTML =
          '<div class="lead-rescue-modal-card">' +
            '<h3>🆘 Lead Rescue — elegir camión</h3>' +
            '<div class="lead-rescue-modal-body" id="leadRescueModalBody">Cargando…</div>' +
          '</div>';
        el.addEventListener('click', function(ev) {
          if (ev.target === el) el.hidden = true;
        });
        document.body.appendChild(el);
        return el;
      }

      window.renderLeadRescueBanner = function(alerts) {
        var banner = document.getElementById('leadRescueBanner');
        if (!banner) return;
        var list = Array.isArray(alerts) ? alerts.filter(function(a) {
          return a && (a.status === 'OPEN' || a.status === 'ACKED' || a.status === 'RESCUING');
        }) : [];
        if (!list.length) {
          banner.hidden = true;
          banner.innerHTML = '';
          return;
        }
        var top = list[0];
        var isRed = String(top.severity || '').toUpperCase() === 'RED';
        banner.className = 'lead-rescue-banner' + (isRed ? '' : ' severity-yellow');
        banner.hidden = false;
        var payload = top.payload || {};
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
        }
        var label = top.alert_type === 'SIGNAL_LOST' ? 'Señal GPS perdida' : 'Camión detenido';
        var chofer = payload.chofer || '—';
        var mins = top.stuck_minutes != null ? top.stuck_minutes : '?';
        var more = list.length > 1 ? (' (+' + (list.length - 1) + ' más)') : '';
        var esc = function(s) {
          return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        };
        banner.innerHTML =
          '<div>' +
            (isRed ? '🔴' : '🟡') + ' <strong>' + esc(label) + '</strong> · Viaje <code>' +
            esc(top.trip_id) + '</code> · ' + esc(chofer) + ' · ' + esc(mins) + ' min' + more +
          '</div>' +
          '<div class="lead-rescue-banner-actions">' +
            (top.status === 'RESCUING'
              ? '<span style="opacity:0.9">Rescate en curso…</span>'
              : '<button type="button" class="btn-rescue" data-trip="' + esc(top.trip_id) +
                '" data-alert="' + esc(top.id) + '">Rescatar carga</button>') +
            '<button type="button" class="btn-dismiss-alert" data-alert="' + esc(top.id) + '">Descartar</button>' +
          '</div>';

        var btnRescue = banner.querySelector('.btn-rescue');
        if (btnRescue) {
          btnRescue.addEventListener('click', function() {
            window.openLeadRescueModal(btnRescue.getAttribute('data-trip'), btnRescue.getAttribute('data-alert'));
          });
        }
        var btnDismiss = banner.querySelector('.btn-dismiss-alert');
        if (btnDismiss) {
          btnDismiss.addEventListener('click', async function() {
            var aid = btnDismiss.getAttribute('data-alert');
            if (!aid || !confirm('¿Descartar esta alerta?')) return;
            try {
              var res = await fetch('/api/fleet-alerts/' + encodeURIComponent(aid) + '/dismiss', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              });
              var data = await res.json().catch(function() { return {}; });
              if (!res.ok) throw new Error(data.error || 'No se pudo descartar');
              window._fleetAlerts = (window._fleetAlerts || []).filter(function(a) { return String(a.id) !== String(aid); });
              window.renderLeadRescueBanner(window._fleetAlerts);
            } catch (err) {
              alert('Error: ' + err.message);
            }
          });
        }
      };

      window.openLeadRescueModal = async function(tripId, alertId) {
        if (!tripId) return;
        var modal = ensureLeadRescueModal();
        var body = document.getElementById('leadRescueModalBody');
        modal.hidden = false;
        body.innerHTML = 'Buscando camiones cercanos con cupo…';
        try {
          var res = await fetch('/api/lead-rescue/candidates?trip_id=' + encodeURIComponent(tripId), {
            credentials: 'same-origin',
          });
          var data = await res.json();
          if (!res.ok || !data.exito) throw new Error(data.error || 'Sin candidatos');
          var cands = data.candidates || [];
          if (!cands.length) {
            body.innerHTML =
              '<p>No hay camiones activos con cupo cerca del varado.</p>' +
              '<p style="color:#94a3b8;font-size:0.8rem;">Carga: ' + (data.cargo && data.cargo.stops) +
              ' paradas / vol ' + (data.cargo && data.cargo.volume) + '</p>' +
              '<button type="button" class="btn" id="leadRescueClose">Cerrar</button>';
            document.getElementById('leadRescueClose').onclick = function() { modal.hidden = true; };
            return;
          }
          var escM = function(s) {
            return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          };
          var html =
            '<p style="margin:0 0 0.75rem;color:#94a3b8;">Viaje varado <code>' + escM(tripId) +
            '</code> · ' + escM(data.cargo && data.cargo.stops) + ' paradas transferibles (vol ' +
            escM(data.cargo && data.cargo.volume) + ')</p>';
          cands.forEach(function(c) {
            html +=
              '<div class="lead-rescue-candidate">' +
                '<div>' +
                  '<div><strong>' + escM(c.nombre || c.patente || c.trip_id) + '</strong></div>' +
                  '<div style="color:#94a3b8;font-size:0.78rem;">' +
                    escM(c.trip_id) + ' · ' + escM(c.delta_km) + ' km · ~' + escM(c.eta_min_approx) +
                    ' min · cupo ' + escM(c.spare_volume) +
                  '</div>' +
                '</div>' +
                '<button type="button" data-rescue="' + escM(c.trip_id) + '">Enviar misión</button>' +
              '</div>';
          });
          html += '<button type="button" class="btn" id="leadRescueClose" style="margin-top:0.5rem;">Cancelar</button>';
          body.innerHTML = html;
          document.getElementById('leadRescueClose').onclick = function() { modal.hidden = true; };
          body.querySelectorAll('button[data-rescue]').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              if (!confirm('¿Confirmar misión de rescate hacia ' + btn.getAttribute('data-rescue') + '?')) return;
              btn.disabled = true;
              btn.textContent = 'Enviando…';
              try {
                var depotEl = document.getElementById('depotRuteo');
                var cres = await fetch('/api/lead-rescue/confirm', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_trip_id: tripId,
                    rescue_trip_id: btn.getAttribute('data-rescue'),
                    alert_id: alertId ? Number(alertId) : null,
                    depot_id: depotEl ? depotEl.value : null,
                  }),
                });
                var cdata = await cres.json();
                if (!cres.ok || !cdata.exito) throw new Error(cdata.error || 'Fallo al confirmar');
                alert(cdata.mensaje || 'Rescate despachado');
                modal.hidden = true;
                if (typeof actualizarViajesSilencioso === 'function') actualizarViajesSilencioso();
              } catch (err) {
                alert('Error rescate: ' + err.message);
                btn.disabled = false;
                btn.textContent = 'Enviar misión';
              }
            });
          });
        } catch (err) {
          body.innerHTML = '<p style="color:#fca5a5;">Error: ' +
            String(err.message || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>' +
            '<button type="button" class="btn" id="leadRescueClose">Cerrar</button>';
          var closeBtn = document.getElementById('leadRescueClose');
          if (closeBtn) closeBtn.onclick = function() { modal.hidden = true; };
        }
      };

      // Global: Ruta Rápida y otros scripts reinician el poll al cerrar modales
      const actualizarViajesSilencioso = async () => {
        // Regla §5: Polling condicionado — pausar si la pestaña no está activa
        if (document.hidden) return;

        try {
          // Regla §3: Lectura defensiva del tenant — nunca lanza ReferenceError
          const tId = (typeof window !== 'undefined' && window._TENANT_ID)
            ? window._TENANT_ID
            : 'empresa_base';

          const res = await fetch('/api/control-tower-viajes?tenant_id=' + encodeURIComponent(tId), {
            credentials: 'same-origin'
          });
          if (res.status === 401) {
            window.location.href = '/login';
            return;
          }
          if (!res.ok) {
            var errBody = await res.json().catch(function() { return {}; });
            console.error('[LIVE VIAJES] HTTP', res.status, errBody.error || errBody);
            var syncHttp = document.getElementById('syncStatus');
            if (syncHttp) {
              syncHttp.textContent = '🔴 Error flota (' + res.status + ')';
              syncHttp.style.color = '#fca5a5';
            }
            return;
          }
          const data = await res.json();

          if (!data.exito) return;

          // Actualizar estado en memoria PRIMERO, luego re-renderizar
          window.viajesActivos = data.viajes;
          window._fleetAlerts = Array.isArray(data.fleet_alerts) ? data.fleet_alerts : [];
          if (typeof window.renderLeadRescueBanner === 'function') {
            window.renderLeadRescueBanner(window._fleetAlerts);
          }

          var syncStatusEl = document.getElementById('syncStatus');
          if (syncStatusEl) {
            var TERMINALES_SYNC = ['ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'];
            var nViajes = Array.isArray(data.viajes) ? data.viajes.filter(function(v) {
              var pars = v.detalle_paradas || [];
              return !(pars.length > 0 && pars.every(function(p) {
                return TERMINALES_SYNC.indexOf(p.estado_operacional) !== -1;
              }));
            }).length : 0;
            var nAlerts = window._fleetAlerts.length;
            var alertBit = nAlerts ? (' · 🆘 ' + nAlerts + ' alerta' + (nAlerts === 1 ? '' : 's')) : '';
            syncStatusEl.textContent = '🟢 En línea · ' + nViajes + ' viaje' + (nViajes === 1 ? '' : 's') + alertBit;
            syncStatusEl.style.color = nAlerts ? '#fca5a5' : '#86efac';
            syncStatusEl.style.borderColor = nAlerts ? '#991b1b' : '#166534';
          }

          if (Array.isArray(data.choferes) && data.choferes.length) {
            window._listaChoferes = data.choferes;
          }

          // Sincronizar lat/lng de paradas de viajes activos en ordenesData
          // (el mapa dibuja desde ordenesData; sin esto las rutas quedan vacías tras el poll).
          if (Array.isArray(data.viajes)) {
            data.viajes.forEach(function(v) {
              var detalle = v.detalle_paradas || [];
              detalle.forEach(function(p) {
                if (!p || !p.ot_id) return;
                var lat = p.lat != null ? Number(p.lat) : NaN;
                var lng = p.lng != null ? Number(p.lng) : NaN;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                  var m = p.metadata;
                  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = null; } }
                  if (m && typeof m === 'object') {
                    lat = Number(m.lat_destino != null ? m.lat_destino : m.lat);
                    lng = Number(m.lng_destino != null ? m.lng_destino : m.lng);
                  }
                }
                var hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
                var existing = ordenesData.find(function(o) { return o.ot_id === p.ot_id; });
                if (existing) {
                  existing.trip_id = v.trip_id;
                  if (hasCoords) { existing.lat = lat; existing.lng = lng; }
                  if (p.stop_sequence != null) existing.stop_sequence = p.stop_sequence;
                  if (p.estado_operacional) existing.estado_operacional = p.estado_operacional;
                  if (p.metadata) existing.metadata = p.metadata;
                } else {
                  ordenesData.push({
                    ot_id: p.ot_id,
                    cliente: p.cliente,
                    trip_id: v.trip_id,
                    lat: hasCoords ? lat : null,
                    lng: hasCoords ? lng : null,
                    stop_sequence: p.stop_sequence,
                    estado_operacional: p.estado_operacional,
                    monto_total: p.monto_total || p.valor,
                    metadata: p.metadata,
                  });
                }
              });
            });
          }

          // --- ACTUALIZAR ÓRDENES PENDIENTES EN MEMORIA ---
          // El servidor devuelve las órdenes sin viaje (PENDIENTE_RUTEO / CAMION_ASIGNADO)
          // para que no desaparezcan del panel ni del mapa entre ciclos de polling.
          if (Array.isArray(data.ordenes_pendientes)) {
            // Reemplazar en ordenesData solo las filas sin trip_id,
            // preservando las que ya tienen trip asignado (están en viajesActivos).
            var conViaje = ordenesData.filter(function(o) { return o.trip_id != null; });
            // Mezclar: viaje asignado viene del snapshot inicial, sin viaje viene del servidor fresco
            data.ordenes_pendientes.forEach(function(oFresh) {
              var idx = conViaje.findIndex(function(o) { return o.ot_id === oFresh.ot_id; });
              if (idx === -1) conViaje.push(oFresh);
              else conViaje[idx] = oFresh;
            });
            // Vaciar y repoblar el array en lugar de reasignar (const no permite reasignación)
            ordenesData.length = 0;
            conViaje.forEach(function(o) { ordenesData.push(o); });
            data.ordenes_pendientes.forEach(function(o) {
              if (!ordenesData.find(function(x) { return x.ot_id === o.ot_id; })) {
                ordenesData.push(o);
              }
            });

            // Actualizar contador del tab Backlog
            var backlogCount = data.ordenes_pendientes.length;
            document.querySelectorAll('.tab-btn').forEach(function(btn) {
              if (btn.dataset.target === 'panel-backlog') {
                btn.textContent = '📋 Backlog (' + backlogCount + ')';
              }
            });

            // Actualizar panel backlog si no está activo (para no interrumpir al operador)
            var panelBacklog = document.getElementById('panel-backlog');
            if (panelBacklog && !panelBacklog.classList.contains('active')) {
              var backlogHtml = data.ordenes_pendientes.length === 0
                ? '<div style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.85rem;">Sin órdenes pendientes de ruteo.</div>'
                : data.ordenes_pendientes.map(function(o) {
                    var metaB = {};
                    try { metaB = o.metadata ? (typeof o.metadata === 'string' ? JSON.parse(o.metadata) : o.metadata) : {}; } catch(e) {}
                    var tagsB = (metaB.routing && metaB.routing.tags_viaje_exigidos) || [];
                    var money = function(v) { return '$' + Number(v || 0).toLocaleString('es-CL'); };
                    var escB = function(s) {
                      return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                    };
                    return '<div class="backlog-item">' +
                      '<div style="display:flex;justify-content:space-between;">' +
                        '<div>' +
                          '<div style="font-weight:700;font-size:0.9rem;display:flex;align-items:center;flex-wrap:wrap;gap:4px;">' +
                            escB(o.cliente) +
                            tagsB.map(function(t) { return '<span class="badge b-neutral" style="font-size:0.65rem;">' + escB(t) + '</span>'; }).join('') +
                          '</div>' +
                          '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">' + escB(o.ot_id) + '</div>' +
                        '</div>' +
                        '<div style="color:var(--success);font-weight:800;">' + money(o.monto_total || o.valor_oc_clp) + '</div>' +
                      '</div>' +
                    '</div>';
                  }).join('');
              panelBacklog.innerHTML = backlogHtml;
            }

            // Refrescar marcadores de backlog en el mapa
            if (typeof map !== 'undefined' && map && typeof window._backlogLayer !== 'undefined') {
              window._backlogLayer.clearLayers();
              data.ordenes_pendientes.forEach(function(o) {
                var latNum = Number(o.lat);
                var lngNum = Number(o.lng);
                if (o.lat != null && o.lng != null && !isNaN(latNum) && !isNaN(lngNum)) {
                  L.circleMarker([latNum, lngNum], {
                    radius: 5, fillColor: 'var(--warning)', color: '#fff', weight: 1.5, fillOpacity: 0.9
                  }).addTo(window._backlogLayer);
                }
              });
            }
          }

          // Actualizar contenido del panel de flota
          const container = document.getElementById('panel-flota');
          const viajeActivoAntes = appState.activeTripId;

          if (container && typeof window.renderPanelFlota === 'function') {
            container.innerHTML = window.renderPanelFlota(window.viajesActivos);
            // Contador Flota = solo viajes visibles (no 100% terminales)
            var TERMINALES_CNT = ['ENTREGADO', 'RECHAZADO', 'CANCELADO_PLANILLA', 'RETORNO_BODEGA'];
            var flotaVisible = (window.viajesActivos || []).filter(function(v) {
              var pars = v.detalle_paradas || [];
              return !(pars.length > 0 && pars.every(function(p) {
                return TERMINALES_CNT.indexOf(p.estado_operacional) !== -1;
              }));
            }).length;
            document.querySelectorAll('.tab-btn').forEach(function(btn) {
              if (btn.dataset.target === 'panel-flota') {
                btn.textContent = '🚚 Flota (' + flotaVisible + ')';
              }
            });
          }

          // Restaurar el viaje activo si la card sigue existiendo tras el re-render
          if (viajeActivoAntes && document.getElementById('card-' + viajeActivoAntes)) {
            appState.activeTripId = viajeActivoAntes;
          }
          // T5: reaplicar filtro de búsqueda tras el re-render (puede ocultar el activo)
          if (appState.searchTerm) {
            actualizarUI('searchTerm', appState.searchTerm);
          }
        } catch(e) {
          // Regla §6: Errores de polling silenciosos — no interrumpir la UI
          console.error('[LIVE VIAJES]', e);
          var syncFail = document.getElementById('syncStatus');
          if (syncFail) {
            syncFail.textContent = '🔴 Error al sincronizar flota';
            syncFail.style.color = '#fca5a5';
          }
        }
      };

            if (window.viajesRefreshTimer) {
              clearInterval(window.viajesRefreshTimer);
              window.viajesRefreshTimer = null;
            }

            window.actualizarViajesSilencioso = actualizarViajesSilencioso;
            window.viajesRefreshTimer =
            setInterval(actualizarViajesSilencioso, 5000);
            // Primer fetch inmediato (no esperar 5s) — cubre shell vacío tras timeout SSR
            actualizarViajesSilencioso();

            const gpsSelect = document.getElementById('gpsInterval');
            if (gpsSelect) {
              gpsSelect.addEventListener('change', (e) => {
                const nuevoValor = parseInt(e.target.value);
                configurarIntervaloGps(nuevoValor);
              });
            }

            // TABS
            document.querySelectorAll('.tab-btn').forEach(tab => {
                tab.addEventListener('click', (e) => appState.activeTab = e.target.dataset.target);
            });

            const searchInput = document.getElementById('tripSearch');
            if(searchInput) {
                let debounceTimer;
                searchInput.addEventListener('input', (e) => {
                  clearTimeout(debounceTimer);
                  debounceTimer = setTimeout(() => { appState.searchTerm = e.target.value; }, 200);
                });
            }

              const panelFlota = document.getElementById('panel-flota');
              if(panelFlota) {
                panelFlota.addEventListener('click', (e) => {
                  const chatBtn = e.target.closest('.btn-chat-trigger');
                  if (chatBtn) {
                    e.stopPropagation();
                    e.preventDefault();
                    if (typeof window.abrirChat === 'function') {
                      window.abrirChat(chatBtn);
                    }
                    return;
                  }
                  
                  const shareBtn = e.target.closest('.btn-share-route');
                  if (shareBtn) {
                    console.log('[DEBUG] Click detectado en botón compartir!', shareBtn);
                    e.stopPropagation();
                    e.preventDefault();
                    if (typeof window.generarEnlacePublico === 'function') {
                      console.log('[DEBUG] Llamando a window.generarEnlacePublico');
                      window.generarEnlacePublico(shareBtn);
                    } else {
                      console.error('[ERROR] window.generarEnlacePublico NO está definida');
                    }
                    return;
                  }

                  const upBtn = e.target.closest('.btn-stop-up');
                  const downBtn = e.target.closest('.btn-stop-down');
                  const moveBtn = e.target.closest('.btn-stop-move');
                  if (upBtn || downBtn || moveBtn) {
                    e.stopPropagation();
                    e.preventDefault();
                    var btn = upBtn || downBtn || moveBtn;
                    var tripId = btn.getAttribute('data-trip');
                    var otId = btn.getAttribute('data-ot');
                    var flota = window.viajesActivos || [];
                    var viaje = flota.find(function(v) { return String(v.trip_id) === String(tripId); });
                    if (!viaje) return;
                    var abiertas = (viaje.detalle_paradas || []).filter(function(p) {
                      var st = String(p.estado_operacional || '').toUpperCase();
                      return st !== 'ENTREGADO' && st !== 'RECHAZADO' && st !== 'EN_SITIO' && st !== 'CANCELADO_PLANILLA';
                    });
                    var ids = abiertas.map(function(p) { return String(p.ot_id); });
                    var idx = ids.indexOf(String(otId));
                    if (idx < 0) return;

                    if (moveBtn) {
                      var otros = flota
                        .map(function(v) { return String(v.trip_id); })
                        .filter(function(id) { return id !== String(tripId); });
                      if (!otros.length) { alert('No hay otro viaje destino'); return; }
                      var dest = prompt('Mover a viaje (trip_id):\\n' + otros.join('\\n'), otros[0]);
                      if (!dest) return;
                      fetch('/api/trips/move-stop', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ot_id: otId, to_trip_id: dest }),
                      }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
                        .then(function(res) {
                          if (!res.ok || !res.d.exito) throw new Error(res.d.error || 'Fallo al mover');
                          if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
                          if (typeof actualizarViajesSilencioso === 'function') actualizarViajesSilencioso();
                        })
                        .catch(function(err) { alert('Error: ' + err.message); });
                      return;
                    }

                    if (upBtn && idx > 0) {
                      var tmp = ids[idx - 1]; ids[idx - 1] = ids[idx]; ids[idx] = tmp;
                    } else if (downBtn && idx < ids.length - 1) {
                      var tmp2 = ids[idx + 1]; ids[idx + 1] = ids[idx]; ids[idx] = tmp2;
                    } else {
                      return;
                    }
                    fetch('/api/trips/reorder', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ trip_id: tripId, ot_ids: ids }),
                    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
                      .then(function(res) {
                        if (!res.ok || !res.d.exito) throw new Error(res.d.error || 'Fallo al reordenar');
                        if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
                        if (typeof actualizarViajesSilencioso === 'function') actualizarViajesSilencioso();
                      })
                      .catch(function(err) { alert('Error: ' + err.message); });
                    return;
                  }
                  
                  if (
                    e.target.closest('.chofer-select') ||
                    e.target.closest('.gps-interval-select')
                  ) return;

                  const card = e.target.closest('.trip-card');
                  if (!card) return;

                  const safeTrip = card.dataset.safeTrip;

                  if (appState.activeTripId === safeTrip) {
                    appState.activeTripId = null;
                  } else {
                    appState.activeTripId = safeTrip;
                  }
                }, true); // CAPTURING PHASE: Captura el click ANTES que los hijos

              panelFlota.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.target.classList.contains('trip-card')) {
                  e.preventDefault();
                  appState.activeTripId = (appState.activeTripId === e.target.dataset.safeTrip) ? null : e.target.dataset.safeTrip;
                }
              });

              panelFlota.addEventListener('change', async (e) => {
                const select = e.target.closest('.chofer-select');
                if (!select) return;
                if (select.disabled || select.classList.contains('locked')) return;

                const tripId = decodeURIComponent(select.dataset.realTrip);
                const safeTripId = select.closest('.trip-card').dataset.safeTrip;
                const choferId = select.value;
                const statusSpan = document.getElementById('save-status-' + safeTripId);
                const desasignar = !choferId;

                select.disabled = true;
                statusSpan.textContent = desasignar ? 'Desasignando...' : 'Guardando...';
                statusSpan.style.display = 'block';

                try {
                  const res = await fetch('/api/gps/assign-driver', { 
                    method: 'POST',
                    credentials: 'same-origin',
                    redirect: 'manual',
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ 
                      tenant_id: window._TENANT_ID || 'empresa_base',
                      trip_id: tripId, 
                      chofer_id: choferId || null,
                      unassign: desasignar
                    }) 
                  });
                  if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
                    throw new Error('Sesión Cloudflare Access vencida o bloqueando la API. Recargá la página (Ctrl+F5) e iniciá sesión de nuevo.');
                  }
                  const data = await res.json().catch(function() { return {}; });
                  if (!res.ok || !data.exito) {
                    throw new Error(data.error || data.detalle || ("Falla al asignar (HTTP " + res.status + ")"));
                  }

                  select.dataset.previous = choferId || '';
                  window._choferPin = window._choferPin || {};
                  if (desasignar) {
                    select.classList.remove('assigned');
                    window._choferPin[String(tripId)] = '';
                    if (Array.isArray(window.viajesActivos)) {
                      window.viajesActivos.forEach(function(v) {
                        if (String(v.trip_id) === String(tripId)) {
                          v.chofer_id = null;
                          v.chofer = 'Sin Asignar';
                        }
                      });
                    }
                  } else {
                    select.classList.add('assigned');
                    window._choferPin[String(tripId)] = String(choferId);
                    if (Array.isArray(window.viajesActivos)) {
                      window.viajesActivos.forEach(function(v) {
                        if (String(v.trip_id) === String(tripId)) {
                          v.chofer_id = choferId;
                          if (data.nombre) v.chofer = data.nombre;
                        }
                      });
                    }
                  }
                  statusSpan.textContent = desasignar ? '✅ Sin chofer' : '✅ Guardado'; 
                  setTimeout(() => statusSpan.style.display = 'none', 2000);
                } catch (err) {
                  select.value = select.dataset.previous;
                  statusSpan.style.display = 'none';
                  var msg = err && err.message ? err.message : String(err);
                  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
                    msg = 'No se pudo contactar al servidor (Failed to fetch). Suele ser Cloudflare Access pidiendo login otra vez: Ctrl+F5 y reingresá. Si sigue, avisá.';
                  }
                  alert("Error: " + msg);
                } finally { select.disabled = false; }
              });
              const btnSend = document.getElementById('btnSendChat');
              if (btnSend) {
                btnSend.addEventListener('click', window.enviarMensajeChat);
              }

              const chatInput = document.getElementById('chatInput');
              if (chatInput) {
                chatInput.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    window.enviarMensajeChat();
                  }
                });
              }
              // NUEVO LISTENER: Control remoto de la frecuencia GPS de la App Móvil
              panelFlota.addEventListener('change', async (e) => {
                if (e.target.classList.contains('gps-interval-select')) {
                  const select = e.target;
                  const rut = select.dataset.rut;
                  const nuevoIntervalo = parseInt(select.value);
                  const originalBorder = select.style.borderColor;

                  // Feedback UI: Amarillo = Guardando
                  select.style.borderColor = '#f59e0b'; 
                  select.disabled = true;

                  try {
                    const res = await fetch('/api/admin/config-gps', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        tenant_id: window._TENANT_ID || 'empresa_base',
                        rut: rut,
                        nuevo_intervalo_segundos: nuevoIntervalo
                      })
                    });

                    const data = await res.json();
                    if (!res.ok || !data.exito) throw new Error(data.error);

                    // Feedback UI: Verde = Guardado Exitoso
                    select.style.borderColor = '#10b981'; 
                    setTimeout(() => select.style.borderColor = originalBorder, 2000);
                  } catch (err) {
                    // Feedback UI: Rojo = Error
                    select.style.borderColor = '#ef4444'; 
                    alert("Error cambiando GPS: " + err.message);
                  } finally {
                    select.disabled = false;
                  }
                }
              });
            }
            
            if (typeof localStorage !== 'undefined') {
              const savedExcelUrl = localStorage.getItem('excelSyncUrl');
              if (savedExcelUrl) document.getElementById('excelUrl').value = savedExcelUrl;
            }

            document.getElementById('btnSync').addEventListener('click', async (e) => {
              const excelInput = document.getElementById('excelUrl').value.trim();
              const aceptaFileInput = document.getElementById('aceptaFile');
              const aceptaFile = aceptaFileInput ? aceptaFileInput.files[0] : null;
              
              if (!excelInput) { alert("Ingresa una URL de Google Sheets válida para iniciar el proceso."); return; }
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('excelSyncUrl', excelInput);
              }
          
              const btn = e.target;
              const originalText = btn.textContent;
              btn.disabled = true; btn.textContent = '⏳ Procesando...'; 
              
              try {
                const formData = new FormData();
                formData.append('tenant_id', window._TENANT_ID || 'empresa_base');
                formData.append('url_secreta', excelInput);
                if (aceptaFile) {
                    formData.append('acepta_file', aceptaFile);
                }
                
                const res = await fetch('/api/sync-excel', {
                  method: 'POST',
                  credentials: 'same-origin',
                  body: formData
                });
                
                const data = await res.json();
                if (res.ok && data.exito) { 
                    alert(data.msg || "Cruce y Sincronización exitosa"); 
                    if (typeof actualizarViajesSilencioso === 'function') actualizarViajesSilencioso(); 
                } else { throw new Error(data.error || "Falla en la sincronización cruzada."); }
              } catch (err) { alert("Error: " + err.message); } 
              finally { btn.disabled = false; btn.textContent = originalText; }
            });

            document.getElementById('btnOptimize').addEventListener('click', async (e) => {
              const esHoy = CONFIG.last_sync_date && new Date(CONFIG.last_sync_date).toDateString() === new Date().toDateString();
              if (!esHoy && !confirm("⚠️ La base de datos NO se ha sincronizado hoy. ¿Rutear de todas formas?")) return;
              if (esHoy && !confirm("¿Iniciar motor de ruteo con la flota seleccionada?")) return;
              
              const btn = e.target;
              const originalText = btn.textContent;
              btn.disabled = true; btn.textContent = '⏳ Optimizando...'; 
              
              try {
                // [NUEVO: CAPTURA DEL SELECTOR DE CLIMA EN EL JSON BODY]
                const res = await fetch('/api/optimizar-rutas', { 
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' }, 
                  body: JSON.stringify({ 
                    tenant_id: window._TENANT_ID || 'empresa_base',
                    perfil_id: document.getElementById('perfilRuteo').value, 
                    flota_disponible: document.getElementById('camionesDisponibles').value,
                    clima: document.getElementById('climaRuteo').value,
                    depot_id: (document.getElementById('depotRuteo') || {}).value || null,
                    is_simulacion: false 
                  }) 
                });
                const data = await res.json();
                
                if (res.ok && (data.exito || data.viajes_creados > 0)) {
                  alert(data.viajes_creados + " viajes armados exitosamente.");
                  if (typeof actualizarViajesSilencioso === 'function') actualizarViajesSilencioso();
                } else { throw new Error(data.msg || data.error); }
              } catch (err) { alert("Error: " + err.message); } 
              finally { btn.disabled = false; btn.textContent = originalText; }
            });

            const depotSel = document.getElementById('depotRuteo');
            if (depotSel) {
              depotSel.addEventListener('change', function () {
                const id = this.value;
                const list = (CONFIG && CONFIG.depots) || [];
                const d = list.find(function (x) { return x.depot_id === id; });
                if (!d || !CONFIG) return;
                CONFIG.BODEGA = {
                  LAT: Number(d.lat),
                  LNG: Number(d.lng),
                  NOMBRE: d.nombre || 'Bodega',
                  depot_id: d.depot_id
                };
              });
            }

            const btnReopt = document.getElementById('btnReoptMidday');
            if (btnReopt) {
              btnReopt.addEventListener('click', async (e) => {
                if (!confirm('¿Re-optimizar mediodía?\\nInserta pedidos PENDIENTE_RUTEO en rutas ya activas.\\nNo mueve entregas EN_SITIO/ENTREGADO ni borra la flota.')) return;
                const btn = e.target;
                const originalText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ Re-opt...';
                try {
                  const res = await fetch('/api/reoptimizar-midday', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      clima: document.getElementById('climaRuteo').value,
                      perfil_id: document.getElementById('perfilRuteo').value,
                      depot_id: (document.getElementById('depotRuteo') || {}).value || null,
                      allow_new_trips: true,
                    }),
                  });
                  const data = await res.json();
                  if (!res.ok || !data.exito) throw new Error(data.error || data.mensaje || 'Fallo re-opt');
                  if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
                  alert(
                    (data.mensaje || 'Listo') +
                    '\\nInsertados: ' + (data.insertados || 0) +
                    ' | Viajes nuevos: ' + (data.viajes_nuevos || 0) +
                    ' | Sin asignar: ' + (data.sin_asignar || 0)
                  );
                  if (typeof actualizarViajesSilencioso === 'function') actualizarViajesSilencioso();
                } catch (err) {
                  alert('Error re-opt: ' + err.message);
                } finally {
                  btn.disabled = false;
                  btn.textContent = originalText;
                }
              });
            }

            if (viajesData.length > 0) {
              const firstId = 'trip_' + Array.from(String(viajesData[0].trip_id)).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
              setTimeout(() => { appState.activeTripId = firstId; }, 150);
            } else {
                appState.activeTab = 'panel-backlog';
            }

            const aiWidget = document.getElementById('ai-copilot-widget');
            if (aiWidget) {
              const aiToggle = document.getElementById('ai-widget-toggle');
              if (aiToggle) {
                aiToggle.addEventListener('click', function() {
                  aiWidget.classList.toggle('collapsed');
                  const icon = this.querySelector('.toggle-icon');
                  if (icon) icon.textContent = aiWidget.classList.contains('collapsed') ? '▲' : '▼';
                });
              }

              const btnAiAction = document.getElementById('btn-ai-action');
              if (btnAiAction) {
                btnAiAction.addEventListener('click', function() {
                  const btn = this;
                const resultDiv = document.getElementById('ai-result');
                
                if (btn.disabled) return;
                
                btn.disabled = true;
                btn.innerHTML = '<span class="ai-spinner"></span> Analizando telemetría...';
                resultDiv.style.display = 'none';

                setTimeout(() => {
                  btn.innerHTML = '🔄 Actualizar Plan';
                  btn.disabled = false;
                  resultDiv.innerHTML = 
                    '<strong style="color: #6366f1; font-size: 0.85rem;">🤖 Plan de Mitigación:</strong><br><br>' +
                    '<span style="font-size: 0.75rem;">' +
                    '1. <b>Notificación Proactiva:</b> Enviar SMS a los clientes afectados para gestionar expectativas.<br>' +
                    '2. <b>Ajuste de Ruteo:</b> Sugiero transferir las últimas 2 paradas de la unidad retrasada a la flota de <i>back-up</i> más cercana para estabilizar la ruta original.<br>' +
                    '3. <b>Contacto Operador:</b> Contactar al chofer para descartar anomalías no reportadas (tráfico/falla mecánica).' +
                    '</span>';
                    
                  resultDiv.style.display = 'block';
                }, 2000);
                }); // cierra addEventListener
              } // cierra if (btnAiAction)
            } // cierra if (aiWidget)

            // Los listeners de btnSendChat y chatInput ya están registrados
            // dentro del bloque panelFlota más arriba. No se duplican aquí.
            // (Bug corregido: doble registro causaba envío duplicado de mensajes)

          } catch (e) {
            console.error("[DEFENSIVO] Error catastrófico en la inicialización de la interfaz:", e);
          } finally {
            // Badge inicial: no usar "Offline" solo porque falta last_sync de Excel.
            // El poll actualizará a "En línea" o "Error al sincronizar".
            const syncStatus = document.getElementById('syncStatus');
            if (syncStatus && syncStatus.textContent.indexOf('En línea') === -1
                && syncStatus.textContent.indexOf('Error') === -1) {
                const serverLastSync = CONFIG.last_sync_date;
                syncStatus.textContent = serverLastSync
                  ? '🟢 Sync ' + formatHoraCL(serverLastSync)
                  : '🟡 Conectando…';
            }
          }
        });

`;
