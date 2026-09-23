// src/erp/ui/page.js
// HTML de la app ERP (/erp). Estética inspirada en SAP GUI / Fiori "Quartz":
// barra de sistema con campo de comandos, barra de título, barra de botones
// de la aplicación, área de pantalla y barra de estado abajo.

import { TRANSACCIONES, catalogoCliente } from '../registry.js';
import { ERP_CLIENTE_SCRIPT } from './cliente.js';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// JSON dentro de <script>: evitar que un "</script>" en los datos cierre el tag.
function jsonSeguro(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

const ESTILOS = `
:root {
  --shell: #1d2d3e; --shell-txt: #fff; --fondo: #f5f6f7; --panel: #fff; --borde: #d9d9d9;
  --txt: #1d2d3e; --txt-suave: #556b82; --azul: #0a6ed1; --azul-hover: #0854a1;
  --verde: #107e3e; --rojo: #bb0000; --amarillo: #e9730c; --fila-alt: #f7f9fb; --campo-ro: #f2f2f2;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font: 13px/1.4 "Segoe UI", "72", Arial, sans-serif; color: var(--txt); background: var(--fondo);
  display: flex; flex-direction: column; }
body.erp-ocupado { cursor: progress; }
body.erp-ocupado .erp-btn { opacity: .6; pointer-events: none; }
kbd { font: 11px/1 Consolas, monospace; background: #eef1f4; border: 1px solid #c5ccd3; border-bottom-width: 2px;
  border-radius: 3px; padding: 1px 4px; color: var(--txt-suave); }

.erp-shell { background: var(--shell); color: var(--shell-txt); display: flex; align-items: center; gap: 10px;
  padding: 6px 12px; flex-wrap: wrap; }
.erp-logo { font-weight: 700; letter-spacing: .5px; margin-right: 6px; white-space: nowrap; }
.erp-logo span { color: #7fc6ff; }
.erp-comando { display: flex; align-items: center; }
.erp-comando input { width: 170px; padding: 4px 8px; border: 1px solid #5b738b; border-radius: 4px 0 0 4px;
  background: #fff; color: var(--txt); font: 13px Consolas, monospace; text-transform: uppercase; }
.erp-comando button, .erp-shell-btn { border: 1px solid #5b738b; background: #2c4157; color: #fff; padding: 4px 9px;
  cursor: pointer; font-size: 13px; }
.erp-comando button { border-radius: 0 4px 4px 0; border-left: 0; }
.erp-shell-btn { border-radius: 4px; }
.erp-shell-btn:hover, .erp-comando button:hover { background: #3c5874; }
.erp-shell-der { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.erp-shell-der a { color: #cfe6ff; text-decoration: none; }
.erp-shell-der a:hover { text-decoration: underline; }
.erp-usuario { color: #b8c7d6; font-size: 12px; }

.erp-titulo { background: var(--panel); border-bottom: 1px solid var(--borde); padding: 10px 16px 8px;
  font-size: 18px; font-weight: 600; }
.erp-botones { background: var(--panel); border-bottom: 1px solid var(--borde); padding: 6px 16px; display: flex;
  gap: 6px; flex-wrap: wrap; min-height: 42px; }
.erp-btn { border: 1px solid var(--azul); color: var(--azul); background: #fff; border-radius: 4px; padding: 4px 12px;
  cursor: pointer; font: inherit; }
.erp-btn:hover { background: #ebf5fe; }
.erp-btn-primario { background: var(--azul); color: #fff; }
.erp-btn-primario:hover { background: var(--azul-hover); }
.erp-btn kbd { margin-left: 4px; }
.erp-btn-primario kbd { background: rgba(255,255,255,.2); color: #fff; border-color: rgba(255,255,255,.4); }
.erp-btn-mini { border: 1px solid var(--amarillo); color: var(--amarillo); background: #fff; border-radius: 3px;
  padding: 1px 8px; cursor: pointer; font-size: 12px; }

main#erp-contenido { flex: 1; overflow: auto; padding: 14px 16px 24px; }

.erp-grupo { background: var(--panel); border: 1px solid var(--borde); border-radius: 6px; margin: 0 0 14px;
  padding: 10px 14px 12px; }
.erp-grupo legend { font-weight: 600; color: var(--txt-suave); padding: 0 6px; }
.erp-campo { display: grid; grid-template-columns: 190px 1fr; align-items: center; gap: 8px; margin: 5px 0; }
.erp-campo label { color: var(--txt-suave); text-align: right; }
.erp-req { color: var(--rojo); margin-left: 2px; }
.erp-control { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.erp-campo input[type=text], .erp-campo input[type=number], .erp-campo input[type=date], .erp-campo select,
.erp-celda input, .erp-tabla-editable input[type=text], .erp-tabla-editable input[type=number], .erp-tabla-editable input[type=date] {
  border: 1px solid #89919a; border-radius: 3px; padding: 3px 6px; font: inherit; background: #fff; color: var(--txt);
  max-width: 100%; }
.erp-campo input:focus, .erp-campo select:focus, .erp-celda input:focus { outline: 2px solid var(--azul); outline-offset: 0; border-color: var(--azul); }
.erp-campo input[readonly], .erp-campo select:disabled { background: var(--campo-ro); border-color: var(--borde); color: var(--txt); }
.erp-f4 { border: 1px solid #89919a; background: #fff; border-radius: 3px; cursor: pointer; padding: 2px 6px; color: var(--azul); }
.erp-f4:hover { background: #ebf5fe; }
.erp-celda { display: inline-flex; gap: 2px; align-items: center; }
.erp-numerico { text-align: right; font-variant-numeric: tabular-nums; }
.erp-total { text-align: right; margin: 8px 4px 0; font-size: 15px; color: var(--txt-suave); }
.erp-total b { color: var(--txt); font-size: 17px; font-variant-numeric: tabular-nums; }
.erp-ayuda-campo { color: var(--txt-suave); font-size: 12px; }
.erp-ayuda { color: var(--txt-suave); margin: 6px 0; }

.erp-pestanas-cab { display: flex; gap: 2px; border-bottom: 2px solid var(--borde); margin-bottom: 12px; flex-wrap: wrap; }
.erp-pestana { border: 0; background: none; padding: 8px 14px; cursor: pointer; font: inherit; color: var(--txt-suave);
  border-bottom: 3px solid transparent; margin-bottom: -2px; }
.erp-pestana.activa { color: var(--azul); border-bottom-color: var(--azul); font-weight: 600; }

.erp-tabla-scroll { overflow-x: auto; }
.erp-tabla { border-collapse: collapse; width: 100%; background: var(--panel); margin: 8px 0; }
.erp-tabla th { background: #eef1f4; color: var(--txt-suave); font-weight: 600; text-align: left; padding: 6px 8px;
  border-bottom: 1px solid var(--borde); white-space: nowrap; }
.erp-tabla td { padding: 5px 8px; border-bottom: 1px solid #edf0f2; white-space: nowrap; }
.erp-tabla tbody tr:nth-child(even) { background: var(--fila-alt); }
.erp-tabla tbody tr:hover { background: #e5f0fa; }
.erp-tabla .erp-num { text-align: right; font-variant-numeric: tabular-nums; }
.erp-tabla a { color: var(--azul); text-decoration: none; }
.erp-tabla a:hover { text-decoration: underline; }
.erp-tabla .erp-vacio { text-align: center; color: var(--txt-suave); padding: 16px; }
.erp-fila-alerta td { background: #fff4e5 !important; }
.erp-fila-inactiva td { color: #9aa5b1; }
.erp-texto-breve { color: var(--txt-suave); min-width: 160px; }
.erp-estado-abierto { color: var(--azul); font-weight: 600; }
.erp-estado-parcial { color: var(--amarillo); font-weight: 600; }
.erp-estado-cerrado { color: var(--verde); font-weight: 600; }
.erp-migo-barra { display: flex; flex-wrap: wrap; gap: 0 20px; background: var(--panel); border: 1px solid var(--borde);
  border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; }
.erp-migo-barra .erp-campo { grid-template-columns: auto auto; }

.erp-inicio { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 16px; align-items: start; }
.erp-menu { background: var(--panel); border: 1px solid var(--borde); border-radius: 6px; padding: 10px 12px; }
.erp-menu-titulo { font-weight: 600; margin: 8px 0 4px; }
.erp-menu ul { list-style: none; margin: 0; padding-left: 16px; }
.erp-menu > ul { padding-left: 4px; }
.erp-menu summary { cursor: pointer; padding: 2px 0; }
.erp-menu-tx a { display: block; padding: 2px 4px; color: var(--txt); text-decoration: none; border-radius: 3px; }
.erp-menu-tx a:hover { background: #e5f0fa; }
.erp-menu-code { font: 12px Consolas, monospace; color: var(--azul); display: inline-block; min-width: 48px; }
.erp-bienvenida { background: var(--panel); border: 1px solid var(--borde); border-radius: 6px; padding: 14px 20px; }
.erp-bienvenida h2 { margin: 0 0 8px; font-size: 18px; }
.erp-bienvenida h3 { margin: 16px 0 6px; font-size: 14px; color: var(--txt-suave); }
.erp-pasos li { margin: 4px 0; }
.erp-pasos a, .erp-bienvenida a { color: var(--azul); font: 600 12px Consolas, monospace; }
.erp-teclas { padding-left: 18px; }
.erp-teclas li { margin: 3px 0; }

.erp-barra-estado { background: #fff; border-top: 1px solid var(--borde); padding: 5px 12px; display: flex; gap: 8px;
  align-items: center; min-height: 30px; }
.erp-barra-estado #erp-estado { flex: 1; }
.erp-msg-S { background: #f1fdf6; color: var(--verde); }
.erp-msg-E { background: #ffebeb; color: var(--rojo); }
.erp-msg-W { background: #fef7f1; color: var(--amarillo); }
.erp-msg-I { background: #f5faff; color: var(--azul); }
.erp-sistema { color: var(--txt-suave); font: 12px Consolas, monospace; white-space: nowrap; }

.erp-f4-modal { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: flex-start;
  justify-content: center; padding-top: 10vh; z-index: 20; }
.erp-f4-modal[hidden] { display: none; }
.erp-f4-caja { background: #fff; border-radius: 8px; width: min(560px, 94vw); max-height: 70vh; display: flex;
  flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
.erp-f4-cab { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px;
  border-bottom: 1px solid var(--borde); font-weight: 600; }
.erp-f4-cab button { border: 0; background: none; font-size: 18px; cursor: pointer; }
.erp-f4-caja input { margin: 10px 14px; padding: 6px 8px; border: 1px solid #89919a; border-radius: 4px; font: inherit; }
#erp-f4-lista { list-style: none; margin: 0; padding: 0 6px 10px; overflow: auto; }
#erp-f4-lista button { width: 100%; text-align: left; border: 0; background: none; padding: 6px 8px; cursor: pointer;
  border-radius: 4px; font: inherit; }
#erp-f4-lista button:hover, #erp-f4-lista button:focus { background: #e5f0fa; }
#erp-f4-lista span { color: var(--txt-suave); }

@media (max-width: 760px) {
  .erp-inicio { grid-template-columns: 1fr; }
  .erp-campo { grid-template-columns: 1fr; gap: 2px; }
  .erp-campo label { text-align: left; }
  .erp-shell-der { margin-left: 0; }
  main#erp-contenido { padding: 12px 16px 24px; }
}
`;

export function renderErpPage(operator) {
  const catalogo = Object.fromEntries(catalogoCliente().map((t) => [t.code, t]));
  // Cada pantalla es un string "function (ui, params) {...}" que se registra
  // con su código de transacción. Ver src/erp/transacciones/*.js
  const pantallas = Object.values(TRANSACCIONES)
    .map((tx) => `ERP.screens[${JSON.stringify(tx.code)}] = ${tx.screen};`)
    .join('\n');

  const usuario = operator?.display_name || operator?.username || 'usuario';
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ERP · Easy Access</title>
<style>${ESTILOS}</style>
</head>
<body>
<header class="erp-shell">
  <div class="erp-logo">OTIF <span>ERP</span></div>
  <div class="erp-comando">
    <input id="erp-comando" type="text" placeholder="Transacción…" aria-label="Campo de comandos" autocomplete="off" spellcheck="false">
    <button id="erp-comando-ok" type="button" title="Ejecutar (Enter)">✓</button>
  </div>
  <button id="erp-atras" class="erp-shell-btn" type="button" title="Atrás (F3)">◀ Atrás</button>
  <button id="erp-inicio" class="erp-shell-btn" type="button" title="Menú SAP Easy Access">☰ Menú</button>
  <div class="erp-shell-der">
    <a href="/control-tower" title="Volver a la Torre de Control">🗼 Torre de Control</a>
    <span class="erp-usuario">${escapeHtml(usuario)} · ${escapeHtml(operator?.tenant_id || '')}</span>
    <button id="erp-salir" class="erp-shell-btn" type="button">Salir</button>
  </div>
</header>
<div class="erp-titulo" id="erp-titulo">SAP Easy Access</div>
<div class="erp-botones" id="erp-botones" role="toolbar" aria-label="Botones de la aplicación"></div>
<main id="erp-contenido" tabindex="-1"></main>
<footer class="erp-barra-estado" id="erp-barra-estado" role="status" aria-live="polite">
  <span id="erp-estado-icono"></span><span id="erp-estado"></span>
  <span class="erp-sistema"><span id="erp-tx-actual">ERP</span> · MM · ${escapeHtml(operator?.tenant_id || '')}</span>
</footer>
<div class="erp-f4-modal" id="erp-f4" hidden>
  <div class="erp-f4-caja" role="dialog" aria-modal="true" aria-labelledby="erp-f4-titulo">
    <div class="erp-f4-cab"><span id="erp-f4-titulo">Ayuda de búsqueda</span><button id="erp-f4-cerrar" type="button" aria-label="Cerrar">×</button></div>
    <input id="erp-f4-buscar" type="text" placeholder="Buscar… (Enter elige el primero, Esc cierra)" autocomplete="off">
    <ul id="erp-f4-lista"></ul>
  </div>
</div>
<script>
window.ERP = { catalogo: ${jsonSeguro(catalogo)}, screens: {}, centros: [], centroDefault: '' };
${pantallas}
</script>
<script>${ERP_CLIENTE_SCRIPT}</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
