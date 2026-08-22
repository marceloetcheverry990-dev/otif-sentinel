// src/ui/templates/styles.js
// CSS estático del dashboard — 0 interpolaciones de servidor.
// Extraído de src/ui.js (Fase 1, Req 2). No modificar la lógica ni UI.

export const DASHBOARD_STYLES = `
        /* CSS PREMIUM - Diseño Limpio y Funcional */
        :root { 
          --bg: #0f172a; 
          --bg-2: #1e293b;
          --bg-3: #273548;
          --surface: #1e293b; 
          --surface-2: #273548;
          --text-main: #e2e8f0; 
          --text-muted: #94a3b8; 
          --border: #334155; 
          --border-focus: #475569;
          --primary: #3b82f6; --primary-hover: #2563eb; 
          --success: #10b981; --success-bg: #064e3b;
          --danger: #ef4444; --danger-bg: #450a0a;
          --warning: #f59e0b; --warning-bg: #451a03;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text-main); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        
        /* Transición suave para los marcadores de camión */
        .leaflet-marker-icon { transition: all 0.5s linear; }

        /* HEADER — 2 filas: título/sesión arriba, herramientas abajo (wrap, sin solapes) */
        .tower-header {
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          padding: 0.5rem 0.75rem 0.55rem;
          background: #0f172a;
          border-bottom: 1px solid #1e293b;
          z-index: 20;
          flex-shrink: 0;
          position: relative;
          overflow: visible;
        }
        .tower-header-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          min-height: 2rem;
          flex-wrap: wrap;
        }
        .tower-header-tools {
          display: flex;
          align-items: flex-start;
          gap: 0.55rem;
          flex-wrap: wrap;
          width: 100%;
        }
        .logo {
          font-size: 0.9rem;
          font-weight: 800;
          display: flex;
          align-items: center;
          gap: 0.35rem;
          color: white;
          white-space: nowrap;
          min-width: 0;
        }
        .sync-badge {
          font-size: 0.62rem;
          font-weight: 600;
          padding: 0.15rem 0.45rem;
          border-radius: 999px;
          background: #1e293b;
          color: #94a3b8;
          border: 1px solid #334155;
        }
        .header-group {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          flex: 1 1 auto;
          flex-wrap: wrap;
          padding: 0.4rem 0.55rem;
          border-radius: 8px;
          background: rgba(30, 41, 59, 0.55);
          border: 1px solid #1e293b;
          min-width: 0;
        }
        .header-group-datos {
          flex: 1 1 16rem;
          min-width: 14rem;
          max-width: 22rem;
        }
        .header-group-ruteo {
          flex: 2 1 28rem;
          min-width: 0;
          gap: 0.4rem;
          justify-content: flex-start;
        }
        .header-group-actions {
          flex: 0 0 auto;
          flex-wrap: nowrap;
          gap: 0.4rem;
          background: transparent;
          border-color: transparent;
          padding: 0;
        }
        .header-session {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.25rem 0.65rem 0.25rem 0.4rem;
          border-radius: 999px;
          background: #1e293b;
          border: 1px solid #334155;
          max-width: 9rem;
        }
        .header-session-dot {
          width: 0.45rem;
          height: 0.45rem;
          border-radius: 999px;
          background: #34d399;
          flex-shrink: 0;
        }
        .header-operator {
          font-size: 0.72rem;
          font-weight: 600;
          color: #cbd5e1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .header-excel-url {
          flex: 1 1 8rem;
          min-width: 6rem;
          max-width: 14rem;
          padding: 0.32rem 0.5rem;
          font-size: 0.75rem;
        }
        .header-file-wrap {
          position: relative;
          display: inline-flex;
          flex-shrink: 0;
        }
        .header-file-input {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
        }
        .btn-compact {
          white-space: nowrap;
          font-size: 0.72rem;
          padding: 0.32rem 0.6rem;
          flex-shrink: 0;
        }
        .btn-acepta {
          border-style: dashed !important;
          color: #60a5fa !important;
          border-color: #3b82f6 !important;
        }
        .btn-sync {
          color: #34d399 !important;
          border-color: #059669 !important;
        }
        .header-select-sm {
          width: auto;
          min-width: 5.5rem;
          max-width: 7.5rem;
          padding: 0.35rem 0.4rem;
          font-size: 0.75rem;
          flex: 0 1 auto;
        }
        .header-select-md {
          flex: 1 1 8rem;
          width: auto;
          min-width: 7rem;
          max-width: 12rem;
          padding: 0.35rem 0.45rem;
          font-size: 0.75rem;
        }
        #depotRuteo {
          max-width: 10rem;
          min-width: 6.5rem;
          flex: 0 1 9rem;
        }
        .header-trucks-wrap {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          flex-shrink: 0;
          padding: 0.1rem 0.35rem 0.1rem 0.45rem;
          border-radius: 6px;
          border: 1px solid #334155;
          background: #0f172a;
        }
        .header-trucks-label {
          font-size: 0.65rem;
          font-weight: 700;
          color: #64748b;
        }
        .header-trucks {
          width: 2.6rem;
          min-width: 2.6rem;
          text-align: center;
          padding: 0.25rem 0.15rem;
          font-size: 0.85rem;
          font-weight: 700;
          border: none !important;
          background: transparent !important;
        }
        .btn-ruta-rapida {
          background: linear-gradient(135deg, #f59e0b, #d97706) !important;
          color: white !important;
          border: none !important;
          font-weight: 700;
          padding: 0.35rem 0.85rem;
          font-size: 0.75rem;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .btn-ruta-rapida:hover { opacity: 0.9; }
        #btnReoptMidday,
        #btnRecalcularRuteo {
          max-width: 9.5rem;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .recalc-trip-list {
          max-height: 280px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 4px 0;
        }
        .recalc-trip-item {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 8px;
          cursor: pointer;
          font-size: 13px;
          color: #e2e8f0;
        }
        .recalc-trip-item input {
          margin-top: 2px;
          accent-color: #3b82f6;
        }
        .btn-dashboards {
          background: linear-gradient(135deg, #10b981, #059669) !important;
          color: white !important;
          border: none !important;
          font-weight: 700;
          padding: 0.32rem 0.7rem;
          font-size: 0.72rem;
          white-space: nowrap;
        }
        .btn-logout {
          background: #1e293b !important;
          color: #e2e8f0 !important;
          border: 1px solid #475569 !important;
          font-weight: 600;
          padding: 0.32rem 0.65rem;
          font-size: 0.72rem;
          white-space: nowrap;
        }
        .header-group-label {
          font-size: 0.58rem;
          font-weight: 700;
          text-transform: uppercase;
          color: #64748b;
          letter-spacing: 0.04em;
          white-space: nowrap;
          flex-shrink: 0;
        }
        @media (max-width: 1100px) {
          .header-group-datos,
          .header-group-ruteo {
            flex: 1 1 100%;
            max-width: none;
            min-width: 0;
          }
          .header-select-md,
          #depotRuteo {
            max-width: none;
            flex: 1 1 8rem;
          }
        }
        
        /* FORM ELEMENTS */
        .input-base { padding: 0.4rem 0.65rem; border-radius: 6px; border: 1px solid #334155; font-size: 0.8rem; color: #e2e8f0; outline: none; background: #0f172a; }
        .input-base:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(37,99,235,0.2); }
        .btn { padding: 0.45rem 0.9rem; border-radius: 6px; font-weight: 600; cursor: pointer; border: 1px solid #334155; font-size: 0.8rem; background: #1e293b; color: #e2e8f0; transition: all 0.2s; }
        .btn:hover:not(:disabled) { background: #334155; border-color: #475569; }
        .btn-primary { background: var(--primary); color: white; border-color: var(--primary); }
        .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
        
        /* MAIN LAYOUT (Sidebar + Map) */
        .app-container { display: flex; flex: 1; overflow: hidden; }
        .sidebar { width: 450px; min-width: 450px; display: flex; flex-direction: column; background: var(--bg); border-right: 1px solid var(--border); z-index: 10; box-shadow: 2px 0 12px rgba(0,0,0,0.3); }
        
        /* KPIs */
        .global-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; padding: 1rem; background: var(--bg); border-bottom: 1px solid var(--border); }
        .kpi-box { padding: 0.75rem; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); }
        .kpi-box:hover { border-color: var(--border-focus); }
        .kpi-title { font-size: 0.65rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.25rem; letter-spacing: 0.05em; }
        .kpi-val { font-size: 1.1rem; font-weight: 800; }
        
        /* TABS */
        .tabs-header { display: flex; background: var(--bg); border-bottom: 1px solid var(--border); padding: 0 1rem; }
        .tab-btn { flex: 1; padding: 0.85rem 0; text-align: center; font-size: 0.85rem; font-weight: 600; color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; background: transparent; border-top: none; border-left: none; border-right: none; }
        .tab-btn:hover { color: var(--text-main); background: var(--surface); }
        .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }
        .tab-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
        
        /* LIST CONTAINER */
        .list-viewport { flex: 1; overflow-y: auto; padding: 1rem; position: relative; }
        .list-viewport::-webkit-scrollbar { width: 6px; }
        .list-viewport::-webkit-scrollbar-track { background: var(--bg); }
        .list-viewport::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        .list-viewport::-webkit-scrollbar-thumb:hover { background: #475569; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        /* TRIP CARDS */
        .trip-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.75rem; cursor: pointer; transition: all 0.2s; }
        .trip-card:hover { border-color: var(--border-focus); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .trip-card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .trip-card.active { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); margin: 1rem 0; }
        
        .card-header { padding: 1rem; display: flex; justify-content: space-between; align-items: flex-start; pointer-events: none; }
        .trip-title { font-weight: 800; font-size: 1rem; margin-bottom: 0.2rem; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
        .trip-subtitle { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; }
        
        .badge { padding: 0.25rem 0.5rem; border-radius: 6px; font-size: 0.7rem; font-weight: 700; display: inline-flex; align-items: center; }
        .b-green { background: #064e3b; color: #34d399; border: 1px solid #065f46; }
        .b-red { background: #450a0a; color: #f87171; border: 1px solid #7f1d1d; }
        .b-orange { background: #451a03; color: #fb923c; border: 1px solid #7c2d12; }
        .b-neutral { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
        
        .card-body { padding: 0 1rem 1rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
        .chofer-select { width: 100%; padding: 0.5rem; border-radius: 6px; border: 1px solid var(--border); font-size: 0.8rem; font-weight: 600; outline: none; background: var(--bg); color: var(--text-main); }
        .chofer-select.assigned { background: #064e3b; border-color: #065f46; color: #34d399; }
        .chofer-select.locked,
        .chofer-select:disabled {
          opacity: 0.85;
          cursor: not-allowed;
          background: #1e293b;
          border-color: #475569;
          color: #94a3b8;
        }
        .chofer-select.assigned.locked {
          background: #064e3b;
          border-color: #047857;
          color: #6ee7b7;
        }
        
        /* EXPANDED DETAILS */
        .card-details { display: none; border-top: 1px solid var(--border); background: var(--bg); }
        .trip-card.active .card-details { display: block; }
        .stop-item { display: flex; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); gap: 1rem; }
        .stop-item:last-child { border-bottom: none; }
        .stop-num { width: 24px; height: 24px; border-radius: 50%; background: var(--border); display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; color: white; }
        
        /* BOTON VER DOCUMENTO */
        .btn-doc { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.65rem; font-weight: 600; cursor: pointer; transition: all 0.2s; white-space: nowrap; font-family: inherit; display: inline-block; text-decoration: none; border: 1px solid var(--border); }
        a.btn-doc { background: var(--primary); color: white; border-color: var(--primary); }
        a.btn-doc:hover { background: var(--primary-hover); border-color: var(--primary-hover); box-shadow: 0 2px 4px rgba(37,99,235,0.2); }
        button.btn-doc:disabled { background: var(--surface); color: var(--text-muted); cursor: not-allowed; opacity: 0.6; }
        
        /* BACKLOG CARDS */
        .backlog-item { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 0.75rem; }
        .backlog-item.has-coords { cursor: pointer; }
        .backlog-item.has-coords:hover { border-color: var(--border-focus); }
        
        /* MAP AREA */
        .map-container { flex: 1; position: relative; background: #e2e8f0; }
        #map { position: absolute; inset: 0; width: 100%; height: 100%; }

        /* --- LEAD RESCUE / DEAD MAN BANNER --- */
        .lead-rescue-banner {
          position: sticky; top: 0; z-index: 10050;
          background: linear-gradient(90deg, #7f1d1d 0%, #991b1b 50%, #7f1d1d 100%);
          color: #fecaca; padding: 0.55rem 1rem;
          border-bottom: 1px solid #b91c1c;
          font-size: 0.85rem; font-weight: 600;
          display: flex; align-items: center; justify-content: space-between; gap: 1rem;
          flex-wrap: wrap;
        }
        .lead-rescue-banner[hidden] { display: none !important; }
        .tower-busy-banner {
          display: none;
          align-items: center; justify-content: center;
          background: #1e3a5f; color: #bae6fd;
          padding: 0.45rem 1rem; font-size: 0.8rem; font-weight: 600;
          border-bottom: 1px solid #1d4ed8;
          z-index: 10040;
        }
        .tower-busy-banner:not([hidden]) { display: flex; }
        .lead-rescue-banner.severity-yellow {
          background: linear-gradient(90deg, #78350f 0%, #92400e 50%, #78350f 100%);
          color: #fde68a; border-bottom-color: #b45309;
        }
        .lead-rescue-banner-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .lead-rescue-banner .btn-rescue {
          background: #fef2f2; color: #991b1b; border: none; border-radius: 6px;
          padding: 0.35rem 0.75rem; font-weight: 700; cursor: pointer; font-size: 0.8rem;
        }
        .lead-rescue-banner.severity-yellow .btn-rescue {
          background: #fffbeb; color: #92400e;
        }
        .lead-rescue-banner .btn-dismiss-alert {
          background: transparent; color: inherit; border: 1px solid currentColor;
          border-radius: 6px; padding: 0.35rem 0.65rem; cursor: pointer; font-size: 0.75rem;
        }
        #leadRescueModal {
          position: fixed; inset: 0; z-index: 10060; background: rgba(15,23,42,0.72);
          display: flex; align-items: center; justify-content: center; padding: 1rem;
        }
        #leadRescueModal[hidden] { display: none !important; }
        .lead-rescue-modal-card {
          background: #1e293b; border: 1px solid #334155; border-radius: 10px;
          width: min(520px, 100%); max-height: 85vh; overflow: auto; color: #e2e8f0;
          box-shadow: 0 20px 40px rgba(0,0,0,0.45);
        }
        .lead-rescue-modal-card h3 {
          margin: 0; padding: 1rem 1.1rem; border-bottom: 1px solid #334155;
          font-size: 1rem; background: #0f172a;
        }
        .lead-rescue-modal-body { padding: 1rem 1.1rem; font-size: 0.85rem; }
        .lead-rescue-candidate {
          border: 1px solid #334155; border-radius: 8px; padding: 0.75rem;
          margin-bottom: 0.6rem; display: flex; justify-content: space-between;
          gap: 0.75rem; align-items: center; background: #0f172a;
        }
        .lead-rescue-candidate button {
          background: #dc2626; color: white; border: none; border-radius: 6px;
          padding: 0.45rem 0.8rem; font-weight: 700; cursor: pointer; white-space: nowrap;
        }
        .lead-rescue-candidate button:disabled { opacity: 0.6; cursor: wait; }

        /* --- AI COPILOT WIDGET --- */
        #ai-copilot-widget {
          position: fixed; bottom: 20px; right: 20px; z-index: 9999;
          width: 340px; background: #1e293b; border: 1px solid #334155;
          border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.4);
          display: flex; flex-direction: column; overflow: hidden; transition: all 0.3s ease;
        }
        #ai-copilot-widget.collapsed .widget-body { display: none; }
        .widget-header {
          background: #0f172a; color: #f8fafc; padding: 0.75rem 1rem;
          font-size: 0.85rem; font-weight: 700; display: flex; justify-content: space-between;
          align-items: center; cursor: pointer; border-bottom: 1px solid #334155;
        }
        .pulse-alert {
          width: 10px; height: 10px; background: var(--danger); border-radius: 50%;
          animation: pulse-red 1.5s infinite; display: inline-block; margin-right: 6px;
        }
        @keyframes pulse-red { 
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 
          70% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); } 
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } 
        }
        .widget-body { padding: 1rem; font-size: 0.8rem; background: #1e293b; color: #e2e8f0; }
        .ai-list { margin: 8px 0 12px 20px; color: #94a3b8; font-weight: 500; }
        .ai-btn {
          width: 100%; padding: 0.6rem; border-radius: 6px; background: #6366f1;
          color: white; border: none; font-weight: 700; cursor: pointer; transition: background 0.2s; display: flex; justify-content: center; align-items: center; gap: 8px;
        }
        .ai-btn:hover:not(:disabled) { background: #4f46e5; box-shadow: 0 4px 6px rgba(79, 70, 229, 0.2); }
        .ai-btn:disabled { opacity: 0.7; cursor: wait; }
        .ai-spinner {
          border: 2px solid rgba(255,255,255,0.3); border-radius: 50%;
          border-top: 2px solid white; width: 14px; height: 14px;
          animation: spin-ai 1s linear infinite; display: inline-block;
        }
        @keyframes spin-ai { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .ai-recommendation {
          margin-top: 1rem; padding: 0.75rem; background: #0f172a;
          border-left: 4px solid #6366f1; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); display: none; line-height: 1.4; color: #e2e8f0;
        }
        .chat-panel {
          position: fixed; top: 0; right: -400px; width: 400px; height: 100vh;
          background: #1e293b; border-left: 1px solid #334155;
          box-shadow: -5px 0 25px rgba(0,0,0,0.4); z-index: 10000;
          display: flex; flex-direction: column; transition: right 0.3s ease;
        }
        .chat-panel.open { right: 0; }
        .chat-header {
          padding: 1rem; background: #0f172a; color: white;
          display: flex; justify-content: space-between; align-items: center;
          border-bottom: 1px solid #334155;
        }
        .chat-close { background: transparent; color: white; border: none; font-size: 1.5rem; cursor: pointer; }
        .chat-messages { flex: 1; overflow-y: auto; padding: 1rem; background: #0f172a; display: flex; flex-direction: column; gap: 0.5rem; }
        .chat-bubble { max-width: 80%; padding: 0.75rem; border-radius: 8px; font-size: 0.85rem; line-height: 1.4; }
        .chat-torre { background: var(--primary); color: white; align-self: flex-end; border-bottom-right-radius: 0; }
        .chat-chofer { background: #1e293b; color: #e2e8f0; align-self: flex-start; border-bottom-left-radius: 0; border: 1px solid #334155; }
        .chat-meta { font-size: 0.65rem; opacity: 0.7; margin-top: 4px; text-align: right; }
        .chat-input-area { padding: 1rem; background: #1e293b; border-top: 1px solid #334155; display: flex; gap: 0.5rem; }
        .chat-input { flex: 1; padding: 0.75rem; border: 1px solid #334155; border-radius: 6px; outline: none; background: #0f172a; color: #e2e8f0; }
        .chat-input::placeholder { color: #64748b; }
        .btn-send { background: var(--primary); color: white; border: none; padding: 0 1rem; border-radius: 6px; cursor: pointer; font-weight: bold; }
        .btn-send:hover { background: var(--primary-hover); }
        .btn-chat-trigger { pointer-events: auto; z-index: 10; background: transparent; border: 1px solid var(--primary); color: var(--primary); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; cursor: pointer; font-weight: bold; transition: all 0.2s; }
        .btn-chat-trigger:hover { background: var(--primary); color: white; }
`;
