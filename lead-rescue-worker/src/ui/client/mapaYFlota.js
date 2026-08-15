// src/ui/client/mapaYFlota.js
// Variables de mapa, initMap, dibujarRutaEnMapa, rastrearFlotaEnVivo.
// Extraído de src/ui.js Script #2 (Fase 3, Req 4). No ejecutar en el Worker.

export const MAPA_FLOTA_SCRIPT = `
        let osrmAbortController = null;

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

            const layerBacklog = L.featureGroup().addTo(map);
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

        async function dibujarRutaEnMapa(safeTripId) {
          if (osrmAbortController) {
             osrmAbortController.abort();
          }
          osrmAbortController = new AbortController();
          const { signal } = osrmAbortController;
          try {
            // Siempre limpiar la capa activa al cambiar/cerrar trip.
            // (Antes solo limpiaba si activeTripId !== safeTripId, pero el Proxy
            // ya setea activeTripId antes de llamar a esta función → se mezclaban.)
            layerViajeActivo.clearLayers();

            if (!safeTripId) {
              map.setView([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG], 10);
              return;
            }

            if (mapLayersCache.has(safeTripId)) {
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
            const osrmCoords = [];
            
            if (Number.isFinite(CONFIG.BODEGA.LAT) && Number.isFinite(CONFIG.BODEGA.LNG)) {
                coordsDirectas.push([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]);
                osrmCoords.push(CONFIG.BODEGA.LNG + ',' + CONFIG.BODEGA.LAT);
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
              osrmCoords.push(finalLng + ',' + finalLat); 
              
              const isLate = Boolean(p.eta && p.fecha_hora_sla && new Date(p.eta).getTime() > new Date(p.fecha_hora_sla).getTime());
              
              let hexColor = CONFIG.UI.COLORS.NEUTRAL; 
              if (p.estado_operacional === CONFIG.ESTADOS.ENTREGADO) hexColor = CONFIG.UI.COLORS.EXITO; 
              else if (p.estado_operacional === CONFIG.ESTADOS.RECHAZADO) hexColor = CONFIG.UI.COLORS.ALERTA; 
              else if (isLate) hexColor = CONFIG.UI.COLORS.WARNING; 
              
              const pinHtml = '<div style="background:' + hexColor + '; color:white; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:11px; border:2px solid white;">' + (index + 1) + '</div>';
              const marker = L.marker([finalLat, finalLng], {icon: L.divIcon({ html: pinHtml, className: '', iconSize: [26,26], iconAnchor: [13,13] })}).bindPopup('<b>Stop ' + (index+1) + ': ' + escapeHTMLFront(p.cliente) + '</b>');
              newLayers.push(marker);
            });

            const routeStyle = {color: CONFIG.UI.COLORS.NEUTRAL, weight: 4, opacity: 0.7, dashArray: '8, 8'};
            let finalRouteCoords = coordsDirectas;

            if (osrmCoords.length >= 2 && osrmCoords.length <= 100) {
                try {
                  const timeoutId = setTimeout(() => osrmAbortController.abort(), 3000); 
                  const url = 'https://router.project-osrm.org/route/v1/driving/' + osrmCoords.join(';') + '?overview=full&geometries=geojson';
                  const response = await fetch(url, { signal });
                  clearTimeout(timeoutId);
                  
                  if (response.ok) {
                      const data = await response.json();
                      if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
                          finalRouteCoords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                      }
                  } else {
                      console.warn("OSRM: Fallo en API, aplicando Graceful Degradation (línea recta).");
                  }
                } catch (error) {
                  // Abort/timeout: seguir con línea recta (no dejar el mapa vacío — T7)
                  console.warn("OSRM: Timeout/Abort/Red — Graceful Degradation (línea recta).", error && error.message);
                }
            }

            if (appState.activeTripId !== safeTripId) return;

            if (finalRouteCoords.length > 1) {
              newLayers.push(L.polyline(finalRouteCoords, routeStyle));
            }

            if (coordsDirectas.length > 1) {
                const lastStopCoords = coordsDirectas[coordsDirectas.length - 1]; 
                const returnStyle = { color: '#94a3b8', weight: 4, opacity: 0.7, dashArray: '5, 10' };
                
                let returnRouteCoords = [lastStopCoords, [CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]];

                try {
                  // Si el tramo ida abortó el controller, crear uno nuevo para el retorno
                  if (!osrmAbortController || osrmAbortController.signal.aborted) {
                    osrmAbortController = new AbortController();
                  }
                  const signalRet = osrmAbortController.signal;
                  const timeoutRet = setTimeout(() => osrmAbortController.abort(), 3000); 
                  const urlRet = 'https://router.project-osrm.org/route/v1/driving/' + lastStopCoords[1] + ',' + lastStopCoords[0] + ';' + CONFIG.BODEGA.LNG + ',' + CONFIG.BODEGA.LAT + '?overview=full&geometries=geojson';
                  const responseRet = await fetch(urlRet, { signal: signalRet });
                  clearTimeout(timeoutRet);

                  if (responseRet.ok) {
                      const dataRet = await responseRet.json();
                      if (dataRet.code === 'Ok' && dataRet.routes && dataRet.routes.length > 0) {
                          returnRouteCoords = dataRet.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                      }
                  }
                } catch (error) {
                  console.warn("OSRM Retorno: Timeout/Abort/Red — línea recta.", error && error.message);
                }

                if (appState.activeTripId !== safeTripId) return;
                newLayers.push(L.polyline(returnRouteCoords, returnStyle));
            }

            if (appState.activeTripId !== safeTripId) return;

            // Pintar todo de una vez sobre capa limpia (evita mezclar trips)
            layerViajeActivo.clearLayers();
            newLayers.forEach(function(layer) { layer.addTo(layerViajeActivo); });

            if (newLayers.length > 0) {
              const bounds = L.featureGroup(newLayers).getBounds().extend([CONFIG.BODEGA.LAT, CONFIG.BODEGA.LNG]);
              if (bounds.isValid()) {
                mapLayersCache.set(safeTripId, newLayers);
                mapBoundsCache.set(safeTripId, bounds);
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
              } else {
                console.warn("[DEFENSIVO] Leaflet bounds inválidos calculados para el viaje", safeTripId);
              }
            }

          } catch (error) {
            console.error("[DEFENSIVO] Fallo crítico al dibujar ruta en mapa:", error);
          }
        }
        async function rastrearFlotaEnVivo() {
          try {
            const res = await fetch('/api/gps/live?tenant_id=' + encodeURIComponent(window._TENANT_ID || 'empresa_base'));
            if (!res.ok) return;
            const data = await res.json();
            
            if (data.exito && data.flota) {
              const tripsActivos = new Set(); // [ARREGLO: GARBAGE COLLECTOR]
              
              data.flota.forEach(camion => {
                const { trip_id, lat, lng, velocidad } = camion;
                if (lat == null || lng == null || isNaN(Number(lat)) || isNaN(Number(lng))) return;
                tripsActivos.add(String(trip_id)); // Marcamos el viaje como vivo
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
                if (!tripsActivos.has(savedTripId)) {
                  map.removeLayer(truckMarkers[savedTripId]); // Quitar del DOM (Leaflet)
                  delete truckMarkers[savedTripId];           // Quitar de la memoria (JS)
                }
              });
            }
          } catch (err) {
            console.error("Falla silenciosa en telemetría GPS:", err);
          }
        }
`;
