// src/erp/transacciones/inventario.js
// Inventario físico: MI01 crear documento, MI04 contar (a ciegas), MI03 visualizar,
// MI20 lista de diferencias, MI07 contabilizar diferencias (clases 701 / 702).
//
// Stock físico = libre utilización + reservado: lo que la Torre reservó sigue en
// la bodega hasta el packing. La diferencia se ajusta contra el stock libre; si
// falta más de lo libre, falta mercadería ya reservada para pedidos de venta y
// MI07 no contabiliza esa posición (nunca deja stock negativo).

import {
  fallo, texto, cantidad, fecha,
  siguienteNumero, RANGOS, validarCentro, operadorDe,
} from '../core.js';
import { Verificado, moverStock, crearCabecera, insertarPosicion, liberarQuiebres } from './migo.js';

const MENU = ['Logística', 'Gestión de materiales', 'Inventario físico'];
const MAX_POSICIONES = 200;
const ABIERTOS = ['CREADO', 'CONTADO'];

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

export async function leerInventario(client, tenant_id, iblnr, { paraActualizar = false } = {}) {
  const id = texto(iblnr, { campo: 'Documento de inventario', max: 10, requerido: true });
  const cab = await client.query(
    `SELECT f.*, d.nombre AS nombre_centro
     FROM erp_inventario_fisico f
     LEFT JOIN depots d ON d.tenant_id = f.tenant_id AND d.depot_id = f.centro
     WHERE f.tenant_id = $1 AND f.iblnr = $2${paraActualizar ? ' FOR UPDATE OF f' : ''}`,
    [tenant_id, id]
  );
  if (!cab.rowCount) throw fallo(`El documento de inventario ${id} no existe`, 404);
  const c = cab.rows[0];
  const pos = await client.query(
    `SELECT x.zeile, x.sku, p.nombre AS texto_breve, COALESCE(p.unidad, 'UN') AS unidad,
            COALESCE(p.precio_estandar, 0) AS precio_estandar,
            x.cantidad_contada, x.contado_por, x.contado_at, x.qty_libro, x.diferencia,
            COALESCE(i.qty_disponible, 0) AS libre, COALESCE(i.qty_reservada, 0) AS reservado
     FROM erp_inventario_fisico_pos x
     LEFT JOIN productos p ON p.tenant_id = x.tenant_id AND p.sku = x.sku
     LEFT JOIN inventario_bodega i ON i.tenant_id = x.tenant_id AND i.depot_id = $3 AND i.sku = x.sku
     WHERE x.tenant_id = $1 AND x.iblnr = $2
     ORDER BY x.zeile${paraActualizar ? ' FOR UPDATE OF x' : ''}`,
    [tenant_id, id, c.centro]
  );
  const posiciones = pos.rows.map((p) => {
    // Contabilizado: diferencia congelada. Abierto: vista previa contra el libro actual.
    const libro = c.estado === 'CONTABILIZADO' ? Number(p.qty_libro) : r3(Number(p.libre) + Number(p.reservado));
    const contado = p.cantidad_contada == null ? null : Number(p.cantidad_contada);
    const diferencia = c.estado === 'CONTABILIZADO' ? Number(p.diferencia) : (contado == null ? null : r3(contado - libro));
    return {
      ...p,
      libro,
      diferencia,
      valor_diferencia: diferencia == null ? null : Math.round(diferencia * Number(p.precio_estandar) * 100) / 100,
    };
  });
  return { cabecera: c, posiciones };
}

// ─── MI01 ──────────────────────────────────────────────────────────────────
export const MI01 = {
  code: 'MI01',
  titulo: 'Crear documento de inventario',
  menu: MENU,
  async post({ client, tenant_id, body, operator }) {
    const centro = (await validarCentro(client, tenant_id, body.centro)).depot_id;
    const fechaPlan = fecha(body.fecha_planificada, { campo: 'Fecha planificada' });
    const nota = texto(body.texto, { campo: 'Texto', max: 160 });

    let skus;
    if (body.todos === true || body.todos === 'true') {
      const r = await client.query(
        `SELECT sku FROM inventario_bodega WHERE tenant_id = $1 AND depot_id = $2 ORDER BY sku LIMIT $3`,
        [tenant_id, centro, MAX_POSICIONES + 1]
      );
      skus = r.rows.map((x) => x.sku);
      if (!skus.length) throw fallo(`El centro ${centro} no tiene materiales`);
    } else {
      skus = [...new Set((Array.isArray(body.materiales) ? body.materiales : [])
        .map((m) => String((m && m.material) ?? m ?? '').trim()).filter(Boolean))];
      if (!skus.length) throw fallo('Introduzca al menos un material o marque "Todos los materiales del centro"');
      for (const sku of skus) {
        const r = await client.query(
          `SELECT 1 FROM inventario_bodega WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
          [tenant_id, centro, sku]
        );
        if (!r.rowCount) throw fallo(`El material ${sku} no existe en el centro ${centro} (amplíelo con MM02)`, 404);
      }
    }
    if (skus.length > MAX_POSICIONES) {
      throw fallo(`Máximo ${MAX_POSICIONES} materiales por documento: divida el inventario en varios documentos`);
    }

    // Bloqueo SAP: un material no puede estar en dos inventarios abiertos del mismo centro.
    const tomado = await client.query(
      `SELECT x.sku, f.iblnr FROM erp_inventario_fisico_pos x
       JOIN erp_inventario_fisico f ON f.tenant_id = x.tenant_id AND f.iblnr = x.iblnr
       WHERE x.tenant_id = $1 AND f.centro = $2 AND f.estado = ANY($3::text[]) AND x.sku = ANY($4::text[])
       LIMIT 1`,
      [tenant_id, centro, ABIERTOS, skus]
    );
    if (tomado.rowCount) {
      throw fallo(`El material ${tomado.rows[0].sku} ya está en el documento de inventario abierto ${tomado.rows[0].iblnr}`);
    }

    const iblnr = await siguienteNumero(client, tenant_id, RANGOS.INVENTARIO);
    await client.query(
      `INSERT INTO erp_inventario_fisico (tenant_id, iblnr, centro, fecha_planificada, estado, texto, created_by)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), 'CREADO', $5, $6)`,
      [tenant_id, iblnr, centro, fechaPlan, nota, operadorDe(operator)]
    );
    for (let i = 0; i < skus.length; i++) {
      await client.query(
        `INSERT INTO erp_inventario_fisico_pos (tenant_id, iblnr, zeile, sku) VALUES ($1, $2, $3, $4)`,
        [tenant_id, iblnr, i + 1, skus[i]]
      );
    }
    return { mensaje: `Se ha creado el documento de inventario ${iblnr} (${skus.length} posición(es))`, documento: iblnr };
  },
  screen: `function (ui, params) {
    var filas = '';
    for (var i = 0; i < 8; i++) {
      filas += '<tr><td class="erp-num">' + (i + 1) + '</td><td>' + ui.celda({ fila: i, col: 'material', f4: 'material', ancho: 16 }) + '</td></tr>';
    }
    ui.pantalla(
      ui.grupo('Datos del documento',
        ui.campo({ id: 'centro', etiqueta: 'Centro', obligatorio: true, f4: 'centro', valor: params.centro || ui.centroPorDefecto() }) +
        ui.campo({ id: 'fecha_planificada', etiqueta: 'Fecha planificada', tipo: 'date', valor: ui.hoy() }) +
        ui.campo({ id: 'texto', etiqueta: 'Texto', valor: '', ancho: 40, ayuda: 'Ej: Conteo mensual pasillo A' }) +
        ui.campo({ id: 'todos', etiqueta: 'Todos los materiales del centro', tipo: 'check', valor: false })
      ) +
      ui.grupo('Materiales a contar',
        '<table class="erp-tabla erp-tabla-editable"><thead><tr><th>Pos.</th><th>Material</th></tr></thead><tbody>' + filas + '</tbody></table>' +
        '<p class="erp-ayuda">Si marca "Todos los materiales del centro" se ignora esta lista.</p>')
    );
    ui.botones([{ texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
      var v = ui.valores();
      v.materiales = ui.filas();
      var r = await ui.post('MI01', v);
      ui.ir('MI03', { documento: r.documento }, { mensaje: ['S', r.mensaje] });
    } }]);
  }`,
};

// ─── MI03 ──────────────────────────────────────────────────────────────────
const COLUMNAS_DETALLE = `[
  { id: 'zeile', etiqueta: 'Pos.', tipo: 'num' },
  { id: 'sku', etiqueta: 'Material', enlace: function (f) { ui.ir('MMBE', { material: f.sku }); } },
  { id: 'texto_breve', etiqueta: 'Texto breve' },
  { id: 'unidad', etiqueta: 'UM' },
  { id: 'cantidad_contada', etiqueta: 'Contado', tipo: 'qty' },
  { id: 'libro', etiqueta: 'Stock sistema', tipo: 'qty' },
  { id: 'diferencia', etiqueta: 'Diferencia', tipo: 'qty' },
  { id: 'valor_diferencia', etiqueta: 'Valor dif. (CLP)', tipo: 'money' },
  { id: 'contado_por', etiqueta: 'Contado por' },
]`;

export const MI03 = {
  code: 'MI03',
  titulo: 'Visualizar documento de inventario',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    return leerInventario(client, tenant_id, params.documento);
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Documento', ui.campo({ id: 'documento', etiqueta: 'Doc. inventario', obligatorio: true, f4: 'inventario', valor: params.documento || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: async function () {
        var v = ui.valores();
        if (!v.documento) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        mostrar(await ui.get('MI03', { documento: v.documento }));
      } }]);
      ui.foco('documento');
    }
    function mostrar(d) {
      var c = d.cabecera;
      var contadas = d.posiciones.filter(function (p) { return p.cantidad_contada != null; }).length;
      var valor = d.posiciones.reduce(function (s, p) { return s + Number(p.valor_diferencia || 0); }, 0);
      ui.titulo('Documento de inventario ' + c.iblnr + ' — ' + (c.nombre_centro || c.centro));
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'iblnr', etiqueta: 'Documento', valor: c.iblnr, soloLectura: true }) +
          ui.campo({ id: 'centro', etiqueta: 'Centro', valor: c.centro, soloLectura: true, ancho: 30 }) +
          ui.campo({ id: 'estado', etiqueta: 'Estado', valor: c.estado, soloLectura: true }) +
          ui.campo({ id: 'avance', etiqueta: 'Contadas', valor: contadas + ' de ' + d.posiciones.length, soloLectura: true }) +
          ui.campo({ id: 'valor', etiqueta: 'Valor diferencias', valor: ui.dinero(valor) + ' CLP', soloLectura: true }) +
          (c.mblnr ? ui.campo({ id: 'mblnr', etiqueta: 'Doc. material', valor: c.mblnr, soloLectura: true }) : '') +
          (c.texto ? ui.campo({ id: 'texto', etiqueta: 'Texto', valor: c.texto, soloLectura: true, ancho: 40 }) : '')
        ) +
        ui.grupo('Posiciones', ui.tabla(${COLUMNAS_DETALLE}, d.posiciones, {
          resaltar: function (f) { return f.diferencia != null && Number(f.diferencia) !== 0; } })) +
        (c.estado !== 'CONTABILIZADO' ? '<p class="erp-ayuda">"Stock sistema" y "Diferencia" son una vista previa contra el stock actual; se congelan al contabilizar (MI07).</p>' : '')
      );
      var b = [];
      if (c.estado !== 'CONTABILIZADO') {
        b.push({ texto: 'Ingresar conteo (MI04)', primario: true, accion: function () { ui.ir('MI04', { documento: c.iblnr }); } });
        b.push({ texto: 'Contabilizar diferencias (MI07)', accion: function () { ui.ir('MI07', { documento: c.iblnr }); } });
      } else if (c.mblnr) {
        b.push({ texto: 'Ver documento de material', accion: function () { ui.ir('MIGO', { documento: c.mblnr }); } });
      }
      b.push({ texto: 'Otro documento', tecla: 'F3', accion: inicial });
      ui.botones(b);
    }
    if (params.documento) ui.get('MI03', { documento: params.documento }).then(mostrar, inicial);
    else inicial();
  }`,
};

// ─── MI04 ──────────────────────────────────────────────────────────────────
export const MI04 = {
  code: 'MI04',
  titulo: 'Ingresar recuento de inventario',
  menu: MENU,
  // Conteo a ciegas: el que cuenta no ve el stock del sistema (no se "ajusta" el conteo).
  async get({ client, tenant_id, params }) {
    const d = await leerInventario(client, tenant_id, params.documento);
    return {
      cabecera: { iblnr: d.cabecera.iblnr, centro: d.cabecera.centro, nombre_centro: d.cabecera.nombre_centro, estado: d.cabecera.estado },
      posiciones: d.posiciones.map((p) => ({
        zeile: p.zeile, sku: p.sku, texto_breve: p.texto_breve, unidad: p.unidad, cantidad_contada: p.cantidad_contada,
      })),
    };
  },
  async post({ client, tenant_id, body, operator }) {
    const d = await leerInventario(client, tenant_id, body.documento, { paraActualizar: true });
    if (d.cabecera.estado === 'CONTABILIZADO') throw fallo(`El documento ${d.cabecera.iblnr} ya está contabilizado`);
    const porZeile = new Map(d.posiciones.map((p) => [Number(p.zeile), p]));
    let n = 0;
    for (const c of Array.isArray(body.conteos) ? body.conteos : []) {
      if (c == null || c.cantidad === '' || c.cantidad == null) continue; // vacío = no contado
      const zeile = Number(c.zeile);
      const pos = porZeile.get(zeile);
      if (!pos) throw fallo(`La posición ${c.zeile} no existe en el documento ${d.cabecera.iblnr}`);
      const q = cantidad(c.cantidad, { campo: `Cantidad pos. ${zeile}`, permitirCero: true });
      await client.query(
        `UPDATE erp_inventario_fisico_pos
         SET cantidad_contada = $4, contado_por = $5, contado_at = NOW(), qty_libro = $6
         WHERE tenant_id = $1 AND iblnr = $2 AND zeile = $3`,
        [tenant_id, d.cabecera.iblnr, zeile, q, operadorDe(operator), pos.libro]
      );
      pos.cantidad_contada = q;
      n += 1;
    }
    if (!n) throw fallo('Introduzca al menos una cantidad contada (0 si no hay nada)');
    const faltan = d.posiciones.filter((p) => p.cantidad_contada == null).length;
    await client.query(
      `UPDATE erp_inventario_fisico SET estado = $3 WHERE tenant_id = $1 AND iblnr = $2`,
      [tenant_id, d.cabecera.iblnr, faltan ? 'CREADO' : 'CONTADO']
    );
    return {
      mensaje: `Recuento registrado: ${n} posición(es) del documento ${d.cabecera.iblnr}` + (faltan ? ` (faltan ${faltan})` : ' — conteo completo'),
      documento: d.cabecera.iblnr,
    };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Documento', ui.campo({ id: 'documento', etiqueta: 'Doc. inventario', obligatorio: true, f4: 'inventario', valor: params.documento || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: async function () {
        var v = ui.valores();
        if (!v.documento) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        contar(await ui.get('MI04', { documento: v.documento }));
      } }]);
      ui.foco('documento');
    }
    function contar(d) {
      var c = d.cabecera;
      if (c.estado === 'CONTABILIZADO') { ui.mensaje('E', 'El documento ' + c.iblnr + ' ya está contabilizado'); return inicial(); }
      ui.titulo('Recuento inventario ' + c.iblnr + ' — ' + (c.nombre_centro || c.centro));
      var filas = d.posiciones.map(function (p, i) {
        return '<tr><td class="erp-num">' + p.zeile + '<input type="hidden" data-fila="' + i + '" data-col="zeile" value="' + p.zeile + '"></td>' +
          '<td>' + ui.esc(p.sku) + '</td><td class="erp-texto-breve">' + ui.esc(p.texto_breve || '') + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'cantidad', tipo: 'number', valor: p.cantidad_contada == null ? '' : Number(p.cantidad_contada), ancho: 10 }) + '</td>' +
          '<td>' + ui.esc(p.unidad) + '</td></tr>';
      }).join('');
      ui.pantalla(ui.grupo('Recuento',
        '<table class="erp-tabla erp-tabla-editable"><thead><tr><th>Pos.</th><th>Material</th><th>Texto breve</th><th>Cantidad contada</th><th>UM</th></tr></thead><tbody>' + filas + '</tbody></table>' +
        '<p class="erp-ayuda">Cuente lo que hay físicamente en la bodega, incluido lo apartado para pedidos. Deje vacío lo que no contó; escriba <b>0</b> si no hay nada. El stock del sistema no se muestra a propósito (conteo a ciegas).</p>'));
      ui.botones([
        { texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
          var r = await ui.post('MI04', { documento: c.iblnr, conteos: ui.filas() });
          ui.ir('MI03', { documento: c.iblnr }, { mensaje: ['S', r.mensaje] });
        } },
        { texto: 'Otro documento', tecla: 'F3', accion: inicial },
      ]);
      var primero = ui.q('[data-col="cantidad"]');
      if (primero) primero.focus();
    }
    if (params.documento) ui.get('MI04', { documento: params.documento }).then(contar, inicial);
    else inicial();
  }`,
};

// ─── MI20 ──────────────────────────────────────────────────────────────────
export const MI20 = {
  code: 'MI20',
  titulo: 'Lista de diferencias de inventario',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const valores = [tenant_id, ABIERTOS];
    let filtro = '';
    if (params.centro) { valores.push(String(params.centro).slice(0, 64)); filtro = ` AND f.centro = $${valores.length}`; }
    const r = await client.query(
      `SELECT f.iblnr, f.centro, f.estado, x.zeile, x.sku, p.nombre AS texto_breve, COALESCE(p.unidad, 'UN') AS unidad,
              x.cantidad_contada,
              COALESCE(i.qty_disponible, 0) + COALESCE(i.qty_reservada, 0) AS libro,
              x.cantidad_contada - (COALESCE(i.qty_disponible, 0) + COALESCE(i.qty_reservada, 0)) AS diferencia,
              ROUND((x.cantidad_contada - (COALESCE(i.qty_disponible, 0) + COALESCE(i.qty_reservada, 0)))
                    * COALESCE(p.precio_estandar, 0), 2) AS valor_diferencia
       FROM erp_inventario_fisico f
       JOIN erp_inventario_fisico_pos x ON x.tenant_id = f.tenant_id AND x.iblnr = f.iblnr
       LEFT JOIN productos p ON p.tenant_id = x.tenant_id AND p.sku = x.sku
       LEFT JOIN inventario_bodega i ON i.tenant_id = x.tenant_id AND i.depot_id = f.centro AND i.sku = x.sku
       WHERE f.tenant_id = $1 AND f.estado = ANY($2::text[]) AND x.cantidad_contada IS NOT NULL${filtro}
       ORDER BY f.iblnr, x.zeile
       LIMIT 1000`,
      valores
    );
    const filas = params.solo_diferencias === 'true' ? r.rows.filter((x) => Number(x.diferencia) !== 0) : r.rows;
    return { diferencias: filas };
  },
  screen: `function (ui, params) {
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro', valor: params.centro || '' }) +
      ui.campo({ id: 'solo_diferencias', etiqueta: 'Solo posiciones con diferencia', tipo: 'check', valor: true })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('MI20', ui.valores());
      var total = data.diferencias.reduce(function (s, f) { return s + Number(f.valor_diferencia || 0); }, 0);
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'iblnr', etiqueta: 'Doc. inventario', enlace: function (f) { ui.ir('MI03', { documento: f.iblnr }); } },
        { id: 'zeile', etiqueta: 'Pos.', tipo: 'num' },
        { id: 'centro', etiqueta: 'Centro' },
        { id: 'sku', etiqueta: 'Material' },
        { id: 'texto_breve', etiqueta: 'Texto breve' },
        { id: 'cantidad_contada', etiqueta: 'Contado', tipo: 'qty' },
        { id: 'libro', etiqueta: 'Stock sistema', tipo: 'qty' },
        { id: 'diferencia', etiqueta: 'Diferencia', tipo: 'qty' },
        { id: 'unidad', etiqueta: 'UM' },
        { id: 'valor_diferencia', etiqueta: 'Valor dif. (CLP)', tipo: 'money' },
      ], data.diferencias, { resaltar: function (f) { return Number(f.diferencia) !== 0; } });
      ui.mensaje(data.diferencias.length ? 'W' : 'S', data.diferencias.length + ' posición(es) · valor neto de diferencias ' + ui.dinero(total) + ' CLP');
    }
    ui.botones([
      { texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar },
      { texto: 'Crear documento (MI01)', accion: function () { ui.ir('MI01'); } },
    ]);
    ejecutar();
  }`,
};

// ─── MI07 ──────────────────────────────────────────────────────────────────
export const MI07 = {
  code: 'MI07',
  titulo: 'Contabilizar diferencias de inventario',
  menu: MENU,
  async post({ client, tenant_id, body, operator, env }) {
    const d = await leerInventario(client, tenant_id, body.documento, { paraActualizar: true });
    const c = d.cabecera;
    if (c.estado === 'CONTABILIZADO') throw fallo(`El documento ${c.iblnr} ya está contabilizado (documento de material ${c.mblnr || '—'})`);
    const sinContar = d.posiciones.filter((p) => p.cantidad_contada == null).map((p) => p.zeile);
    if (sinContar.length) throw fallo(`Faltan recuentos en las posiciones ${sinContar.slice(0, 10).join(', ')}${sinContar.length > 10 ? '…' : ''} (MI04)`);

    let mblnr = null;
    let zeile = 0;
    let sobrantes = 0;
    let faltantes = 0;
    let valor = 0;
    for (const p of d.posiciones) {
      const inv = await client.query(
        `SELECT qty_disponible, qty_reservada FROM inventario_bodega
         WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3 FOR UPDATE`,
        [tenant_id, c.centro, p.sku]
      );
      const libre = inv.rowCount ? Number(inv.rows[0].qty_disponible) : 0;
      const reservado = inv.rowCount ? Number(inv.rows[0].qty_reservada) : 0;
      const libro = r3(libre + reservado);
      const dif = r3(Number(p.cantidad_contada) - libro);

      if (dif < 0 && -dif > libre + 1e-9) {
        throw fallo(`Pos. ${p.zeile} (${p.sku}): faltan ${-dif} pero solo hay ${libre} libres; ${reservado} están reservados por la Torre para pedidos de venta. Revise esos pedidos (o recuente) antes de contabilizar.`);
      }
      if (dif !== 0) {
        if (!mblnr) {
          mblnr = await crearCabecera(client, tenant_id, {
            fechaContab: null,
            textoCab: `Inventario físico ${c.iblnr}`,
            operator,
          });
        }
        const clase = dif > 0 ? '701' : '702';
        zeile += 1;
        await moverStock(client, { tenant_id, centro: c.centro, sku: p.sku, delta: dif, clase, mblnr });
        const imp = Math.round(Math.abs(dif) * Number(p.precio_estandar) * 100) / 100;
        await insertarPosicion(client, tenant_id, mblnr, {
          zeile, clase, sku: p.sku, cantidad: Math.abs(dif), unidad: p.unidad, centro: c.centro, importe: imp,
        });
        if (dif > 0) sobrantes += 1; else faltantes += 1;
        valor += dif > 0 ? imp : -imp;
      }
      await client.query(
        `UPDATE erp_inventario_fisico_pos SET qty_libro = $4, diferencia = $5
         WHERE tenant_id = $1 AND iblnr = $2 AND zeile = $3`,
        [tenant_id, c.iblnr, p.zeile, libro, dif]
      );
    }
    await client.query(
      `UPDATE erp_inventario_fisico SET estado = 'CONTABILIZADO', mblnr = $3, contabilizado_at = NOW()
       WHERE tenant_id = $1 AND iblnr = $2`,
      [tenant_id, c.iblnr, mblnr]
    );

    // Un sobrante (701) puede alcanzar para pedidos de venta que estaban en quiebre.
    const liberadas = mblnr ? await liberarQuiebres(client, env, tenant_id, mblnr) : [];
    const resumen = zeile
      ? `${sobrantes} sobrante(s) (701), ${faltantes} faltante(s) (702), valor neto ${Math.round(valor)} CLP`
      : 'sin diferencias';
    const extra = liberadas.length ? ` · ${liberadas.length} pedido(s) de venta liberado(s) de quiebre: ${liberadas.slice(0, 5).join(', ')}` : '';
    if (body.solo_verificar) throw new Verificado(`Verificación correcta: ${resumen}${extra.replace('liberado(s)', 'se liberarían')}`);
    return {
      mensaje: mblnr
        ? `Diferencias contabilizadas con el documento de material ${mblnr}: ${resumen}${extra}`
        : `Documento de inventario ${c.iblnr} contabilizado ${resumen}`,
      documento: c.iblnr,
      mblnr,
      liberadas,
      invalidarTorre: true,
    };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Documento', ui.campo({ id: 'documento', etiqueta: 'Doc. inventario', obligatorio: true, f4: 'inventario', valor: params.documento || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: async function () {
        var v = ui.valores();
        if (!v.documento) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        previa(await ui.get('MI03', { documento: v.documento }));
      } }]);
      ui.foco('documento');
    }
    function previa(d) {
      var c = d.cabecera;
      if (c.estado === 'CONTABILIZADO') { ui.ir('MI03', { documento: c.iblnr }, { mensaje: ['W', 'El documento ya está contabilizado'] }); return; }
      ui.titulo('Contabilizar diferencias — inventario ' + c.iblnr);
      ui.pantalla(ui.grupo('Diferencias a contabilizar', ui.tabla(${COLUMNAS_DETALLE}, d.posiciones, {
        resaltar: function (f) { return f.diferencia != null && Number(f.diferencia) !== 0; } })) +
        '<p class="erp-ayuda">Sobrante → clase 701 (sube el stock libre). Faltante → clase 702 (baja el stock libre). Todo queda en un documento de material que puede ver en MB51.</p>');
      async function enviar(verificar) {
        var r = await ui.post('MI07', { documento: c.iblnr, solo_verificar: verificar });
        if (verificar) return ui.mensaje('S', r.mensaje);
        ui.ir('MI03', { documento: c.iblnr }, { mensaje: ['S', r.mensaje] });
      }
      ui.botones([
        { texto: 'Contabilizar', tecla: 'Ctrl+S', primario: true, accion: function () { return enviar(false); } },
        { texto: 'Verificar', accion: function () { return enviar(true); } },
        { texto: 'Otro documento', tecla: 'F3', accion: inicial },
      ]);
    }
    if (params.documento) ui.get('MI03', { documento: params.documento }).then(previa, inicial);
    else inicial();
  }`,
};

export default [MI01, MI04, MI03, MI20, MI07];
