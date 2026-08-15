// src/public-route-ui.js
// 🎨 PLANTILLA HTML/CSS/JS PARA PÁGINA PÚBLICA DE TRACKING CON MAPA

export function renderPublicRouteHTML(tripId, paradas, token) {
  const completadas = paradas.filter(p => p.estado === 'ENTREGADO').length;
  const total = paradas.length;
  const porcentaje = total > 0 ? Math.round((completadas / total) * 100) : 0;
  const kmTotal = paradas.length > 0 ? (paradas.length * 5).toFixed(1) : '0.0'; // Estimado

  // Formatear fecha actual
  const hoy = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    weekday: 'long'
  }).format(new Date());

  // Escapar HTML para prevenir XSS
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Calcular centro del mapa (promedio de coordenadas)
  const paradasConCoords = paradas.filter(p => p.lat && p.lng);
  let centerLat = -33.4489;
  let centerLng = -70.6693;
  if (paradasConCoords.length > 0) {
    centerLat = paradasConCoords.reduce((sum, p) => sum + Number(p.lat), 0) / paradasConCoords.length;
    centerLng = paradasConCoords.reduce((sum, p) => sum + Number(p.lng), 0) / paradasConCoords.length;
  }

  // Generar coordenadas para el mapa
  const coordsArray = JSON.stringify(paradasConCoords.map(p => ({ 
    lat: Number(p.lat), 
    lng: Number(p.lng),
    cliente: p.cliente,
    estado: p.estado,
    seq: p.stop_sequence
  })));

  // Función helper para renderizar cada parada
  function renderParada(p, index) {
    let icono = '';
    let color = '#9ca3af';
    let estadoTexto = 'Pendiente';
    let tiempoTexto = '';

    if (p.estado === 'ENTREGADO') {
      icono = '✓';
      color = '#10b981';
      estadoTexto = 'Entregado';
      if (p.hora_real) {
        const horaDate = new Date(p.hora_real);
        const horaFormatted = new Intl.DateTimeFormat('es-CL', {
          timeZone: 'America/Santiago',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }).format(horaDate);
        tiempoTexto = horaFormatted.toUpperCase();
      }
    } else if (p.estado === 'EN_SITIO') {
      icono = '⚡';
      color = '#f59e0b';
      estadoTexto = 'En atención';
    } else if (p.estado === 'EN_RUTA') {
      icono = '🚚';
      color = '#3b82f6';
      estadoTexto = 'En camino';
    } else {
      icono = String(index + 1);
      color = '#cbd5e1';
      estadoTexto = 'Pendiente';
      if (p.eta) {
        const etaDate = new Date(p.eta);
        const etaFormatted = new Intl.DateTimeFormat('es-CL', {
          timeZone: 'America/Santiago',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }).format(etaDate);
        tiempoTexto = etaFormatted.toUpperCase();
      }
    }

    return `
      <div class="parada-item" style="display:flex; align-items:flex-start; padding:12px 0; border-bottom:1px solid #f3f4f6;">
        <div style="width:32px; height:32px; border-radius:50%; background:${color}; color:white; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.875rem; flex-shrink:0;">${icono}</div>
        <div style="flex:1; margin-left:12px;">
          <div style="font-weight:600; color:#1f2937; font-size:0.9375rem;">${escapeHTML(p.cliente)}</div>
          <div style="color:#6b7280; font-size:0.8125rem; margin-top:2px;">${estadoTexto}${tiempoTexto ? ' • ' + tiempoTexto : ''}</div>
        </div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Ruta ${escapeHTML(tripId)}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #1f2937;
      overflow-x: hidden;
      min-height: 100vh;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      color: white;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="20" cy="20" r="3" fill="rgba(255,255,255,0.1)"/><circle cx="80" cy="60" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="50" cy="80" r="2.5" fill="rgba(255,255,255,0.1)"/></svg>');
      opacity: 0.3;
    }

    .header-content {
      position: relative;
      z-index: 1;
    }

    .header-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .header-icon {
      font-size: 1.5rem;
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-5px); }
    }

    .header-subtitle {
      font-size: 0.875rem;
      opacity: 0.95;
      font-weight: 500;
    }

    .stats-bar {
      background: white;
      margin: -20px 16px 0;
      padding: 16px;
      border-radius: 16px 16px 0 0;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.08);
      position: relative;
      z-index: 10;
    }

    .stat-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      background: linear-gradient(135deg, #f9fafb 0%, #ffffff 100%);
      border-radius: 12px;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .stat-item:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
    }

    .stat-icon {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.125rem;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    }

    .stat-content {
      display: flex;
      flex-direction: column;
    }

    .stat-value {
      font-size: 1rem;
      font-weight: 700;
      color: #1f2937;
      line-height: 1.2;
    }

    .stat-label {
      font-size: 0.6875rem;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.025em;
      font-weight: 600;
    }

    #map {
      width: 100%;
      height: 45vh;
      min-height: 300px;
      max-height: 400px;
      border-bottom: 4px solid #667eea;
    }

    .paradas-container {
      background: white;
      padding: 20px;
      border-radius: 0 0 16px 16px;
      margin: 0 16px 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
    }

    .paradas-header {
      font-size: 0.75rem;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 12px;
      border-bottom: 2px solid #f3f4f6;
    }

    .refresh-indicator {
      font-size: 0.6875rem;
      color: #10b981;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      background: #f0fdf4;
      padding: 4px 10px;
      border-radius: 12px;
    }

    .pulse-dot {
      width: 6px;
      height: 6px;
      background: #10b981;
      border-radius: 50%;
      animation: pulse 2s infinite;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .parada-item {
      display: flex;
      align-items: flex-start;
      padding: 14px;
      border-radius: 12px;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #f9fafb 0%, #ffffff 100%);
      border: 1px solid #e5e7eb;
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .parada-item:hover {
      transform: translateX(4px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.12);
      border-color: #667eea;
    }

    .parada-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.9375rem;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      position: relative;
      overflow: hidden;
    }

    .parada-icon::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: linear-gradient(45deg, transparent, rgba(255,255,255,0.2), transparent);
      transform: rotate(45deg);
      animation: shine 3s infinite;
    }

    @keyframes shine {
      0% { transform: translateX(-100%) translateY(-100%) rotate(45deg); }
      100% { transform: translateX(100%) translateY(100%) rotate(45deg); }
    }

    .parada-content {
      flex: 1;
      margin-left: 14px;
    }

    .parada-nombre {
      font-weight: 600;
      color: #1f2937;
      font-size: 0.9375rem;
      margin-bottom: 4px;
    }

    .parada-estado {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #6b7280;
      font-size: 0.8125rem;
    }

    .estado-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .badge-entregado {
      background: #d1fae5;
      color: #065f46;
    }

    .badge-en-sitio {
      background: #fef3c7;
      color: #92400e;
    }

    .badge-en-ruta {
      background: #dbeafe;
      color: #1e40af;
    }

    .badge-pendiente {
      background: #f3f4f6;
      color: #4b5563;
    }

    .footer {
      text-align: center;
      padding: 24px 20px;
      font-size: 0.75rem;
      color: white;
      font-weight: 500;
    }

    @media (max-width: 640px) {
      .header { padding: 16px; }
      .stats-bar { 
        margin: -16px 12px 0;
        padding: 12px;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .stat-item { padding: 10px; }
      .paradas-container { 
        padding: 16px;
        margin: 0 12px 12px;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="header-title">
        <span class="header-icon">🚚</span>
        <span>${escapeHTML(tripId)}</span>
      </div>
      <div class="header-subtitle">${hoy}</div>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-item">
      <div class="stat-icon">📍</div>
      <div class="stat-content">
        <div class="stat-value">${total}</div>
        <div class="stat-label">Paradas</div>
      </div>
    </div>
    <div class="stat-item">
      <div class="stat-icon">🛣️</div>
      <div class="stat-content">
        <div class="stat-value">${kmTotal} km</div>
        <div class="stat-label">Distancia</div>
      </div>
    </div>
    <div class="stat-item">
      <div class="stat-icon">✅</div>
      <div class="stat-content">
        <div class="stat-value">${completadas}/${total}</div>
        <div class="stat-label">Completadas</div>
      </div>
    </div>
  </div>

  <div id="map"></div>

  <div class="paradas-container">
    <div class="paradas-header">
      <span>📦 Detalle de Paradas</span>
      <div class="refresh-indicator">
        <span class="pulse-dot"></span>
        <span>En vivo</span>
      </div>
    </div>
    ${paradas.map((p, i) => {
      let color, badgeClass, estadoTexto;
      if (p.estado === 'ENTREGADO') {
        color = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        badgeClass = 'badge-entregado';
        estadoTexto = 'Entregado';
      } else if (p.estado === 'EN_SITIO') {
        color = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
        badgeClass = 'badge-en-sitio';
        estadoTexto = 'En atención';
      } else if (p.estado === 'EN_RUTA') {
        color = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
        badgeClass = 'badge-en-ruta';
        estadoTexto = 'En camino';
      } else {
        color = 'linear-gradient(135deg, #cbd5e1 0%, #94a3b8 100%)';
        badgeClass = 'badge-pendiente';
        estadoTexto = 'Pendiente';
      }

      let tiempoTexto = '';
      if (p.estado === 'ENTREGADO' && p.hora_real) {
        const horaDate = new Date(p.hora_real);
        const horaFormatted = new Intl.DateTimeFormat('es-CL', {
          timeZone: 'America/Santiago',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }).format(horaDate);
        tiempoTexto = horaFormatted.toUpperCase();
      } else if (p.eta && p.estado !== 'ENTREGADO') {
        const etaDate = new Date(p.eta);
        const etaFormatted = new Intl.DateTimeFormat('es-CL', {
          timeZone: 'America/Santiago',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }).format(etaDate);
        tiempoTexto = `ETA ${etaFormatted.toUpperCase()}`;
      }

      const icono = p.estado === 'ENTREGADO' ? '✓' : (i + 1);

      return `
        <div class="parada-item">
          <div class="parada-icon" style="background: ${color};">${icono}</div>
          <div class="parada-content">
            <div class="parada-nombre">${escapeHTML(p.cliente)}</div>
            <div class="parada-estado">
              <span class="estado-badge ${badgeClass}">${estadoTexto}</span>
              ${tiempoTexto ? `<span>•</span><span>${tiempoTexto}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('')}
  </div>

  <div class="footer">
    <div style="margin-bottom:12px;font-weight:600;color:#111827;">OTIF Sentinel</div>
    <a href="/login" style="display:inline-block;margin-bottom:10px;padding:10px 16px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.9rem;">
      ¿Eres transportista? Mira cómo funciona
    </a>
    <div style="font-size:0.75rem;color:#9ca3af;">Tracking en vivo · POD · Guías Res. 154</div>
  </div>

  <script>
    const paradas = ${coordsArray};
    const token = '${escapeHTML(token)}';

    // Inicializar mapa
    const map = L.map('map', {
      zoomControl: true,
      scrollWheelZoom: false,
      dragging: true,
      tap: false
    }).setView([${centerLat}, ${centerLng}], 12);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap, © CartoDB'
    }).addTo(map);

    if (paradas.length > 0) {
      // Dibujar líneas entre paradas
      const latlngs = paradas.map(p => [p.lat, p.lng]);
      L.polyline(latlngs, { color: '#667eea', weight: 4, opacity: 0.8 }).addTo(map);

      // Agregar marcadores
      paradas.forEach((p, index) => {
        const isCompleted = p.estado === 'ENTREGADO';
        const color = isCompleted ? '#10b981' : '#cbd5e1';
        
        const icon = L.divIcon({
          className: 'custom-marker',
          html: \`<div style="width:36px;height:36px;border-radius:50%;background:\${color};border:3px solid white;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.875rem;color:white;">\${isCompleted ? '✓' : (index + 1)}</div>\`,
          iconSize: [36, 36],
          iconAnchor: [18, 18]
        });

        L.marker([p.lat, p.lng], { icon })
          .addTo(map)
          .bindPopup(\`<b>\${p.cliente}</b><br>\${p.estado === 'ENTREGADO' ? 'Entregado' : 'Pendiente'}\`);
      });

      // Ajustar zoom para mostrar todas las paradas
      const bounds = L.latLngBounds(latlngs);
      map.fitBounds(bounds, { padding: [30, 30] });
    }

    // Auto-refresh cada 15 segundos
    setInterval(async () => {
      try {
        const response = await fetch(\`/api/public-route/\${token}/data\`);
        if (response.ok) {
          const data = await response.json();
          if (data.exito && data.completadas !== ${completadas}) {
            window.location.reload();
          }
        }
      } catch (error) {
        console.error('Error en auto-refresh:', error);
      }
    }, 15000);
  </script>
</body>
</html>`;
}
