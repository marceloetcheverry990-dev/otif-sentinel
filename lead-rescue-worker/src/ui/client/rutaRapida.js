// src/ui/client/rutaRapida.js
// Modal Ruta Rapida y edicion de direccion SPOT-.
// Extraido de src/ui.js Script #2 (Fase 3, Req 4). No ejecutar en el Worker.

// String.raw: sin esto, \d y \s del JS embebido se corrompen a "d"/"s" en el navegador.
export const RUTA_RAPIDA_SCRIPT = String.raw`
        var RR_MAX_PARADAS = 24;

        function rrFetch(url, options) {
          var opts = Object.assign({ credentials: 'same-origin' }, options || {});
          opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
          return fetch(url, opts);
        }

        function rrPoblarChoferes(choferes) {
          const selectChofer = document.getElementById('rrChofer');
          if (!selectChofer) return;
          const list = Array.isArray(choferes) ? choferes : [];
          // Preferir DISPONIBLE primero; OCUPADO queda marcado [EN RUTA]
          const sorted = list.slice().sort(function(a, b) {
            if (a.estado === b.estado) return String(a.nombre_completo || '').localeCompare(String(b.nombre_completo || ''));
            if (a.estado === 'DISPONIBLE') return -1;
            if (b.estado === 'DISPONIBLE') return 1;
            return 0;
          });
          selectChofer.innerHTML = '<option value="">-- Auto: usar N° de camiones del header --</option>' +
            sorted.map(function(c) {
              var estadoLabel = c.estado === 'OCUPADO' ? ' [EN RUTA]' : '';
              var score = (c.skill_score != null ? c.skill_score : 'N/A');
              return '<option value="' + String(c.chofer_id).replace(/"/g, '') + '">' +
                String(c.nombre_completo || c.chofer_id).replace(/</g, '&lt;') +
                ' (Score: ' + score + ')' + estadoLabel + '</option>';
            }).join('');
        }

        async function rrRefrescarChoferes() {
          // Fallback: snapshot de página
          rrPoblarChoferes(window._listaChoferes || []);
          try {
            const res = await rrFetch('/api/control-tower-viajes?tenant_id=' + encodeURIComponent(window._TENANT_ID || 'empresa_base'), { method: 'GET', headers: {} });
            if (!res.ok) return;
            const data = await res.json();
            if (data && Array.isArray(data.choferes) && data.choferes.length) {
              window._listaChoferes = data.choferes;
              rrPoblarChoferes(data.choferes);
            }
          } catch (e) {
            console.warn('[RutaRapida] No se pudo refrescar choferes:', e.message);
          }
        }

        window.abrirRutaRapida = function(opts) {
          document.getElementById('modalRutaRapida').style.display = 'flex';
          if (window.viajesRefreshTimer) {
            clearInterval(window.viajesRefreshTimer);
            window.viajesRefreshTimer = null;
            window._pollingPausado = true;
          }
          document.getElementById('rrParadas').innerHTML = '';
          document.getElementById('rrChofer').value = '';
          document.getElementById('rrDescCarga').value = '';
          document.getElementById('rrCamionListo').checked = false;
          document.getElementById('rrValidacionPanel').style.display = 'none';
          window._rrCoordsCacheadas = [];
          var btnEnviar = document.getElementById('btnEnviarRR');
          btnEnviar.disabled = true;
          btnEnviar.style.background = '#334155';
          btnEnviar.style.color = '#64748b';
          btnEnviar.style.cursor = 'not-allowed';
          btnEnviar.style.opacity = '0.5';
          document.getElementById('btnValidarRR').disabled = false;
          document.getElementById('btnValidarRR').textContent = '🔍 Validar Direcciones';
          rrRefrescarChoferes();
          if (opts && opts.fromVideo) {
            cargarBorradorVideoRR();
            return;
          }
          agregarParadaRR();
        };

        function rrEnableDespacho() {
          var panel = document.getElementById('rrValidacionPanel');
          var resumen = document.getElementById('rrValidacionResumen');
          if (panel) panel.style.display = 'block';
          if (resumen) {
            resumen.innerHTML = '<span style="color:#10b981;font-weight:800;">✅ Direcciones listas. Revisá peso, ventanas y tipo de carga; después Crear y Despachar.</span>';
          }
          var btnEnviar = document.getElementById('btnEnviarRR');
          if (btnEnviar) {
            btnEnviar.disabled = false;
            btnEnviar.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
            btnEnviar.style.color = 'white';
            btnEnviar.style.cursor = 'pointer';
            btnEnviar.style.opacity = '1';
          }
        }

        async function cargarBorradorVideoRR() {
          var loadSeq = (window._rrDraftLoadSeq || 0) + 1;
          window._rrDraftLoadSeq = loadSeq;
          try {
            // Limpiar Flota/Backlog sucios para que el take del video empiece limpio (sin CLI)
            try {
              await rrFetch('/api/admin/qa/video-prep', {
                method: 'POST',
                body: JSON.stringify({ mode: 'empty' }),
              });
              if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
              if (typeof window.actualizarViajesSilencioso === 'function') {
                await window.actualizarViajesSilencioso();
              }
            } catch (_) { /* si falla el wipe, igual cargamos el borrador */ }

            const res = await rrFetch('/api/admin/qa/video-prep?mode=ruta_rapida_draft', { method: 'GET', headers: {} });
            const data = await res.json().catch(function() { return {}; });
            if (window._rrDraftLoadSeq !== loadSeq) return;
            const draft = data && data.draft;
            if (!draft || !Array.isArray(draft.paradas) || !draft.paradas.length) {
              document.getElementById('rrParadas').innerHTML = '';
              agregarParadaRR();
              return;
            }
            document.getElementById('rrParadas').innerHTML = '';
            document.getElementById('rrDescCarga').value = draft.descripcion_carga || '';
            document.getElementById('rrCamionListo').checked = draft.camion_listo !== false;
            var nCamEl = document.getElementById('camionesDisponibles');
            if (nCamEl) nCamEl.value = '3';
            var perfilEl = document.getElementById('perfilRuteo');
            if (perfilEl) {
              var eq = Array.from(perfilEl.options).find(function(o) {
                return /equilibrad/i.test(o.text || '');
              });
              if (eq) perfilEl.value = eq.value;
            }
            window._rrCoordsCacheadas = [];
            draft.paradas.forEach(function(p) {
              agregarParadaRR();
              var el = document.getElementById('rrParadas').lastElementChild;
              if (!el) return;
              if (el.querySelector('.rr-cliente')) el.querySelector('.rr-cliente').value = p.cliente || '';
              if (el.querySelector('.rr-telefono')) el.querySelector('.rr-telefono').value = p.telefono || '';
              if (el.querySelector('.rr-email')) el.querySelector('.rr-email').value = p.email || '';
              if (el.querySelector('.rr-peso')) el.querySelector('.rr-peso').value = p.peso_kg != null ? p.peso_kg : '';
              if (el.querySelector('.rr-volumen')) el.querySelector('.rr-volumen').value = p.volumen != null ? p.volumen : '';
              if (el.querySelector('.rr-direccion')) {
                el.querySelector('.rr-direccion').value = p.direccion || '';
                if (p.lat != null) el.querySelector('.rr-direccion').dataset.lat = String(p.lat);
                if (p.lng != null) el.querySelector('.rr-direccion').dataset.lng = String(p.lng);
                el.querySelector('.rr-direccion').dataset.display = p.direccion || '';
              }
              if (el.querySelector('.rr-descripcion')) el.querySelector('.rr-descripcion').value = p.descripcion || '';
              if (el.querySelector('.rr-monto')) el.querySelector('.rr-monto').value = p.monto != null ? p.monto : '';
              if (el.querySelector('.rr-sla-hora')) el.querySelector('.rr-sla-hora').value = p.sla_hora || '18:00';
              if (el.querySelector('.rr-ventana-inicio')) el.querySelector('.rr-ventana-inicio').value = p.ventana_inicio || '';
              var tag = Array.isArray(p.tags) && p.tags[0] ? p.tags[0] : '';
              if (el.querySelector('.rr-tags')) el.querySelector('.rr-tags').value = tag;
              el.style.border = '1px solid #10b981';
              window._rrCoordsCacheadas.push({
                lat: p.lat, lng: p.lng, display: p.direccion, precision: p.precision || 'house'
              });
            });
            rrEnableDespacho();
            var btnValidar = document.getElementById('btnValidarRR');
            if (btnValidar) { btnValidar.disabled = false; btnValidar.textContent = '🔄 Re-validar'; }
          } catch (e) {
            if (window._rrDraftLoadSeq !== loadSeq) return;
            document.getElementById('rrParadas').innerHTML = '';
            agregarParadaRR();
          }
        }

        window.cerrarRutaRapida = function() {
          document.getElementById('modalRutaRapida').style.display = 'none';
          // Reanudar el polling si fue pausado
          if (window._pollingPausado) {
            window._pollingPausado = false;
            if (typeof window.actualizarViajesSilencioso === 'function') {
              if (window.viajesRefreshTimer) clearInterval(window.viajesRefreshTimer);
              window.viajesRefreshTimer = setInterval(window.actualizarViajesSilencioso, 5000);
              window.actualizarViajesSilencioso();
            }
          }
        };

        window.agregarParadaRR = function() {
          const container = document.getElementById('rrParadas');
          if (container.children.length >= RR_MAX_PARADAS) {
            alert('Máximo ' + RR_MAX_PARADAS + ' paradas por ruta rápida');
            return;
          }
          const idx = container.children.length + 1;
          const div = document.createElement('div');
          div.style.cssText = 'background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:10px;position:relative;';
          div.innerHTML = '<div style="font-size:0.75rem;font-weight:700;color:#64748b;margin-bottom:8px;text-transform:uppercase;">Parada ' + idx + '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
            '<input type="text" placeholder="Nombre cliente *" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-cliente" autocomplete="organization">' +
            '<input type="text" placeholder="Teléfono (opcional)" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-telefono" autocomplete="tel">' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
            '<input type="email" placeholder="Email (opcional)" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-email" autocomplete="email">' +
            '<select class="rr-tags" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:13px;background:#1e293b;color:#e2e8f0;" title="Tipo de carga — alimentos y peligrosa no van en el mismo camión">' +
            '<option value="">Carga general</option>' +
            '<option value="ALIMENTOS">Alimentos</option>' +
            '<option value="PELIGROSO">Carga peligrosa</option>' +
            '</select>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
            '<input type="number" placeholder="Peso kg" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-peso" min="0" step="0.1">' +
            '<input type="number" placeholder="Volumen m³" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-volumen" min="0" step="0.1">' +
            '</div>' +
            '<div class="rr-dir-wrap" style="position:relative;margin-bottom:8px;">' +
            '<input type="text" placeholder="Empezá a escribir la dirección..." style="width:100%;padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;box-sizing:border-box;background:#1e293b;color:#e2e8f0;" class="rr-direccion" autocomplete="off" spellcheck="false">' +
            '<div class="rr-ac-list" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;background:#0f172a;border:1px solid #475569;border-radius:8px;max-height:240px;overflow-y:auto;box-shadow:0 16px 32px rgba(0,0,0,0.55);"></div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;align-items:end;">' +
            '<input type="text" placeholder="Descripción bulto" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-descripcion">' +
            '<input type="number" placeholder="Monto (opcional)" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-monto">' +
            '<label style="display:flex;flex-direction:column;gap:4px;font-size:0.7rem;color:#94a3b8;font-weight:600;">Ventana desde<input type="time" min="00:00" max="23:59" step="60" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-ventana-inicio" title="Inicio de ventana horaria"></label>' +
            '<label style="display:flex;flex-direction:column;gap:4px;font-size:0.7rem;color:#94a3b8;font-weight:600;">Hora límite SLA<input type="time" value="18:00" min="00:00" max="23:59" step="60" style="padding:8px;border:1px solid #334155;border-radius:6px;font-size:14px;background:#1e293b;color:#e2e8f0;" class="rr-sla-hora" title="Hora del día (Chile) para cumplir el SLA"></label>' +
            '</div>' +
            (idx > 1 ? '<button onclick="this.parentElement.remove();renumerarParadas()" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;">✕</button>' : '');
          container.appendChild(div);
          bindDireccionAutocomplete(div.querySelector('.rr-direccion'));
          // Al agregar una parada, invalidar validación anterior
          document.getElementById('rrValidacionPanel').style.display = 'none';
          var btnEnviar = document.getElementById('btnEnviarRR');
          btnEnviar.disabled = true;
          btnEnviar.style.background = '#334155';
          btnEnviar.style.color = '#64748b';
          btnEnviar.style.cursor = 'not-allowed';
          btnEnviar.style.opacity = '0.5';
          var btnValidar = document.getElementById('btnValidarRR');
          if (btnValidar) { btnValidar.disabled = false; btnValidar.textContent = '🔍 Validar Direcciones'; }
        };

        function invalidateRRValidation() {
          var panel = document.getElementById('rrValidacionPanel');
          if (panel) panel.style.display = 'none';
          var btnEnviar = document.getElementById('btnEnviarRR');
          if (btnEnviar) {
            btnEnviar.disabled = true;
            btnEnviar.style.background = '#334155';
            btnEnviar.style.color = '#64748b';
            btnEnviar.style.cursor = 'not-allowed';
            btnEnviar.style.opacity = '0.5';
          }
          var btnValidar = document.getElementById('btnValidarRR');
          if (btnValidar) { btnValidar.disabled = false; btnValidar.textContent = '🔍 Validar Direcciones'; }
        }

        function bindDireccionAutocomplete(input) {
          if (!input || input.dataset.acBound === '1') return;
          input.dataset.acBound = '1';
          var wrap = input.closest('.rr-dir-wrap') || input.parentElement;
          var list = wrap.querySelector('.rr-ac-list');
          if (!list) return;

          var debounceTimer = null;
          var abortCtrl = null;

          function hideList() {
            list.style.display = 'none';
            list.innerHTML = '';
          }

          function showHint(msg, isError) {
            list.innerHTML = '';
            var d = document.createElement('div');
            d.style.cssText = 'padding:10px 12px;font-size:12px;color:' + (isError ? '#f87171' : '#94a3b8') + ';';
            d.textContent = msg;
            list.appendChild(d);
            list.style.display = 'block';
          }

          function setGeocodPreview(display, ok) {
            var stopEl = input.closest('[style*="position:relative"]') || wrap.parentElement;
            var existing = stopEl && stopEl.querySelector('.rr-geocod-result');
            if (existing) existing.remove();
            if (!display || !stopEl) return;
            var conf = document.createElement('div');
            conf.className = 'rr-geocod-result';
            conf.style.cssText = 'font-size:11px;margin-top:4px;padding:4px 8px;border-radius:4px;' +
              (ok
                ? 'color:#10b981;background:rgba(16,185,129,0.1);'
                : 'color:#fbbf24;background:rgba(245,158,11,0.1);');
            conf.textContent = (ok ? '✅ ' : '💡 ') + display.substring(0, 90) + (display.length > 90 ? '…' : '');
            wrap.parentNode.insertBefore(conf, wrap.nextSibling);
          }

          function parseAddressQuery(q) {
            var cleaned = String(q || '').trim().replace(/\s+/g, ' ');
            // Extraer el ÚLTIMO número suelto como N° de casa (más robusto que un solo regex).
            var parts = cleaned.split(/\s+/);
            var number = '';
            var numberIdx = -1;
            for (var i = parts.length - 1; i >= 0; i--) {
              var token = parts[i].replace(/^,|,$/g, '');
              if (/^\d{1,6}[A-Za-z]?$/i.test(token)) {
                number = token;
                numberIdx = i;
                break;
              }
            }
            if (numberIdx < 0) {
              return { street: cleaned, number: '', place: '', raw: cleaned };
            }
            var street = parts.slice(0, numberIdx).join(' ').replace(/,\s*$/, '').trim();
            var place = parts.slice(numberIdx + 1).join(' ').replace(/^,\s*/, '').trim();
            return { street: street, number: number, place: place, raw: cleaned };
          }

          function sameHouseNumber(a, b) {
            if (a == null || b == null || a === '' || b === '') return false;
            return String(a).replace(/\s/g, '').toLowerCase() === String(b).replace(/\s/g, '').toLowerCase();
          }

          function pickSuggestion(display, lat, lng, note, verified) {
            input.value = display;
            if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
              input.dataset.lat = String(lat);
              input.dataset.lng = String(lng);
            } else {
              delete input.dataset.lat;
              delete input.dataset.lng;
            }
            input.dataset.display = display;
            input.dataset.verified = verified ? '1' : '0';
            input.style.border = verified ? '1px solid #10b981' : '1px solid #f59e0b';
            hideList();
            setGeocodPreview(note ? (display + ' — ' + note) : display, !!verified);
            invalidateRRValidation();
          }

          function addSuggestionButton(label, sublabel, onPick) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;border:none;border-bottom:1px solid #1e293b;background:transparent;color:#e2e8f0;cursor:pointer;font-size:12.5px;line-height:1.35;';
            btn.innerHTML = '<div>' + String(label).replace(/</g, '&lt;') + '</div>' +
              (sublabel ? '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">' + String(sublabel).replace(/</g, '&lt;') + '</div>' : '');
            btn.addEventListener('mouseenter', function() { btn.style.background = '#1e293b'; });
            btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; });
            btn.addEventListener('mousedown', function(e) {
              e.preventDefault();
              onPick();
            });
            list.appendChild(btn);
          }

          async function fetchSuggestions(q) {
            if (abortCtrl) abortCtrl.abort();
            abortCtrl = new AbortController();
            showHint('Buscando dirección exacta…', false);
            var typed = String(input.value || q || '').trim();
            var parsed = parseAddressQuery(typed);

            try {
              var res = await fetch(
                '/api/geocode/suggest?q=' + encodeURIComponent(typed),
                { credentials: 'same-origin', signal: abortCtrl.signal }
              );
              if (!res.ok) throw new Error('geocode ' + res.status);
              var data = await res.json();
              var rows = Array.isArray(data.suggestions) ? data.suggestions : [];

              list.innerHTML = '';
              if (!rows.length) {
                showHint('Sin resultados — probá calle + número + comuna (ej: Pasaje Cordillera Doña Ana 2610, Peñaflor)', false);
                return;
              }

              var hasHouseMatch = rows.some(function(r) {
                return r.precision === 'house' && parsed.number && sameHouseNumber(r.house_number, parsed.number);
              });

              if (parsed.number && !hasHouseMatch) {
                var warn = document.createElement('div');
                warn.style.cssText = 'padding:10px 12px;font-size:12px;color:#fbbf24;border-bottom:1px solid #1e293b;background:rgba(245,158,11,0.08);';
                warn.textContent = 'N° ' + parsed.number + ' no confirmado como punto de casa. Elegí una sugerencia con ✓ N° o corregí la dirección.';
                list.appendChild(warn);
              }

              rows.slice(0, 7).forEach(function(r) {
                var isMatch = r.precision === 'house' && parsed.number && sameHouseNumber(r.house_number, parsed.number);
                var isHouse = r.precision === 'house' && r.house_number;
                var sublabel;
                if (isMatch) {
                  sublabel = '✓ Punto exacto · N° ' + r.house_number + ' (para el chofer)';
                } else if (isHouse) {
                  sublabel = '✓ Punto de casa · N° ' + r.house_number;
                } else if (r.precision === 'street') {
                  sublabel = 'Solo calle (sin N° exacto — el chofer no llegará a la puerta)';
                } else {
                  sublabel = 'Lugar aproximado';
                }
                addSuggestionButton(r.display, sublabel, function() {
                  pickSuggestion(
                    r.display,
                    r.lat,
                    r.lng,
                    isMatch || isHouse ? ('N° ' + (r.house_number || '') + ' exacto') : 'aproximado',
                    !!(isMatch || isHouse)
                  );
                });
              });
              list.style.display = 'block';
            } catch (err) {
              if (err && err.name === 'AbortError') return;
              list.innerHTML = '';
              showHint('No se pudo buscar direcciones. Reintentá.', true);
            }
          }

          input.addEventListener('input', function() {
            delete input.dataset.lat;
            delete input.dataset.lng;
            delete input.dataset.display;
            input.style.border = '1px solid #334155';
            invalidateRRValidation();
            clearTimeout(debounceTimer);
            var q = input.value.trim();
            if (q.length < 4) {
              hideList();
              return;
            }
            debounceTimer = setTimeout(function() { fetchSuggestions(q); }, 450);
          });

          input.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') hideList();
          });

          input.addEventListener('blur', function() {
            setTimeout(hideList, 180);
          });
        }

        window.renumerarParadas = function() {
          const items = document.getElementById('rrParadas').children;
          for (let i = 0; i < items.length; i++) {
            const label = items[i].querySelector('div');
            if (label) label.textContent = 'PARADA ' + (i + 1);
          }
          // Al agregar/quitar paradas, resetear validación — el usuario debe re-validar
          document.getElementById('rrValidacionPanel').style.display = 'none';
          var btnEnviar = document.getElementById('btnEnviarRR');
          btnEnviar.disabled = true;
          btnEnviar.style.background = '#334155';
          btnEnviar.style.color = '#64748b';
          btnEnviar.style.cursor = 'not-allowed';
          btnEnviar.style.opacity = '0.5';
          document.getElementById('btnValidarRR').disabled = false;
          document.getElementById('btnValidarRR').textContent = '🔍 Validar Direcciones';
        };

        // ── Paso 1: Validar todas las direcciones via geocodificación ──────────
        window._rrCoordsCacheadas = [];  // guarda coords validadas para reutilizar en Paso 2

        window.validarDireccionesRR = async function() {
          const paradaEls = Array.from(document.getElementById('rrParadas').children);
          if (paradaEls.length === 0) { alert('Agrega al menos una parada'); return; }

          const btnValidar = document.getElementById('btnValidarRR');
          btnValidar.disabled = true;
          btnValidar.textContent = '⏳ Validando 1 de ' + paradaEls.length + '...';

          const resultados = [];
          window._rrCoordsCacheadas = [];

          for (let i = 0; i < paradaEls.length; i++) {
            btnValidar.textContent = '📍 Validando ' + (i + 1) + ' de ' + paradaEls.length + '...';
            const el = paradaEls[i];
            const inputDireccion = el.querySelector('.rr-direccion');
            const direccion = inputDireccion?.value.trim() || '';
            const cliente = el.querySelector('.rr-cliente')?.value.trim() || '';

            // Marcar como "validando"
            el.style.border = '1px solid #3b82f6';
            inputDireccion.style.border = '1px solid #3b82f6';

            let coords = null;
            // Si el usuario eligió una sugerencia del autocomplete, reutilizar esas coords
            if (inputDireccion?.dataset?.lat && inputDireccion?.dataset?.lng) {
              const latN = parseFloat(inputDireccion.dataset.lat);
              const lngN = parseFloat(inputDireccion.dataset.lng);
              if (Number.isFinite(latN) && Number.isFinite(lngN)) {
                coords = {
                  lat: latN,
                  lng: lngN,
                  display: inputDireccion.dataset.display || direccion
                };
              }
            }
            if (!coords && direccion) {
              try {
                const gRes = await fetch('/api/geocode?q=' + encodeURIComponent(direccion), {
                  credentials: 'same-origin',
                  signal: AbortSignal.timeout(8000)
                });
                const gData = gRes.ok ? await gRes.json() : null;
                if (gData && gData.found && gData.result) {
                  var prec = String(gData.result.precision || '').toLowerCase();
                  // Rechazar centroides de país/ciudad/región (ej. "Chile" para basura tipográfica)
                  var usable = prec === 'house' || prec === 'street' || prec === 'address' || prec === 'pointaddress';
                  if (usable) {
                    coords = {
                      lat: gData.result.lat,
                      lng: gData.result.lng,
                      display: gData.result.display,
                      precision: gData.result.precision,
                      houseNumber: gData.result.house_number
                    };
                  }
                }
              } catch(e) { /* timeout o sin internet — coords queda null */ }
            }

            window._rrCoordsCacheadas.push(coords);
            resultados.push({ cliente, direccion, coords });

            // Marcar visualmente la parada
            if (coords) {
              var isHouse = coords.precision === 'house' || coords.houseNumber;
              el.style.border = isHouse ? '1px solid #10b981' : '1px solid #f59e0b';
              inputDireccion.style.border = isHouse ? '1px solid #10b981' : '1px solid #f59e0b';
              var existing = el.querySelector('.rr-geocod-result');
              if (existing) existing.remove();
              var conf = document.createElement('div');
              conf.className = 'rr-geocod-result';
              conf.style.cssText = 'font-size:11px;margin-top:4px;padding:4px 8px;border-radius:4px;' +
                (isHouse
                  ? 'color:#10b981;background:rgba(16,185,129,0.1);'
                  : 'color:#fbbf24;background:rgba(245,158,11,0.1);');
              conf.textContent = (isHouse ? '✅ Punto exacto: ' : '⚠️ Solo aproximado: ') +
                coords.display.substring(0, 80) + (coords.display.length > 80 ? '...' : '');
              inputDireccion.parentNode.insertBefore(conf, inputDireccion.nextSibling);
            } else {
              el.style.border = '1px solid #ef4444';
              inputDireccion.style.border = '2px solid #ef4444';
              var existing = el.querySelector('.rr-geocod-result');
              if (existing) existing.remove();
              var err = document.createElement('div');
              err.className = 'rr-geocod-result';
              err.style.cssText = 'font-size:11px;color:#ef4444;margin-top:4px;padding:4px 8px;background:rgba(239,68,68,0.1);border-radius:4px;';
              err.textContent = '❌ No encontrada — corregí la dirección e incluí la ciudad (ej: "Av Italia 1234, Santiago")';
              inputDireccion.parentNode.insertBefore(err, inputDireccion.nextSibling);
            }

            // Esperar un poco entre requests
            if (i < paradaEls.length - 1) {
              await new Promise(r => setTimeout(r, 250));
            }
          }

          // Mostrar resumen de validación
          const ok = resultados.filter(r => r.coords !== null).length;
          const fail = resultados.length - ok;
          const panel = document.getElementById('rrValidacionPanel');
          const resumen = document.getElementById('rrValidacionResumen');
          panel.style.display = 'block';

          btnValidar.disabled = false;
          btnValidar.textContent = '🔄 Re-validar';

          if (fail === 0) {
            resumen.innerHTML = '<span style="color:#10b981;font-weight:800;">✅ ' + ok + '/' + ok + ' direcciones validadas correctamente. Podés despachar la ruta.</span>';
            // Habilitar botón de despacho
            var btnEnviar = document.getElementById('btnEnviarRR');
            btnEnviar.disabled = false;
            btnEnviar.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
            btnEnviar.style.color = 'white';
            btnEnviar.style.cursor = 'pointer';
            btnEnviar.style.opacity = '1';
          } else {
            resumen.innerHTML = '<span style="color:#ef4444;font-weight:800;">⚠️ ' + fail + ' dirección(es) no encontrada(s).</span> <span style="color:#94a3b8;">Corregí las marcadas en rojo y volvé a validar.</span>';
            var btnEnviar = document.getElementById('btnEnviarRR');
            btnEnviar.disabled = true;
            btnEnviar.style.background = '#334155';
            btnEnviar.style.color = '#64748b';
            btnEnviar.style.cursor = 'not-allowed';
            btnEnviar.style.opacity = '0.5';
          }
        };

        window.enviarRutaRapida = async function() {
          const chofer_id = document.getElementById('rrChofer').value;
          const camion_listo = document.getElementById('rrCamionListo').checked;
          const descripcion_carga = document.getElementById('rrDescCarga').value.trim();

          if (!chofer_id) {
            var nCam = parseInt((document.getElementById('camionesDisponibles') || {}).value, 10);
            if (!Number.isInteger(nCam) || nCam < 2) {
              alert('Elegí un chofer, o poné N° de camiones ≥ 2 en el header (modo equilibrado) para partir la flota.');
              return;
            }
          }

          const paradaEls = document.getElementById('rrParadas').children;
          const paradas = [];
          for (const el of paradaEls) {
            const cliente = el.querySelector('.rr-cliente')?.value.trim();
            const direccion = el.querySelector('.rr-direccion')?.value.trim();
            if (!cliente || !direccion) { alert('Cada parada necesita al menos nombre de cliente y dirección'); return; }
            paradas.push({
              cliente,
              direccion,
              telefono: el.querySelector('.rr-telefono')?.value.trim() || null,
              email: el.querySelector('.rr-email')?.value.trim() || null,
              peso_kg: parseFloat(el.querySelector('.rr-peso')?.value) || 0,
              volumen: parseFloat(el.querySelector('.rr-volumen')?.value) || 0,
              descripcion: el.querySelector('.rr-descripcion')?.value.trim() || null,
              monto: parseFloat(el.querySelector('.rr-monto')?.value) || 0,
              sla_hora: el.querySelector('.rr-sla-hora')?.value || '18:00',
              ventana_inicio: el.querySelector('.rr-ventana-inicio')?.value || null,
              tags: (function() {
                var t = el.querySelector('.rr-tags')?.value;
                return t ? [t] : [];
              })(),
            });
          }

          if (paradas.length === 0) { alert('Agrega al menos una parada'); return; }
          if (paradas.length > RR_MAX_PARADAS) { alert('Máximo ' + RR_MAX_PARADAS + ' paradas'); return; }

          // Reutilizar coords ya validadas en el cliente (evita re-geocodificar y fallos Nominatim)
          const cached = window._rrCoordsCacheadas || [];
          if (cached.length !== paradas.length || cached.some(function(c) { return !c || c.lat == null || c.lng == null; })) {
            alert('Validá todas las direcciones antes de despachar (botón 🔍 Validar Direcciones).');
            return;
          }
          for (let i = 0; i < paradas.length; i++) {
            paradas[i].lat = cached[i].lat;
            paradas[i].lng = cached[i].lng;
          }

          const btn = document.getElementById('btnEnviarRR');
          btn.disabled = true;
          btn.textContent = '💾 Creando ruta...';

          try {
            const res = await rrFetch('/api/quick-route', {
              method: 'POST',
              body: JSON.stringify({
                chofer_id: chofer_id || null,
                camion_listo,
                descripcion_carga,
                paradas,
                depot_id: (document.getElementById('depotRuteo') || {}).value || null,
                flota_disponible: parseInt((document.getElementById('camionesDisponibles') || {}).value, 10) || 1,
                perfil_id: (document.getElementById('perfilRuteo') || {}).value || 1,
                clima: (document.getElementById('climaRuteo') || {}).value || 'NORMAL',
              })
            });
            const data = await res.json().catch(function() { return {}; });

            if (!res.ok) {
              alert('Error: ' + (data.error || ('HTTP ' + res.status)));
              btn.disabled = false;
              btn.textContent = '⚡ Crear y Despachar';
              return;
            }

            if (data.exito) {
              cerrarRutaRapida();
              var kmStr = data.km_totales ? data.km_totales + ' km' : 'N/D';
              var costoStr = data.costo_operativo ? '$' + Number(data.costo_operativo).toLocaleString('es-CL') : 'N/D';
              var nl = String.fromCharCode(10);
              var nViajes = data.viajes_creados || 1;
              alert('✅ Ruta creada exitosamente' + nl + nl +
                (data.split_fleet ? ('Viajes: ' + nViajes + ' camiones' + nl) : ('ID: ' + data.trip_id + nl)) +
                'Chofer: ' + data.chofer + nl +
                'Paradas: ' + data.paradas_creadas + nl +
                '📍 Distancia estimada: ' + kmStr + nl +
                '💰 Costo operativo: ' + costoStr);
              // Refrescar flota/backlog/mapa sin recargar (usar window.*: esta fn vive en otro scope)
              if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
              var refreshFn = typeof window.actualizarViajesSilencioso === 'function'
                ? window.actualizarViajesSilencioso
                : null;
              if (refreshFn) {
                try { await refreshFn(); } catch (_) { /* ignore */ }
                // Segundo pase corto: el insert/optimizador a veces termina un tick después
                setTimeout(function() {
                  if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
                  if (typeof window.actualizarViajesSilencioso === 'function') {
                    window.actualizarViajesSilencioso();
                  }
                }, 800);
              }
              // Si se crearon viajes, mostrar Flota; si quedaron pendientes, Backlog
              var targetTab = (Number(nViajes) > 0) ? 'panel-flota' : 'panel-backlog';
              var tabBtn = document.querySelector('.tab-btn[data-target="' + targetTab + '"]');
              if (tabBtn) tabBtn.click();
            } else {
              alert('Error: ' + (data.error || 'Error desconocido'));
              // Reactivar botón de despacho si el error fue del servidor (no de validación)
              btn.disabled = false;
              btn.textContent = '⚡ Crear y Despachar';
            }
          } catch (e) {
            alert('❌ Error de conexión: ' + e.message);
            btn.disabled = false;
            btn.textContent = '⚡ Crear y Despachar';
          } finally {
            // Si sigue abierto el modal, exigir re-validación solo tras éxito parcial
            if (document.getElementById('modalRutaRapida').style.display !== 'none' && btn.disabled) {
              btn.textContent = '⚡ Crear y Despachar';
            }
          }
        };

        var modalRR = document.getElementById('modalRutaRapida');
        if (modalRR) {
          modalRR.addEventListener('click', function(e) {
            if (e.target === this) cerrarRutaRapida();
          });
        }
        if (/[?&]video=rr(?:&|$)/.test(String(location.search || ''))) {
          setTimeout(function() { window.abrirRutaRapida({ fromVideo: true }); }, 800);
        }

        // Cerrar con ESC — reactiva el polling igual que cerrarRutaRapida()
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            var modal = document.getElementById('modalRutaRapida');
            if (modal && modal.style.display !== 'none') {
              cerrarRutaRapida();
            }
            var modalEdit = document.getElementById('modalEditarDireccion');
            if (modalEdit && modalEdit.style.display !== 'none') {
              cerrarEditarDireccion();
            }
          }
        });

        // ── Cancelar Ruta Rápida ───────────────────────────────────────────
        window.handleCancelSpot = function(btn) {
          var tripId = btn.getAttribute('data-trip') || '';
          if (!tripId) return;
          if (!confirm('Confirmar cancelacion de ruta ' + tripId + '. Esta accion no se puede deshacer.')) return;
          cancelarRutaRapida(tripId);
        };

        window.handleEditDir = function(btn) {
          var otId = btn.getAttribute('data-ot') || '';
          var dir  = btn.getAttribute('data-dir') || '';
          if (otId) abrirEditarDireccion(otId, dir);
        };

        window.cancelarRutaRapida = async function(tripId) {
          try {
            var res = await rrFetch('/api/quick-route/cancel', {
              method: 'PUT',
              body: JSON.stringify({ trip_id: tripId })
            });
            var data = await res.json().catch(function() { return {}; });
            if (data.exito) {
              // Actualizar panel sin recargar — el filtro de terminales lo ocultará
              if (typeof window.actualizarViajesSilencioso === 'function') window.actualizarViajesSilencioso();
            } else {
              alert('Error al cancelar: ' + (data.error || ('HTTP ' + res.status)));
            }
          } catch(e) {
            alert('Error de conexión: ' + e.message);
          }
        };

        // ── Modal Editar Dirección (Ruta Rápida) ──────────────────────────
        window.abrirEditarDireccion = function(otId, dirActual) {
          document.getElementById('editOtId').value = otId;
          document.getElementById('editOtIdDisplay').textContent = otId;
          document.getElementById('editDirActual').textContent = dirActual || '(sin dirección registrada)';
          document.getElementById('editNuevaDireccion').value = dirActual || '';
          document.getElementById('editResultado').innerHTML = '';
          document.getElementById('modalEditarDireccion').style.display = 'flex';
        };

        window.cerrarEditarDireccion = function() {
          document.getElementById('modalEditarDireccion').style.display = 'none';
        };

        window.guardarNuevaDireccion = async function() {
          var otId = document.getElementById('editOtId').value;
          var nuevaDireccion = document.getElementById('editNuevaDireccion').value.trim();
          var resultado = document.getElementById('editResultado');
          var btnGuardar = document.getElementById('btnGuardarDireccion');

          if (!nuevaDireccion) { resultado.innerHTML = '<span style="color:#ef4444">Escribe una dirección</span>'; return; }

          btnGuardar.disabled = true;
          btnGuardar.textContent = '🔍 Geocodificando...';
          resultado.innerHTML = '';

          try {
            var res = await rrFetch('/api/quick-route/address', {
              method: 'PUT',
              body: JSON.stringify({ ot_id: otId, nueva_direccion: nuevaDireccion })
            });
            var data = await res.json().catch(function() { return {}; });

            if (data.exito) {
              resultado.innerHTML = '<span style="color:#10b981;font-weight:700;">✅ Dirección actualizada · ' +
                data.lat.toFixed(5) + ', ' + data.lng.toFixed(5) + '</span>';
              if (typeof window.invalidateMapCache === 'function') window.invalidateMapCache();
              setTimeout(function() {
                cerrarEditarDireccion();
                if (typeof window.actualizarViajesSilencioso === 'function') window.actualizarViajesSilencioso();
              }, 1500);
            } else {
              resultado.innerHTML = '<span style="color:#ef4444">❌ ' + (data.error || 'Error desconocido') + '</span>';
            }
          } catch(e) {
            resultado.innerHTML = '<span style="color:#ef4444">❌ Error de conexión: ' + e.message + '</span>';
          } finally {
            btnGuardar.disabled = false;
            btnGuardar.textContent = '💾 Guardar Dirección';
          }
        };
        // ── /Modal Editar Dirección ────────────────────────────────────────
`;
