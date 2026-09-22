// src/ui/client/bodega.js
// Pestaña Bodega (WMS-lite): stock, alertas, cola picking → packing → ruteo.

export const BODEGA_SCRIPT = `
        (function initBodegaTab() {
          if (!CONFIG.wms_enabled) return;
          var panel = document.getElementById('panel-bodega');
          if (!panel) return;

          function esc(s) {
            return String(s == null ? '' : s)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          }

          function qty(n) {
            var v = Number(n);
            if (!Number.isFinite(v)) return '0';
            return v % 1 === 0 ? String(v) : v.toFixed(1);
          }

          async function api(path, opts) {
            var res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || data.code || ('HTTP ' + res.status));
            return data;
          }

          function render(data) {
            var bajo = data.stock_bajo || [];
            var cola = data.cola || [];
            var listas = data.listas_sin_trip || [];
            var stock = data.stock || [];
            var depots = data.depots || CONFIG.depots || [];
            var depotOpts = depots.map(function (d) {
              return '<option value="' + esc(d.depot_id) + '">' + esc(d.nombre || d.depot_id) + '</option>';
            }).join('');

            var alertas = '';
            if (bajo.length) {
              alertas += '<div class="bodega-alert bodega-alert-warn"><b>Stock bajo (' + bajo.length + ')</b><ul>' +
                bajo.map(function (s) {
                  return '<li>' + esc(s.sku) + ' · ' + esc(s.nombre || '') + ' — disp. ' + qty(s.qty_disponible) +
                    ' / mín. ' + qty(s.qty_minima) + '</li>';
                }).join('') + '</ul></div>';
            }
            if (data.quiebres && data.quiebres.length) {
              alertas += '<div class="bodega-alert bodega-alert-danger"><b>Quiebre (' + data.quiebres.length + ')</b> — no ruteables.</div>';
            }
            if (listas.length) {
              alertas += '<div class="bodega-alert bodega-alert-ok"><b>Listas sin camión (' + listas.length + ')</b> — ya están en Pedidos pendientes.</div>';
            }
            if (!alertas) alertas = '<div class="bodega-alert">Sin alertas de stock.</div>';

            var colaHtml = cola.length === 0
              ? '<p class="bodega-muted">Sin OTs en picking/packing/quiebre.</p>'
              : cola.map(function (o) {
                  var btns = '';
                  if (o.estado_operacional === 'PENDIENTE_PICKING' || o.estado_operacional === 'PICKING') {
                    btns = '<button class="btn-bodega" data-act="picking" data-ot="' + esc(o.ot_id) + '">Pickeado</button>';
                  } else if (o.estado_operacional === 'PACKING') {
                    btns = '<button class="btn-bodega btn-bodega-ok" data-act="packing" data-ot="' + esc(o.ot_id) + '">Empacado / listo</button>';
                  }
                  var lineas = (o.lineas || []).map(function (l) {
                    return esc(l.sku) + ' × ' + qty(l.qty);
                  }).join(', ');
                  return '<div class="bodega-ot">' +
                    '<div><b>' + esc(o.ot_id) + '</b> · ' + esc(o.cliente || '') +
                    '<div class="bodega-muted">' + esc(o.estado_operacional) + (lineas ? ' · ' + lineas : '') + '</div></div>' +
                    btns + '</div>';
                }).join('');

            var stockHtml = stock.slice(0, 80).map(function (s) {
              var cls = s.stock_bajo ? ' bodega-row-warn' : '';
              return '<tr class="' + cls + '"><td>' + esc(s.sku) + '</td><td>' + esc(s.nombre || '') +
                '</td><td>' + qty(s.qty_disponible) + '</td><td>' + qty(s.qty_reservada) +
                '</td><td>' + qty(s.qty_minima) + '</td><td>' + esc(s.ubicacion || '—') + '</td></tr>';
            }).join('');

            panel.innerHTML =
              '<div class="bodega-wrap">' +
              '<div class="bodega-counts">Bajo: ' + (data.counts && data.counts.stock_bajo || 0) +
              ' · Cola: ' + (data.counts && data.counts.cola || 0) +
              ' · Listas: ' + (data.counts && data.counts.listas_sin_trip || 0) + '</div>' +
              alertas +
              '<h4 class="bodega-h">Cola de procesos</h4>' + colaHtml +
              '<h4 class="bodega-h">Alta SKU</h4>' +
              '<form id="bodegaAltaForm" class="bodega-form">' +
              '<select name="depot_id">' + depotOpts + '</select>' +
              '<input name="sku" placeholder="SKU" required maxlength="64">' +
              '<input name="nombre" placeholder="Nombre" required maxlength="256">' +
              '<input name="qty_inicial" type="number" step="0.001" min="0" placeholder="Stock inicial" value="0">' +
              '<input name="qty_minima" type="number" step="0.001" min="0" placeholder="Mínimo" value="0">' +
              '<input name="ubicacion" placeholder="Ubicación (B-3-12)" maxlength="64">' +
              '<button type="submit" class="btn-bodega btn-bodega-ok">Guardar</button>' +
              '</form>' +
              '<h4 class="bodega-h">Inventario</h4>' +
              '<table class="bodega-table"><thead><tr><th>SKU</th><th>Nombre</th><th>Disp.</th><th>Res.</th><th>Mín.</th><th>Ubic.</th></tr></thead>' +
              '<tbody>' + (stockHtml || '<tr><td colspan="6" class="bodega-muted">Sin SKUs aún.</td></tr>') + '</tbody></table>' +
              '<p class="bodega-muted">Reservar una OT: POST /api/bodega/reservar con ot_id, depot_id y lineas[{sku,qty}].</p>' +
              '</div>';
          }

          async function load() {
            try {
              var data = await api('/api/bodega/resumen');
              render(data);
              var badge = document.querySelector('.tab-btn[data-target="panel-bodega"]');
              if (badge) {
                var n = (data.counts && (data.counts.stock_bajo + data.counts.quiebres)) || 0;
                badge.textContent = n > 0 ? 'Bodega (' + n + ')' : 'Bodega';
              }
            } catch (e) {
              panel.innerHTML = '<p class="bodega-muted">No se pudo cargar bodega: ' + esc(e.message) + '</p>';
            }
          }

          panel.addEventListener('click', async function (e) {
            var btn = e.target.closest('[data-act]');
            if (!btn) return;
            var ot = btn.getAttribute('data-ot');
            var act = btn.getAttribute('data-act');
            btn.disabled = true;
            try {
              await api('/api/bodega/' + act, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ot_id: ot })
              });
              await load();
            } catch (err) {
              alert(err.message);
              btn.disabled = false;
            }
          });

          panel.addEventListener('submit', async function (e) {
            if (e.target.id !== 'bodegaAltaForm') return;
            e.preventDefault();
            var fd = new FormData(e.target);
            try {
              await api('/api/bodega/productos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  depot_id: fd.get('depot_id'),
                  sku: fd.get('sku'),
                  nombre: fd.get('nombre'),
                  qty_inicial: Number(fd.get('qty_inicial') || 0),
                  qty_minima: Number(fd.get('qty_minima') || 0),
                  ubicacion: fd.get('ubicacion') || null
                })
              });
              await load();
            } catch (err) {
              alert(err.message);
            }
          });

          load();
          setInterval(function () {
            if (typeof appState !== 'undefined' && appState.activeTab === 'panel-bodega') load();
          }, 20000);
        })();
`;
