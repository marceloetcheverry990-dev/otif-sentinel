// src/ui/client/mapaYFlota.js
// Variables de mapa, initMap, dibujarRutaEnMapa, rastrearFlotaEnVivo.
// Extraído de src/ui.js Script #2 (Fase 3, Req 4). No ejecutar en el Worker.

export const MAPA_FLOTA_SCRIPT = `
        let routeGeomAbort = null;
        let routeDrawGen = 0;
        const routeGeomCache = new Map();
        window._snappedTrips = window._snappedTrips || {};

        function yieldToUI() {
          return new Promise(function(resolve) {
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(function() { setTimeout(resolve, 0); });
            } else {
              setTimeout(resolve, 0);
            }
          });
        }

        function routeGeomKey(coords) {
          return coords.map(function(p) {
            return Number(p[0]).toFixed(5) + ',' + Number(p[1]).toFixed(5);
          }).join(';');
        }

        function dist2LatLng(a, b) {
          var dlat = Number(a[0]) - Number(b[0]);
          var dlng = Number(a[1]) - Number(b[1]);
          return dlat * dlat + dlng * dlng;
        }

        function splitSnappedRoundTrip(snapped, lastStop, depot) {
          if (!Array.isArray(snapped) || snapped.length < 4 || !lastStop) {
            return { outbound: snapped, ret: null };
          }
          var n = snapped.length;
          var from = Math.max(1, Math.floor(n * 0.08));
          var to = Math.max(from + 1, Math.floor(n * 0.92));
          var bestI = from;
          var best = Infinity;
          for (var i = from; i < to; i++) {
            var d = dist2LatLng(snapped[i], lastStop);
            if (d < best) { best = d; bestI = i; }
          }
          if (depot && dist2LatLng(snapped[bestI], depot) < 1e-7) {
            return { outbound: snapped, ret: null };
          }
          var outbound = snapped.slice(0, bestI + 1);
          var ret = snapped.slice(bestI);
          if (outbound.length < 2 || ret.length < 2) {
            return { outbound: snapped, ret: null };
          }
          return { outbound: outbound, ret: ret };
        }

        async function fetchSnappedRoute(latlngs, signal) {
          var key = routeGeomKey(latlngs);
          if (routeGeomCache.has(key)) return routeGeomCache.get(key);
          if (!window._routeGeomInflight) window._routeGeomInflight = {};
          if (window._routeGeomInflight[key]) return window._routeGeomInflight[key];
          window._routeGeomInflight[key] = (async function() {
            try {
              var res = await fetch('/api/route-geometry', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  coordinates: latlngs,
                  tenant_id: (CONFIG && CONFIG.tenant_id) || window._TENANT_ID || ''
                }),
                signal: signal
              });
              if (!res.ok) {
                console.warn('[MAPA] route-geometry HTTP', res.status);
                return null;
              }
              var data = await res.json();
              if (data.fallback) {
                console.warn('[MAPA] route-geometry fallback (sin snap a calles)');
                return null;
              }
              var snapped = Array.isArray(data.coordinates) && data.coordinates.length > 1
                ? data.coordinates : null;
              if (snapped) routeGeomCache.set(key, snapped);
              return snapped;
            } catch (e) {
              if (e && e.name === 'AbortError') return null;
              console.warn('[MAPA] route-geometry', e && e.message);
              return null;
            } finally {
              if (window._routeGeomInflight) delete window._routeGeomInflight[key];
            }
          })();
          return window._routeGeomInflight[key];
        }

        const truckMarkers = {}; 
        const truckIcon = L.divIcon({ 
          html: '<div style="background:var(--primary); color:white; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:16px; border:2px solid white; box-shadow:0 4px 6px rgba(0,0,0,0.3); z-index: 9999;">🚚</div>', 
          className: '', iconSize: [30,30], iconAnchor: [15,15] 
        });

        // ============================================================================
        // LÓGICA DE MAPAS CON PROGRAMACIÓN DEFENSIVA
        // ============================================================================
        function initMap() {
          try {
            map = L.map('map', { preferCanvas: true, zoomControl: false }).setView([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG], 11);
            L.control.zoom({ position: 'topright' }).addTo(map);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);

            const bodegaIcon = L.divIcon({ html: '<div style="background:var(--accent); color:white; width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:18px; border:2px solid white; box-shadow:0 4px 6px rgba(0,0,0,0.2);">🏭</div>', className: '', iconSize: [36,36], iconAnchor: [18,18] });
            L.marker([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG], {icon: bodegaIcon}).bindPopup("<b>" + (CONFIG.BODEGA.NOMBRE || "Bodega") + "</b>").addTo(map);
            
            layerViajeActivo.addTo(map);

            // Backlog: capa lista, visible solo en pestaña Backlog (evita mapa colapsado)
            const layerBacklog = L.featureGroup();
            window._backlogLayer = layerBacklog;
            
            ordenesData.filter(o => o.estado_operacional === CONFIG.ESTADOS.PENDIENTE).forEach(o => {
              const latNum = Number(o.lat);
              const lngNum = Number(o.lng);
              
              if (o.lat != null && o.lng != null && !isNaN(latNum) && !isNaN(lngNum)) {
                L.circleMarker([latNum, lngNum], { radius: 5, fillColor: 'var(--warning)', color: '#fff', weight: 1.5, fillOpacity: 0.9 }).addTo(layerBacklog);
              } else {
                console.warn("[DEFENSIVO] Orden de Backlog omitida en mapa por coordenadas inválidas:", o);
              }
            });
          } catch (e) {
            console.error("[DEFENSIVO] Error inicializando el mapa base:", e);
          }
        }

        function syncBacklogLayerVisibility() {
          if (!map || !window._backlogLayer) return;
          const show = appState.activeTab === 'panel-backlog';
          const onMap = map.hasLayer(window._backlogLayer);
          if (show && !onMap) window._backlogLayer.addTo(map);
          if (!show && onMap) map.removeLayer(window._backlogLayer);
        }

        function clearTruckMarkers() {
          Object.keys(truckMarkers).forEach(function(id) {
            try { map.removeLayer(truckMarkers[id]); } catch (_) { /* ignore */ }
            delete truckMarkers[id];
          });
        }

        async function dibujarRutaEnMapa(safeTripId) {
          if (safeTripId && window._drawingTrip === safeTripId) {
            return;
          }
          const drawGen = ++routeDrawGen;
          if (routeGeomAbort && window._drawingTrip && window._drawingTrip !== safeTripId) {
            try { routeGeomAbort.abort(); } catch (_) {}
          }
          routeGeomAbort = new AbortController();
          const { signal } = routeGeomAbort;
          window._drawingTrip = safeTripId || null;
          try {
            layerViajeActivo.clearLayers();

            if (!safeTripId) {
              map.setView([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG], 10);
              return;
            }

            if (mapLayersCache.has(safeTripId) && window._snappedTrips && window._snappedTrips[safeTripId]) {
                const cachedLayers = mapLayersCache.get(safeTripId);
                cachedLayers.forEach(layer => layer.addTo(layerViajeActivo));
                const cachedBounds = mapBoundsCache.get(safeTripId);
                if (cachedBounds && cachedBounds.isValid()) {
                  map.fitBounds(cachedBounds, { padding: [50, 50], maxZoom: 15 });
                }
                return;
            }

            const card = document.getElementById('card-' + safeTripId);
            if(!card) return;
            const realTripId = decodeURIComponent(card.dataset.realTrip);
            
            var KNOWN_CLIENT_COORDS = {
              'retail center': { lat: -33.4189, lng: -70.6064 },
              'tienda mayorista': { lat: -33.4569, lng: -70.6483 }
            };

            function resolveParadaCoords(p) {
              if (!p) return null;
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
              if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                var known = KNOWN_CLIENT_COORDS[String(p.cliente || '').trim().toLowerCase()];
                if (known) return { lat: known.lat, lng: known.lng };
                return null;
              }
              return { lat: lat, lng: lng };
            }

            async function geocodeCliente(_cliente, _signal) {
              // No geocodificar por nombre de cliente (Nominatim inventaba centroides
              // de calle / barrio). El pin debe venir de orden/metadata/clientes.
              return null;
            }

            function collectRawParadas(tripId) {
              var raw = ordenesData.filter(function(o) { return String(o.trip_id) === String(tripId); });
              if (raw.length === 0 && Array.isArray(window.viajesActivos)) {
                var viaje = window.viajesActivos.find(function(v) { return String(v.trip_id) === String(tripId); });
                var detalle = (viaje && viaje.detalle_paradas) || [];
                raw = detalle.map(function(p) {
                  return {
                    ot_id: p.ot_id,
                    cliente: p.cliente,
                    trip_id: tripId,
                    lat: p.lat,
                    lng: p.lng,
                    stop_sequence: p.stop_sequence,
                    estado_operacional: p.estado_operacional || p.estado,
                    eta: p.eta,
                    fecha_hora_sla: p.fecha_hora_sla,
                    metadata: p.metadata,
                  };
                });
              }
              return raw;
            }

            let rawParadas = collectRawParadas(realTripId);
            rawParadas.sort(function(a, b) { return (a.stop_sequence || 99) - (b.stop_sequence || 99); });

            let paradasViaje = [];
            for (var ri = 0; ri < rawParadas.length; ri++) {
              var rp = rawParadas[ri];
              var coords = resolveParadaCoords(rp);
              if (!coords) {
                coords = await geocodeCliente(rp.cliente, signal);
              }
              if (!coords) continue;
              var merged = Object.assign({}, rp, { lat: coords.lat, lng: coords.lng });
              paradasViaje.push(merged);
              var existingOd = ordenesData.find(function(o) { return o.ot_id === rp.ot_id; });
              if (existingOd) {
                existingOd.lat = coords.lat;
                existingOd.lng = coords.lng;
                existingOd.trip_id = realTripId;
              } else {
                ordenesData.push(merged);
              }
            }

            if (paradasViaje.length === 0) {
              console.warn('[MAPA] Sin coordenadas para dibujar', realTripId);
              return;
            }

            // Si el usuario ya cambió de trip durante geocode, no pintar este.
            if (appState.activeTripId !== safeTripId) return;
            
            const coordsDirectas = [];
            
            if (Number.isFinite(CONFIG.BODEGA.LAT) && Number.isFinite(CONFIG.BODEGA.LNG)) {
                coordsDirectas.push([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]);
            }

            const newLayers = [];
            const coordOcurrences = {}; 

            paradasViaje.forEach((p, index) => {
              // [DEFENSIVO] Regla 1 & 4: Filtrado estricto en paradas de viaje con logs limpios
              if (p.lat == null || p.lng == null) {
                console.warn("[DEFENSIVO] Parada de viaje omitida por coordenadas nulas/indefinidas:", p);
                return;
              }

              let finalLat = Number(p.lat);
              let finalLng = Number(p.lng);
              
              if (isNaN(finalLat) || isNaN(finalLng)) {
                console.warn("[DEFENSIVO] Parada de viaje omitida por coordenadas NaN:", p);
                return;
              }
              
              const coordKey = finalLat.toFixed(4) + ',' + finalLng.toFixed(4);
              
              if (coordOcurrences[coordKey]) {
                  coordOcurrences[coordKey]++;
                  finalLat += (Math.random() - 0.5) * 0.002;
                  finalLng += (Math.random() - 0.5) * 0.002;
              } else {
                  coordOcurrences[coordKey] = 1;
              }

              coordsDirectas.push([finalLat, finalLng]);
              
              const isLate = Boolean(p.eta && p.fecha_hora_sla && new Date(p.eta).getTime() > new Date(p.fecha_hora_sla).getTime());
              
              let hexColor = CONFIG.UI.COLORS.NEUTRAL; 
              if (p.estado_operacional === CONFIG.ESTADOS.ENTREGADO) hexColor = CONFIG.UI.COLORS.EXITO; 
              else if (p.estado_operacional === CONFIG.ESTADOS.RECHAZADO) hexColor = CONFIG.UI.COLORS.ALERTA; 
              else if (isLate) hexColor = CONFIG.UI.COLORS.WARNING; 
              
              const pinHtml = '<div style="background:' + hexColor + '; color:white; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:11px; border:2px solid white;">' + (index + 1) + '</div>';
              const marker = L.marker([finalLat, finalLng], {icon: L.divIcon({ html: pinHtml, className: '', iconSize: [26,26], iconAnchor: [13,13] })}).bindPopup('<b>Stop ' + (index+1) + ': ' + escapeHTMLFront(p.cliente) + '</b>');
              newLayers.push(marker);
            });

            const skeletonStyle = {color: CONFIG.UI.COLORS.NEUTRAL, weight: 4, opacity: 0.45, dashArray: '8, 8'};
            const streetStyle = {color: CONFIG.UI.COLORS.NEUTRAL, weight: 5, opacity: 0.9};
            const returnStyle = { color: '#94a3b8', weight: 4, opacity: 0.7, dashArray: '5, 10' };
            let outboundLine = null;
            let returnLine = null;
            if (coordsDirectas.length > 1) {
              outboundLine = L.polyline(coordsDirectas, skeletonStyle);
              newLayers.push(outboundLine);
            }
            if (coordsDirectas.length > 1) {
              const lastStopCoords = coordsDirectas[coordsDirectas.length - 1];
              returnLine = L.polyline([lastStopCoords, [CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]], returnStyle);
              newLayers.push(returnLine);
            }

            if (drawGen !== routeDrawGen || appState.activeTripId !== safeTripId) return;

            layerViajeActivo.clearLayers();
            newLayers.forEach(function(layer) { layer.addTo(layerViajeActivo); });

            if (newLayers.length > 0) {
              const bounds = L.featureGroup(newLayers).getBounds().extend([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]);
              if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
              } else {
                console.warn("[DEFENSIVO] Leaflet bounds inválidos calculados para el viaje", safeTripId);
              }
            }

            await yieldToUI();
            if (drawGen !== routeDrawGen || appState.activeTripId !== safeTripId) return;

            var tour = coordsDirectas.slice();
            if (tour.length >= 1) {
              var last = tour[tour.length - 1];
              if (!last || last[0] !== CONFIG.BODEGA.LAT || last[1] !== CONFIG.BODEGA.LNG) {
                tour.push([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]);
              }
            }
            if (tour.length >= 2) {
              var snapped = await fetchSnappedRoute(tour, signal);
              if (drawGen !== routeDrawGen || appState.activeTripId !== safeTripId) return;
              if (snapped && snapped.length > 1) {
                try { if (outboundLine) layerViajeActivo.removeLayer(outboundLine); } catch (_) {}
                try { if (returnLine) layerViajeActivo.removeLayer(returnLine); } catch (_) {}
                for (var li = newLayers.length - 1; li >= 0; li--) {
                  if (newLayers[li] === outboundLine || newLayers[li] === returnLine) newLayers.splice(li, 1);
                }
                var lastStop = coordsDirectas[coordsDirectas.length - 1];
                var depotLL = [CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG];
                var parts = splitSnappedRoundTrip(snapped, lastStop, depotLL);
                outboundLine = L.polyline(parts.outbound, streetStyle);
                outboundLine.addTo(layerViajeActivo);
                newLayers.push(outboundLine);
                if (parts.ret && parts.ret.length > 1) {
                  returnLine = L.polyline(parts.ret, returnStyle);
                  returnLine.addTo(layerViajeActivo);
                  newLayers.push(returnLine);
                }
                window._snappedTrips[safeTripId] = true;
                var snapBounds = L.featureGroup(newLayers).getBounds().extend([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]);
                if (snapBounds.isValid()) {
                  mapLayersCache.set(safeTripId, newLayers);
                  mapBoundsCache.set(safeTripId, snapBounds);
                }
              }
            }

          } catch (error) {
            console.error("[DEFENSIVO] Fallo crítico al dibujar ruta en mapa:", error);
          } finally {
            if (window._drawingTrip === safeTripId) window._drawingTrip = null;
          }
        }
        async function rastrearFlotaEnVivo() {
          try {
            // Solo pintar el camión de la ruta abierta — con N camiones el mapa se colapsa
            const focusedTrip = appState.activeTripId ? String(appState.activeTripId) : null;
            if (!focusedTrip) {
              clearTruckMarkers();
              return;
            }

            const res = await fetch('/api/gps/live?tenant_id=' + encodeURIComponent(window._TENANT_ID || 'empresa_base'));
            if (!res.ok) return;
            const data = await res.json();
            
            if (data.exito && data.flota) {
              const tripsActivos = new Set();
              
              data.flota.forEach(camion => {
                const { trip_id, lat, lng, velocidad } = camion;
                if (String(trip_id) !== focusedTrip) return;
                if (lat == null || lng == null || isNaN(Number(lat)) || isNaN(Number(lng))) return;
                tripsActivos.add(String(trip_id));
                const popupHTML = '<div style="font-family:Inter; text-align:center;"><b>Viaje: ' + trip_id + '</b><br><span style="color:var(--text-muted); font-size:0.8rem;">Velocidad: ' + velocidad + ' km/h</span></div>';
                if (truckMarkers[trip_id]) {
                  truckMarkers[trip_id].setLatLng([lat, lng]);
                  truckMarkers[trip_id].setPopupContent(popupHTML);
                } else {
                  const marker = L.marker([lat, lng], {
                      icon: truckIcon, 
                      zIndexOffset: 1000
                  }).bindPopup(popupHTML).addTo(map);
                  truckMarkers[trip_id] = marker;
                }
              });
              Object.keys(truckMarkers).forEach(savedTripId => {
                if (!tripsActivos.has(String(savedTripId)) || String(savedTripId) !== focusedTrip) {
                  map.removeLayer(truckMarkers[savedTripId]);
                  delete truckMarkers[savedTripId];
                }
              });
            }
          } catch (err) {
            console.error("Falla silenciosa en telemetría GPS:", err);
          }
        }

        (function wrapInvalidateMapCache() {
          var prev = window.invalidateMapCache;
          window.invalidateMapCache = function(safeTripId) {
            if (typeof prev === 'function') prev(safeTripId);
            if (!safeTripId) {
              routeGeomCache.clear();
              window._snappedTrips = {};
            } else if (window._snappedTrips) {
              delete window._snappedTrips[safeTripId];
            }
          };
        })();
`;
