// src/erp/transacciones/pedido.js
// Pedidos de compra: ME21N crear, ME22N modificar, ME23N visualizar, ME2N lista por proveedor/material.
// Un pedido NO mueve stock: el stock entra cuando llega la mercancía (MIGO, clase 101).

import {
  fallo, texto, cantidad, importe, fecha,
  siguienteNumero, RANGOS, validarCentro, leerProveedor, operadorDe, registrarCambio, estadoPedido,
} from '../core.js';

const MENU = ['Logística', 'Gestión de materiales', 'Compras', 'Pedido'];
const MAX_POSICIONES = 50;

export async function leerPedido(client, tenant_id, ebeln, { paraActualizar = false } = {}) {
  const id = texto(ebeln, { campo: 'Pedido', max: 10, requerido: true });
  const cab = await client.query(
    `SELECT pc.*, pr.nombre AS nombre_proveedor
     FROM erp_pedidos_compra pc
     LEFT JOIN erp_proveedores pr ON pr.tenant_id = pc.tenant_id AND pr.proveedor_id = pc.proveedor_id
     WHERE pc.tenant_id = $1 AND pc.ebeln = $2${paraActualizar ? ' FOR UPDATE OF pc' : ''}`,
    [tenant_id, id]
  );
  if (!cab.rowCount) throw fallo(`El pedido ${id} no existe`, 404);
  const pos = await client.query(
    `SELECT ebelp, sku, texto_breve, cantidad, cantidad_recibida, unidad, precio_neto, centro, fecha_entrega, borrado,
            CASE WHEN borrado THEN 0 ELSE GREATEST(cantidad - cantidad_recibida, 0) END AS pendiente,
            CASE WHEN borrado THEN 0 ELSE ROUND(cantidad * precio_neto, 2) END AS valor_neto
     FROM erp_pedidos_compra_pos
     WHERE tenant_id = $1 AND ebeln = $2
     ORDER BY ebelp${paraActualizar ? ' FOR UPDATE' : ''}`,
    [tenant_id, id]
  );
  return { cabecera: cab.rows[0], posiciones: pos.rows };
}

export async function validarPosiciones(client, tenant_id, rawPosiciones, { primerEbelp = 10, maximo = MAX_POSICIONES } = {}) {
  const filas = (Array.isArray(rawPosiciones) ? rawPosiciones : [])
    .filter((p) => p && String(p.material ?? '').trim() !== '');
  if (!filas.length) throw fallo('Introduzca al menos una posición');
  if (filas.length > maximo) throw fallo(`Máximo ${MAX_POSICIONES} posiciones por pedido`);

  const centrosOk = new Map();
  const posiciones = [];
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    const ebelp = primerEbelp + i * 10;
    const sku = texto(f.material, { campo: `Material pos. ${ebelp}`, max: 64, requerido: true });
    const mat = await client.query(
      `SELECT sku, nombre, unidad, activo, precio_estandar FROM productos WHERE tenant_id = $1 AND sku = $2`,
      [tenant_id, sku]
    );
    if (!mat.rowCount) throw fallo(`Pos. ${ebelp}: el material ${sku} no existe (créelo con MM01)`, 404);
    if (!mat.rows[0].activo) throw fallo(`Pos. ${ebelp}: el material ${sku} está inactivo`);

    const centroId = texto(f.centro, { campo: `Centro pos. ${ebelp}`, max: 64, requerido: true });
    if (!centrosOk.has(centroId)) {
      await validarCentro(client, tenant_id, centroId);
      centrosOk.set(centroId, true);
    }
    const precio = f.precio_neto === '' || f.precio_neto == null
      ? Number(mat.rows[0].precio_estandar || 0)
      : importe(f.precio_neto, { campo: `Precio neto pos. ${ebelp}` });

    posiciones.push({
      ebelp,
      sku,
      texto_breve: mat.rows[0].nombre,
      cantidad: cantidad(f.cantidad, { campo: `Cantidad pos. ${ebelp}` }),
      unidad: mat.rows[0].unidad || 'UN',
      precio_neto: precio,
      centro: centroId,
      fecha_entrega: fecha(f.fecha_entrega, { campo: `Fecha entrega pos. ${ebelp}` }),
    });
  }
  return posiciones;
}

export const ME21N = {
  code: 'ME21N',
  titulo: 'Crear pedido',
  menu: MENU,
  async post({ client, tenant_id, body, operator }) {
    const prov = await leerProveedor(client, tenant_id, body.proveedor);
    if (prov.bloqueado) throw fallo(`El proveedor ${prov.proveedor_id} está bloqueado para pedidos`);
    const posiciones = await validarPosiciones(client, tenant_id, body.posiciones);
    const org = texto(body.org_compras, { campo: 'Organización de compras', max: 4 }) || '1000';
    const grupo = texto(body.grupo_compras, { campo: 'Grupo de compras', max: 3 }) || '001';
    const fechaDoc = fecha(body.fecha_documento, { campo: 'Fecha de documento' });
    const nota = texto(body.texto, { campo: 'Texto de cabecera', max: 1000 });
    const total = posiciones.reduce((s, p) => s + p.cantidad * p.precio_neto, 0);

    if (body.solo_verificar) {
      return {
        mensaje: `No se han encontrado errores (${posiciones.length} posición(es), valor neto ${Math.round(total)} ${prov.moneda})`,
        verificado: true,
      };
    }

    const ebeln = await siguienteNumero(client, tenant_id, RANGOS.PEDIDO);
    await client.query(
      `INSERT INTO erp_pedidos_compra (tenant_id, ebeln, clase_documento, proveedor_id, org_compras,
                                       grupo_compras, fecha_documento, moneda, estado, texto, created_by)
       VALUES ($1, $2, 'NB', $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, 'ABIERTO', $8, $9)`,
      [tenant_id, ebeln, prov.proveedor_id, org, grupo, fechaDoc, prov.moneda, nota, operadorDe(operator)]
    );
    for (const p of posiciones) {
      await client.query(
        `INSERT INTO erp_pedidos_compra_pos (tenant_id, ebeln, ebelp, sku, texto_breve, cantidad, unidad,
                                             precio_neto, centro, fecha_entrega)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [tenant_id, ebeln, p.ebelp, p.sku, p.texto_breve, p.cantidad, p.unidad, p.precio_neto, p.centro, p.fecha_entrega]
      );
    }
    return { mensaje: `Pedido estándar creado con el número ${ebeln}`, pedido: ebeln };
  },
  screen: `function (ui, params) {
    var filas = [];
    var prefill = params.material ? [{ material: params.material, cantidad: params.cantidad || '', centro: params.centro || '' }] : [];
    for (var i = 0; i < Math.max(5, prefill.length); i++) filas.push(prefill[i] || {});

    function celdas() {
      return filas.map(function (f, i) {
        return '<tr>' +
          '<td class="erp-num">' + ((i + 1) * 10) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'material', valor: f.material, f4: 'material', ancho: 14 }) + '</td>' +
          '<td class="erp-texto-breve" data-texto="' + i + '">' + ui.esc(f.texto_breve || '') + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'cantidad', valor: f.cantidad, tipo: 'number', ancho: 8 }) + '</td>' +
          '<td data-unidad="' + i + '">' + ui.esc(f.unidad || '') + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'precio_neto', valor: f.precio_neto, tipo: 'number', ancho: 10 }) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'centro', valor: f.centro || ui.centroPorDefecto(), f4: 'centro', ancho: 16 }) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'fecha_entrega', valor: f.fecha_entrega, tipo: 'date' }) + '</td>' +
        '</tr>';
      }).join('');
    }

    function render() {
      var cab = ui.valores();
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'clase', etiqueta: 'Clase de pedido', valor: 'NB Pedido estándar', soloLectura: true }) +
          ui.campo({ id: 'proveedor', etiqueta: 'Proveedor', obligatorio: true, f4: 'proveedor', valor: cab.proveedor || params.proveedor || '' }) +
          ui.campo({ id: 'org_compras', etiqueta: 'Org. compras', valor: cab.org_compras || '1000', ancho: 6 }) +
          ui.campo({ id: 'grupo_compras', etiqueta: 'Grupo de compras', valor: cab.grupo_compras || '001', ancho: 6 }) +
          ui.campo({ id: 'fecha_documento', etiqueta: 'Fecha documento', tipo: 'date', valor: cab.fecha_documento || ui.hoy() }) +
          ui.campo({ id: 'texto', etiqueta: 'Texto cabecera', valor: cab.texto || '', ancho: 50 })
        ) +
        ui.grupo('Resumen de posiciones',
          '<table class="erp-tabla erp-tabla-editable"><thead><tr>' +
          '<th>Pos.</th><th>Material</th><th>Texto breve</th><th>Cantidad</th><th>UM</th><th>Precio neto</th><th>Centro</th><th>Fecha entrega</th>' +
          '</tr></thead><tbody>' + celdas() + '</tbody></table>'
        )
      );
      ui.qa('[data-col="material"]').forEach(function (inp) {
        inp.addEventListener('change', function () { completarMaterial(Number(inp.dataset.fila), inp.value); });
      });
      filas.forEach(function (f, i) { if (f.material && !f.texto_breve) completarMaterial(i, f.material); });
    }

    async function completarMaterial(i, sku) {
      if (!sku) return;
      var data = await ui.get('MM03', { material: sku }, { silencioso: true }).catch(function () { return null; });
      var celdaTexto = ui.q('[data-texto="' + i + '"]');
      var celdaUm = ui.q('[data-unidad="' + i + '"]');
      if (!data) {
        if (celdaTexto) celdaTexto.textContent = '';
        return ui.mensaje('E', 'El material ' + sku + ' no existe');
      }
      if (celdaTexto) celdaTexto.textContent = data.material.nombre;
      if (celdaUm) celdaUm.textContent = data.material.unidad;
      var precio = ui.q('[data-fila="' + i + '"][data-col="precio_neto"]');
      if (precio && !precio.value) precio.value = data.material.precio_estandar || '';
    }

    function cuerpo(soloVerificar) {
      var v = ui.valores();
      v.posiciones = ui.filas();
      v.solo_verificar = !!soloVerificar;
      return v;
    }

    async function grabar() {
      var r = await ui.post('ME21N', cuerpo(false));
      ui.ir('ME23N', { pedido: r.pedido }, { mensaje: ['S', r.mensaje] });
    }
    async function verificar() {
      var r = await ui.post('ME21N', cuerpo(true));
      ui.mensaje('S', r.mensaje);
    }
    function agregarFila() {
      var actuales = ui.filas({ incluirVacias: true });
      filas = actuales.concat([{}, {}, {}]);
      render();
    }

    render();
    ui.botones([
      { texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: grabar },
      { texto: 'Verificar', accion: verificar },
      { texto: 'Añadir posiciones', accion: agregarFila },
    ]);
    ui.foco('proveedor');
  }`,
};

export const ME23N = {
  code: 'ME23N',
  titulo: 'Visualizar pedido',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const pedido = await leerPedido(client, tenant_id, params.pedido);
    const hist = await client.query(
      `SELECT d.mblnr, d.zeile, d.ebelp, d.clase_movimiento, d.cantidad, d.unidad, d.importe,
              m.fecha_contabilizacion, m.anulado_por
       FROM erp_documentos_material_pos d
       JOIN erp_documentos_material m ON m.tenant_id = d.tenant_id AND m.mblnr = d.mblnr
       WHERE d.tenant_id = $1 AND d.ebeln = $2
       ORDER BY d.mblnr, d.zeile`,
      [tenant_id, pedido.cabecera.ebeln]
    );
    const cambios = await client.query(
      `SELECT posicion, campo, valor_antes, valor_despues, usuario, created_at
       FROM erp_cambios
       WHERE tenant_id = $1 AND objeto = 'PEDIDO' AND clave = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      [tenant_id, pedido.cabecera.ebeln]
    );
    return { ...pedido, historial: hist.rows, cambios: cambios.rows };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Pedido', ui.campo({ id: 'pedido', etiqueta: 'Pedido', obligatorio: true, f4: 'pedido', valor: params.pedido || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: async function () {
        var v = ui.valores();
        if (!v.pedido) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        mostrar(await ui.get('ME23N', { pedido: v.pedido }));
      } }]);
      ui.foco('pedido');
    }
    function mostrar(d) {
      var c = d.cabecera;
      var total = d.posiciones.reduce(function (s, p) { return s + Number(p.valor_neto); }, 0);
      ui.titulo('Pedido estándar ' + c.ebeln + ' — ' + (c.nombre_proveedor || c.proveedor_id));
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'ebeln', etiqueta: 'Pedido', valor: c.ebeln, soloLectura: true }) +
          ui.campo({ id: 'proveedor', etiqueta: 'Proveedor', valor: c.proveedor_id + ' ' + (c.nombre_proveedor || ''), soloLectura: true, ancho: 40 }) +
          ui.campo({ id: 'fecha', etiqueta: 'Fecha documento', valor: ui.fecha(c.fecha_documento), soloLectura: true }) +
          ui.campo({ id: 'estado', etiqueta: 'Estado', valor: c.estado, soloLectura: true }) +
          ui.campo({ id: 'total', etiqueta: 'Valor neto total', valor: ui.dinero(total) + ' ' + c.moneda, soloLectura: true }) +
          (c.texto ? ui.campo({ id: 'texto', etiqueta: 'Texto cabecera', valor: c.texto, soloLectura: true, ancho: 50 }) : '')
        ) +
        ui.grupo('Posiciones', ui.tabla([
          { id: 'ebelp', etiqueta: 'Pos.', tipo: 'num' },
          { id: 'sku', etiqueta: 'Material', enlace: function (f) { ui.ir('MM03', { material: f.sku }); } },
          { id: 'texto_breve', etiqueta: 'Texto breve' },
          { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
          { id: 'cantidad_recibida', etiqueta: 'Recibido', tipo: 'qty' },
          { id: 'pendiente', etiqueta: 'Por entregar', tipo: 'qty' },
          { id: 'precio_neto', etiqueta: 'Precio neto', tipo: 'money' },
          { id: 'valor_neto', etiqueta: 'Valor neto', tipo: 'money' },
          { id: 'centro', etiqueta: 'Centro' },
          { id: 'fecha_entrega', etiqueta: 'Fecha entrega', tipo: 'date' },
          { id: 'borrado', etiqueta: 'Borrado', tipo: 'check' },
        ], d.posiciones)) +
        ui.grupo('Historial de pedido', d.historial.length ? ui.tabla([
          { id: 'clase_movimiento', etiqueta: 'CMv' },
          { id: 'mblnr', etiqueta: 'Doc. material', enlace: function (f) { ui.ir('MB51', { documento: f.mblnr }); } },
          { id: 'ebelp', etiqueta: 'Pos.', tipo: 'num' },
          { id: 'fecha_contabilizacion', etiqueta: 'Fe. contab.', tipo: 'date' },
          { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
          { id: 'importe', etiqueta: 'Importe', tipo: 'money' },
          { id: 'anulado_por', etiqueta: 'Anulado por' },
        ], d.historial) : '<p class="erp-ayuda">Sin entradas de mercancía todavía.</p>') +
        ui.grupo('Modificaciones', (d.cambios || []).length ? ui.tabla([
          { id: 'created_at', etiqueta: 'Fecha', tipo: 'date' },
          { id: 'usuario', etiqueta: 'Usuario' },
          { id: 'posicion', etiqueta: 'Pos.' },
          { id: 'campo', etiqueta: 'Campo' },
          { id: 'valor_antes', etiqueta: 'Valor anterior' },
          { id: 'valor_despues', etiqueta: 'Valor nuevo' },
        ], d.cambios) : '<p class="erp-ayuda">El pedido no ha sido modificado.</p>')
      );
      var botones = [
        { texto: 'Modificar (ME22N)', accion: function () { ui.ir('ME22N', { pedido: c.ebeln }); } },
        { texto: 'Otro pedido', tecla: 'F3', accion: inicial },
      ];
      if (c.estado !== 'CERRADO') botones.unshift({ texto: 'Entrada de mercancías (MIGO)', primario: true, accion: function () { ui.ir('MIGO', { pedido: c.ebeln }); } });
      ui.botones(botones);
    }
    if (params.pedido) ui.get('ME23N', { pedido: params.pedido }).then(mostrar, inicial);
    else inicial();
  }`,
};

const siNo = (b) => (b ? 'sí' : 'no');
const numTxt = (n) => String(Number(n));

export const ME22N = {
  code: 'ME22N',
  titulo: 'Modificar pedido',
  menu: MENU,
  // Reglas (las mismas de SAP):
  //  - la cantidad no puede quedar bajo lo ya recibido;
  //  - el precio solo cambia en posiciones sin entradas de mercancía;
  //  - borrar = indicador de borrado (la posición queda, sin pendiente), solo sin entradas;
  //    se puede quitar el indicador para restaurarla;
  //  - cada campo modificado queda en erp_cambios (ME23N → Modificaciones).
  async post({ client, tenant_id, body, operator }) {
    const pedido = await leerPedido(client, tenant_id, body.pedido, { paraActualizar: true });
    const ebeln = pedido.cabecera.ebeln;
    let cambios = 0;
    const cambio = async (posicion, campo, antes, despues) => {
      if (await registrarCambio(client, { tenant_id, objeto: 'PEDIDO', clave: ebeln, posicion, campo, antes, despues, operator })) {
        cambios += 1;
      }
    };

    if (body.texto !== undefined) {
      const nuevo = texto(body.texto, { campo: 'Texto cabecera', max: 1000 });
      if ((nuevo || '') !== (pedido.cabecera.texto || '')) {
        await client.query(`UPDATE erp_pedidos_compra SET texto = $3 WHERE tenant_id = $1 AND ebeln = $2`, [tenant_id, ebeln, nuevo]);
        await cambio(null, 'Texto cabecera', pedido.cabecera.texto, nuevo);
      }
    }

    const porEbelp = new Map(pedido.posiciones.map((p) => [Number(p.ebelp), p]));
    const vistos = new Set();
    for (const m of Array.isArray(body.posiciones) ? body.posiciones : []) {
      const ebelp = Number(m?.ebelp);
      const pos = porEbelp.get(ebelp);
      if (!pos) throw fallo(`La posición ${m?.ebelp} no existe en el pedido ${ebeln}`);
      if (vistos.has(ebelp)) throw fallo(`La posición ${ebelp} está repetida`);
      vistos.add(ebelp);
      const recibido = Number(pos.cantidad_recibida);
      const set = (col, valor) => client.query(
        `UPDATE erp_pedidos_compra_pos SET ${col} = $4 WHERE tenant_id = $1 AND ebeln = $2 AND ebelp = $3`,
        [tenant_id, ebeln, ebelp, valor]
      );

      if (m.borrar !== undefined && m.borrar !== '') {
        const borrar = m.borrar === true || m.borrar === 'true';
        if (borrar !== Boolean(pos.borrado)) {
          if (borrar && recibido > 0) {
            throw fallo(`Pos. ${ebelp}: tiene entradas de mercancía (${recibido}); anúlelas en MIGO antes de borrarla`);
          }
          await set('borrado', borrar);
          await cambio(ebelp, 'Indicador de borrado', siNo(pos.borrado), siNo(borrar));
          pos.borrado = borrar;
        }
      }
      if (pos.borrado) continue; // una posición borrada no se modifica

      if (m.cantidad !== undefined && m.cantidad !== '') {
        const q = cantidad(m.cantidad, { campo: `Cantidad pos. ${ebelp}` });
        if (q !== Number(pos.cantidad)) {
          if (q < recibido) throw fallo(`Pos. ${ebelp}: la cantidad no puede ser menor que lo ya recibido (${recibido})`);
          await set('cantidad', q);
          await cambio(ebelp, 'Cantidad', numTxt(pos.cantidad), numTxt(q));
          pos.cantidad = q;
        }
      }
      if (m.precio_neto !== undefined && m.precio_neto !== '') {
        const p = importe(m.precio_neto, { campo: `Precio neto pos. ${ebelp}` });
        if (p !== Number(pos.precio_neto)) {
          if (recibido > 0) throw fallo(`Pos. ${ebelp}: tiene entradas de mercancía; el precio ya no se puede modificar`);
          await set('precio_neto', p);
          await cambio(ebelp, 'Precio neto', numTxt(pos.precio_neto), numTxt(p));
        }
      }
      if (m.fecha_entrega !== undefined) {
        const f = fecha(m.fecha_entrega, { campo: `Fecha entrega pos. ${ebelp}` });
        const actual = pos.fecha_entrega ? new Date(pos.fecha_entrega).toISOString().slice(0, 10) : null;
        if ((f || null) !== actual) {
          await set('fecha_entrega', f);
          await cambio(ebelp, 'Fecha de entrega', actual, f);
        }
      }
    }

    const nuevas = (Array.isArray(body.nuevas) ? body.nuevas : []).filter((p) => p && String(p.material ?? '').trim() !== '');
    if (nuevas.length) {
      const prov = await leerProveedor(client, tenant_id, pedido.cabecera.proveedor_id);
      if (prov.bloqueado) throw fallo(`El proveedor ${prov.proveedor_id} está bloqueado: no se pueden añadir posiciones`);
      const maxEbelp = pedido.posiciones.reduce((m, p) => Math.max(m, Number(p.ebelp)), 0);
      const validadas = await validarPosiciones(client, tenant_id, nuevas, {
        primerEbelp: maxEbelp + 10,
        maximo: MAX_POSICIONES - pedido.posiciones.length,
      });
      for (const p of validadas) {
        await client.query(
          `INSERT INTO erp_pedidos_compra_pos (tenant_id, ebeln, ebelp, sku, texto_breve, cantidad, unidad,
                                               precio_neto, centro, fecha_entrega)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [tenant_id, ebeln, p.ebelp, p.sku, p.texto_breve, p.cantidad, p.unidad, p.precio_neto, p.centro, p.fecha_entrega]
        );
        await cambio(p.ebelp, 'Posición creada', '', `${p.sku} × ${p.cantidad}`);
      }
    }

    if (!cambios) return { tipo: 'W', mensaje: 'No se han modificado datos', pedido: ebeln };

    const actualizado = await leerPedido(client, tenant_id, ebeln);
    await client.query(
      `UPDATE erp_pedidos_compra SET estado = $3 WHERE tenant_id = $1 AND ebeln = $2`,
      [tenant_id, ebeln, estadoPedido(actualizado.posiciones)]
    );
    return { mensaje: `Pedido estándar ${ebeln} modificado (${cambios} cambio(s))`, pedido: ebeln };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Pedido', ui.campo({ id: 'pedido', etiqueta: 'Pedido', obligatorio: true, f4: 'pedido', valor: params.pedido || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: async function () {
        var v = ui.valores();
        if (!v.pedido) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        editar(await ui.get('ME23N', { pedido: v.pedido }));
      } }]);
      ui.foco('pedido');
    }

    function editar(d) {
      var c = d.cabecera;
      var n = d.posiciones.length;
      ui.titulo('Modificar pedido estándar ' + c.ebeln + ' — ' + (c.nombre_proveedor || c.proveedor_id));
      var filas = d.posiciones.map(function (p, i) {
        var recibido = Number(p.cantidad_recibida);
        var bloq = !!p.borrado;
        return '<tr' + (bloq ? ' class="erp-fila-inactiva"' : '') + '>' +
          '<td class="erp-num">' + p.ebelp + '<input type="hidden" data-fila="' + i + '" data-col="ebelp" value="' + p.ebelp + '"></td>' +
          '<td>' + ui.esc(p.sku) + '</td><td class="erp-texto-breve">' + ui.esc(p.texto_breve || '') + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'cantidad', tipo: 'number', valor: Number(p.cantidad), ancho: 8, soloLectura: bloq }) + '</td>' +
          '<td class="erp-num">' + ui.num(recibido) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'precio_neto', tipo: 'number', valor: Number(p.precio_neto), ancho: 10, soloLectura: bloq || recibido > 0 }) + '</td>' +
          '<td>' + ui.esc(p.centro) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'fecha_entrega', tipo: 'date', valor: p.fecha_entrega ? String(p.fecha_entrega).slice(0, 10) : '', soloLectura: bloq }) + '</td>' +
          '<td>' + ui.celda({ fila: i, col: 'borrar', tipo: 'check', valor: bloq, soloLectura: recibido > 0 }) + '</td>' +
        '</tr>';
      }).join('');
      var nuevas = '';
      for (var j = 0; j < 3; j++) {
        var k = n + j;
        nuevas += '<tr><td class="erp-num">nueva</td>' +
          '<td colspan="2">' + ui.celda({ fila: k, col: 'material', f4: 'material', ancho: 14 }) + '</td>' +
          '<td>' + ui.celda({ fila: k, col: 'cantidad', tipo: 'number', ancho: 8 }) + '</td><td></td>' +
          '<td>' + ui.celda({ fila: k, col: 'precio_neto', tipo: 'number', ancho: 10 }) + '</td>' +
          '<td>' + ui.celda({ fila: k, col: 'centro', f4: 'centro', valor: ui.centroPorDefecto(), ancho: 16 }) + '</td>' +
          '<td>' + ui.celda({ fila: k, col: 'fecha_entrega', tipo: 'date' }) + '</td><td></td></tr>';
      }
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'proveedor', etiqueta: 'Proveedor', valor: c.proveedor_id + ' ' + (c.nombre_proveedor || ''), soloLectura: true, ancho: 40 }) +
          ui.campo({ id: 'estado', etiqueta: 'Estado', valor: c.estado, soloLectura: true }) +
          ui.campo({ id: 'texto', etiqueta: 'Texto cabecera', valor: c.texto || '', ancho: 50 })
        ) +
        ui.grupo('Posiciones',
          '<table class="erp-tabla erp-tabla-editable"><thead><tr><th>Pos.</th><th>Material</th><th>Texto breve</th><th>Cantidad</th><th>Recibido</th><th>Precio neto</th><th>Centro</th><th>Fecha entrega</th><th>Borrar</th></tr></thead><tbody>' +
          filas + nuevas + '</tbody></table>' +
          '<p class="erp-ayuda">La cantidad no puede quedar bajo lo recibido. Precio y borrado solo en posiciones sin entradas de mercancía. Para añadir posiciones use las filas "nueva".</p>')
      );
      ui.botones([
        { texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
          var todas = ui.filas();
          var body = {
            pedido: c.ebeln,
            texto: ui.valores().texto,
            posiciones: todas.filter(function (f) { return f.ebelp; }),
            nuevas: todas.filter(function (f) { return f.material; }),
          };
          var r = await ui.post('ME22N', body);
          if (r.tipo === 'W') return ui.mensaje('W', r.mensaje);
          ui.ir('ME23N', { pedido: c.ebeln }, { mensaje: ['S', r.mensaje] });
        } },
        { texto: 'Visualizar (ME23N)', accion: function () { ui.ir('ME23N', { pedido: c.ebeln }); } },
        { texto: 'Otro pedido', tecla: 'F3', accion: inicial },
      ]);
    }

    if (params.pedido) ui.get('ME23N', { pedido: params.pedido }).then(editar, inicial);
    else inicial();
  }`,
};

export const ME2N = {
  code: 'ME2N',
  titulo: 'Pedidos por número / proveedor',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const filtros = ['pc.tenant_id = $1'];
    const valores = [tenant_id];
    const add = (sql, v) => { valores.push(v); filtros.push(sql.replace('?', `$${valores.length}`)); };
    if (params.proveedor) add('pc.proveedor_id = ?', String(params.proveedor).slice(0, 10));
    if (params.material) add('p.sku = ?', String(params.material).slice(0, 64));
    if (params.centro) add('p.centro = ?', String(params.centro).slice(0, 64));
    if (params.estado) add('pc.estado = ?', String(params.estado).slice(0, 12));
    if (params.solo_pendientes === 'true' || params.solo_pendientes === true) {
      filtros.push('p.cantidad > p.cantidad_recibida AND NOT p.borrado');
    }
    const r = await client.query(
      `SELECT pc.ebeln, p.ebelp, pc.proveedor_id, pr.nombre AS nombre_proveedor, pc.fecha_documento,
              pc.estado, p.sku, p.texto_breve, p.cantidad, p.cantidad_recibida,
              CASE WHEN p.borrado THEN 0 ELSE GREATEST(p.cantidad - p.cantidad_recibida, 0) END AS pendiente, p.unidad, p.borrado,
              p.precio_neto, ROUND(p.cantidad * p.precio_neto, 2) AS valor_neto, p.centro, p.fecha_entrega
       FROM erp_pedidos_compra pc
       JOIN erp_pedidos_compra_pos p ON p.tenant_id = pc.tenant_id AND p.ebeln = pc.ebeln
       LEFT JOIN erp_proveedores pr ON pr.tenant_id = pc.tenant_id AND pr.proveedor_id = pc.proveedor_id
       WHERE ${filtros.join(' AND ')}
       ORDER BY pc.ebeln DESC, p.ebelp
       LIMIT 500`,
      valores
    );
    return { posiciones: r.rows };
  },
  screen: `function (ui, params) {
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'proveedor', etiqueta: 'Proveedor', f4: 'proveedor', valor: params.proveedor || '' }) +
      ui.campo({ id: 'material', etiqueta: 'Material', f4: 'material', valor: params.material || '' }) +
      ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro', valor: params.centro || '' }) +
      ui.campo({ id: 'estado', etiqueta: 'Estado', tipo: 'select', valor: params.estado || '',
        opciones: [['', '(todos)'], ['ABIERTO', 'Abierto'], ['PARCIAL', 'Entregado parcial'], ['CERRADO', 'Cerrado']] }) +
      ui.campo({ id: 'solo_pendientes', etiqueta: 'Solo por entregar', tipo: 'check', valor: false })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('ME2N', ui.valores());
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'ebeln', etiqueta: 'Pedido', enlace: function (f) { ui.ir('ME23N', { pedido: f.ebeln }); } },
        { id: 'ebelp', etiqueta: 'Pos.', tipo: 'num' },
        { id: 'proveedor_id', etiqueta: 'Proveedor' },
        { id: 'nombre_proveedor', etiqueta: 'Nombre' },
        { id: 'fecha_documento', etiqueta: 'Fecha doc.', tipo: 'date' },
        { id: 'sku', etiqueta: 'Material' },
        { id: 'texto_breve', etiqueta: 'Texto breve' },
        { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
        { id: 'pendiente', etiqueta: 'Por entregar', tipo: 'qty' },
        { id: 'unidad', etiqueta: 'UM' },
        { id: 'valor_neto', etiqueta: 'Valor neto', tipo: 'money' },
        { id: 'centro', etiqueta: 'Centro' },
        { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      ], data.posiciones);
      ui.mensaje('S', data.posiciones.length + ' posición(es) seleccionada(s)');
    }
    ui.botones([
      { texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar },
      { texto: 'Crear pedido (ME21N)', accion: function () { ui.ir('ME21N'); } },
    ]);
    ejecutar();
  }`,
};

export default [ME21N, ME22N, ME23N, ME2N];
