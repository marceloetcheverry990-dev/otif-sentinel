// src/ui/client/telemetriaYChat.js
// Telemetría global, sanitización front, lógica del chat operacional y enlace público.
// Extraído de src/ui.js Script #2 (Fase 3, Req 4). No ejecutar en el Worker.

export const TELEMETRY_CHAT_SCRIPT = `
        // ============================================================================
        // [PUNTO 4: OBSERVABILIDAD Y TELEMETRÍA] - Capturador Global
        // ============================================================================
        window.addEventListener('error', function(event) {
          enviarTelemetria('ERROR_JS_CLIENTE', { mensaje: event.message, url: window.location.href });
        });
        window.addEventListener('unhandledrejection', function(event) {
          enviarTelemetria('PROMESA_RECHAZADA', { motivo: event.reason?.message || event.reason });
        });
        function enviarTelemetria(tipo, payload) {
          fetch('/api/telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo, payload, timestamp: new Date().toISOString() }),
            keepalive: true
          }).catch(() => {}); 
        }

        // ============================================================================
        // UTILIDADES Y SANITIZACIÓN
        // ============================================================================
        function escapeHTMLFront(str) { 
          return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); 
        }
        function safeHttpUrlFront(url) {
          const s = String(url || '').trim();
          if (!/^https?:\\/\\//i.test(s)) return '';
          return escapeHTMLFront(s);
        }

        // ============================================================================
        // INICIALIZACIÓN Y ESTADO
        // ============================================================================
        const CONFIG = JSON.parse(document.getElementById('config-json').textContent);
        const ordenesData = JSON.parse(document.getElementById('ordenes-json').textContent);
        const viajesData = JSON.parse(document.getElementById('viajes-json').textContent);
        window.viajesActivos = viajesData;

        // Hidratar lat/lng desde detalle_paradas (evita mapa vacío si la orden
        // llegó sin coords o solo las tiene el viaje).
        function _metaNum(meta, key) {
          if (!meta || typeof meta !== 'object') return null;
          var n = Number(meta[key]);
          return Number.isFinite(n) ? n : null;
        }
        function _resolveLatLng(p) {
          var lat = p && p.lat != null ? Number(p.lat) : NaN;
          var lng = p && p.lng != null ? Number(p.lng) : NaN;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            var m = p && p.metadata;
            if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = null; } }
            lat = _metaNum(m, 'lat_destino') ?? _metaNum(m, 'lat');
            lng = _metaNum(m, 'lng_destino') ?? _metaNum(m, 'lng');
          }
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          return { lat: lat, lng: lng };
        }
        (viajesData || []).forEach(function(v) {
          (v.detalle_paradas || []).forEach(function(p) {
            if (!p || !p.ot_id) return;
            var coords = _resolveLatLng(p);
            var existing = ordenesData.find(function(o) { return o.ot_id === p.ot_id; });
            if (existing) {
              existing.trip_id = v.trip_id;
              if (coords) { existing.lat = coords.lat; existing.lng = coords.lng; }
              if (p.stop_sequence != null) existing.stop_sequence = p.stop_sequence;
              if (p.estado_operacional || p.estado) {
                existing.estado_operacional = p.estado_operacional || p.estado;
              }
            } else if (coords) {
              ordenesData.push({
                ot_id: p.ot_id,
                cliente: p.cliente,
                trip_id: v.trip_id,
                lat: coords.lat,
                lng: coords.lng,
                stop_sequence: p.stop_sequence,
                estado_operacional: p.estado_operacional || p.estado,
                monto_total: p.monto_total || p.valor,
                metadata: p.metadata,
              });
            }
          });
        });
        
        let map;
        const layerViajeActivo = L.featureGroup();
        const mapLayersCache = new Map();
        const mapBoundsCache = new Map();
        window.invalidateMapCache = function(safeTripId) {
          if (safeTripId) {
            mapLayersCache.delete(safeTripId);
            mapBoundsCache.delete(safeTripId);
          } else {
            mapLayersCache.clear();
            mapBoundsCache.clear();
          }
        };

        // ============================================================================
        // 💬 LÓGICA DEL CHAT OPERACIONAL (CON AUTO-REFRESCO)
        // ============================================================================
        window.chatPollingInterval = null;

        window.cerrarChat = function() {
          document.getElementById('chatOffcanvas').classList.remove('open');
          if (window.chatPollingInterval) {
            clearInterval(window.chatPollingInterval);
            window.chatPollingInterval = null;
          }
        };

        window.actualizarMensajesSilencioso = async function(tripId) {
          try {
            // TENANT_ID se define en el scope del DOMContentLoaded, accesible via closure
            const url = '/api/chat?tenant_id=' + encodeURIComponent(window._TENANT_ID || 'empresa_base') + '&trip_id=' + encodeURIComponent(tripId);
            const res = await fetch(url);
            const data = await res.json();
            if (data.exito) {
               window.renderMensajesChat(data.mensajes);
            }
          } catch (e) {} 
        };

        window.abrirChat = async function(btn) {
          const tripId = btn.getAttribute('data-trip');
          const rut = btn.getAttribute('data-rut');
          
          document.getElementById('chatCurrentTrip').value = tripId;
          document.getElementById('chatCurrentRut').value = rut;
          document.getElementById('chatTripTitle').textContent = 'Viaje: ' + tripId;
          
          const msgContainer = document.getElementById('chatMessages');
          msgContainer.innerHTML = '<div style="text-align: center; color: gray; margin-top: 2rem;">⏳ Cargando historial...</div>';
          
          document.getElementById('chatOffcanvas').classList.add('open');

          if (window.chatPollingInterval) {
            clearInterval(window.chatPollingInterval);
            window.chatPollingInterval = null;
          }

          try {
            // Regla §3: Lectura defensiva del tenant
            const tId = (typeof window !== 'undefined' && window._TENANT_ID)
              ? window._TENANT_ID
              : 'empresa_base';

            const url = '/api/chat?tenant_id=' + encodeURIComponent(tId) + '&trip_id=' + encodeURIComponent(tripId);
            const res = await fetch(url);

            // Leer texto crudo primero para poder diagnosticar errores de parseo
            const rawText = await res.text();
            let data;
            try {
              data = JSON.parse(rawText);
            } catch (parseErr) {
              throw new Error('Respuesta no es JSON válido: ' + rawText.slice(0, 50));
            }
            
            if (data.exito) {
               window.renderMensajesChat(data.mensajes);
            } else {
               msgContainer.innerHTML = '<div style="color: red; text-align: center; margin-top: 2rem;">Error: ' + escapeHTMLFront(data.error) + '</div>';
            }
          } catch (e) {
            msgContainer.innerHTML = '<div style="color: red; text-align: center; margin-top: 2rem;">Error de conexión: ' + escapeHTMLFront(e.message) + '</div>';
          }
          window.chatPollingInterval = setInterval(() => {
            window.actualizarMensajesSilencioso(tripId);
          }, 5000);
        };

        window.generarEnlacePublico = async function(btn) {
          console.log('[DEBUG] generarEnlacePublico llamada, botón:', btn);
          const tripId = btn.getAttribute('data-trip');
          console.log('[DEBUG] Trip ID:', tripId);
          const btnOriginal = btn.innerHTML;
          
          btn.innerHTML = '⏳ Generando...';
          btn.disabled = true;

          try {
            // Regla §3: Lectura defensiva del tenant
            const tId = (typeof window !== 'undefined' && window._TENANT_ID)
              ? window._TENANT_ID
              : 'empresa_base';
            
            console.log('[DEBUG] Tenant ID:', tId);

            const res = await fetch('/api/public-route/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                tenant_id: tId,
                trip_id: tripId,
                created_by: 'torre_control',
                expires_in_days: null // Sin expiración
              })
            });

            const data = await res.json();
            
            if (data.exito) {
              const publicUrl = safeHttpUrlFront(data.public_url);
              if (!publicUrl) throw new Error('URL pública inválida');
              // Copiar al portapapeles (con fallback)
              try {
                await navigator.clipboard.writeText(String(data.public_url || ''));
              } catch (_) {
                // Fallback silencioso si clipboard no está disponible
              }
              
              // Mostrar modal con el enlace
              const modal = document.createElement('div');
              modal.className = 'modal-overlay-public-link';
              modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:10000;';
              modal.innerHTML = \`
                <div style="background:#1e293b; padding:2rem; border-radius:12px; max-width:500px; width:90%; box-shadow:0 20px 60px rgba(0,0,0,0.5); border:1px solid #334155;">
                  <h3 style="margin:0 0 1rem 0; font-size:1.25rem; color:#e2e8f0;">✅ Enlace Público Generado</h3>
                  <p style="margin:0 0 1rem 0; color:#94a3b8; font-size:0.875rem;">\${data.reutilizado ? 'Se reutilizó el enlace existente.' : 'Se creó un nuevo enlace.'}</p>
                  <div style="background:#0f172a; padding:1rem; border-radius:8px; word-break:break-all; font-family:monospace; font-size:0.875rem; margin-bottom:1rem; color:#60a5fa; border:1px solid #334155;">
                    \${publicUrl}
                  </div>
                  <p style="margin:0 0 1rem 0; color:#10b981; font-size:0.875rem; font-weight:600;">📋 Enlace copiado al portapapeles</p>
                  <div style="display:flex; gap:0.5rem;">
                    <a href="\${publicUrl}" target="_blank" rel="noopener noreferrer" style="flex:1; padding:0.75rem; background:#667eea; color:white; text-align:center; border-radius:6px; text-decoration:none; font-weight:600;">🔗 Abrir enlace</a>
                    <button class="btn-close-modal" style="flex:1; padding:0.75rem; background:#334155; color:#e2e8f0; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Cerrar</button>
                  </div>
                </div>
              \`;
              document.body.appendChild(modal);
              
              // Agregar event listener para cerrar
              modal.querySelector('.btn-close-modal').addEventListener('click', function() {
                modal.remove();
              });
              
              btn.innerHTML = '✅ Copiado';
              setTimeout(() => {
                // Buscar el botón de nuevo en el DOM por data-trip (puede haber sido re-renderizado)
                const tripId2 = btn.getAttribute('data-trip');
                const freshBtn = tripId2 
                  ? document.querySelector('.btn-share-route[data-trip="' + tripId2 + '"]')
                  : btn;
                if (freshBtn) {
                  freshBtn.innerHTML = btnOriginal;
                  freshBtn.disabled = false;
                }
              }, 2000);
            } else {
              throw new Error(data.error || 'Error al generar enlace');
            }
          } catch (e) {
            alert('❌ Error: ' + e.message);
            btn.innerHTML = btnOriginal;
            btn.disabled = false;
          }
        };

        window.renderMensajesChat = function(mensajes) {
           const msgContainer = document.getElementById('chatMessages');
           if (!mensajes || mensajes.length === 0) {
              msgContainer.innerHTML = '<div style="text-align: center; color: gray; margin-top: 2rem;">No hay mensajes aún. Escribe uno abajo 👇</div>';
              return;
           }
           
           let html = '';
           mensajes.forEach(m => {
              const esTorre = m.tipo_evento === 'CHAT_TORRE';
              const cssClass = esTorre ? 'chat-torre' : 'chat-chofer';
              const autor = esTorre ? 'Torre de Control' : 'Chofer en Ruta';
              const hora = formatHoraCL(m.created_at);

              html += '<div class="chat-bubble ' + cssClass + '">' +
                        '<div style="font-weight: 800; margin-bottom: 4px; font-size: 0.7rem; opacity: 0.9;">' + autor + '</div>' +
                        (function() {
                          var fotoSafe = safeHttpUrlFront(m.foto_url);
                          if (!fotoSafe) return '';
                          return '<div style="margin-bottom:8px;">' +
                            '<a href="' + fotoSafe + '" target="_blank" rel="noopener noreferrer">' +
                               '<img src="' + fotoSafe + '" style="width:100%; border-radius:6px; cursor:pointer; border:1px solid #cbd5e1;">' +
                            '</a>' +
                            '<div style="margin-top:4px;">' +
                              '<a href="' + fotoSafe + '" target="_blank" rel="noopener noreferrer" style="font-size:0.75rem; color:#2563eb; font-weight:600; text-decoration:none;">' +
                               '📎 Ver / Descargar evidencia' +
                              '</a>' +
                            '</div>' +
                          '</div>';
                        })() +
                        '<div>' + escapeHTMLFront(m.mensaje) + '</div>' +
                        '<div class="chat-meta">' + hora + '</div>' +
                      '</div>';
           });
           
           const wasNearBottom =
            msgContainer.scrollHeight - msgContainer.clientHeight <= msgContainer.scrollTop + 50;
            msgContainer.innerHTML = html;

          if (wasNearBottom) {
            msgContainer.scrollTop = msgContainer.scrollHeight;
          }
        };

            window.enviarMensajeChat = async function() {
               const input = document.getElementById('chatInput');
               const texto = input.value.trim();
               if (!texto) return;

               const tripId = document.getElementById('chatCurrentTrip').value;
               const rut = document.getElementById('chatCurrentRut').value;
               const btnSend = document.getElementById('btnSendChat');

               btnSend.disabled = true;
               btnSend.textContent = '...';

               try {
                  const res = await fetch('/api/chat', {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({
                        tenant_id: window._TENANT_ID || 'empresa_base',
                        trip_id: tripId,
                        rut_chofer: rut || 'N/A',
                        emisor: 'TORRE',
                        mensaje: texto
                     })
                  });
                  
                  const data = await res.json();
                  
                  if (data.exito) {
                     input.value = ''; 
                     const btnDummy = document.createElement('button');
                     btnDummy.setAttribute('data-trip', tripId);
                     btnDummy.setAttribute('data-rut', rut);
                     await window.actualizarMensajesSilencioso(tripId);
                  } else {
                     alert("Error al enviar: " + data.error);
                  }
               } catch (e) {
                  alert("Falla de red al enviar el mensaje.");
               } finally {
                  btnSend.disabled = false;
                  btnSend.textContent = 'Enviar';
                  input.focus();
               }
            };
        `;
