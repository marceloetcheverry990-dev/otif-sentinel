// src/erp/transacciones/orden-produccion.js
// Órdenes de producción: CO01 crear, CO02 modificar / liberar / cierre técnico,
// CO03 visualizar, COOIS lista de órdenes.
//
// Ciclo de vida (estados de sistema SAP):
//   CRTD abierta ──Liberar──▶ REL liberada (insumos apartados)
//        │                     │ MIGO 261 consumo · MIGO 101 entrada de lo fabricado
//        │                     ▼
//        │                   PDLV entregada parcial ──▶ DLV entregada
//        │                     │
//        └──Borrar──▶ DLFL      └──Cierre técnico──▶ TECO (lo apartado vuelve a libre)

import {
  fallo, texto, cantidad, fecha,
  siguienteNumero, RANGOS, validarCentro, registrarCambio, operadorDe,
} from '../core.js';
import {
  ESTADOS_ORDEN, ESTADOS_CON_MOVIMIENTOS, r3,
  leerLista, leerMaterialFabricable, explotarLista, necesidadPorMaterial,
  leerOrden, reservarOrden, devolverReservas, leerEstadoFiltro,
} from '../produccion.js';
import { isWmsEnabledForTenant, reintentarQuiebres } from '../../helpers/wms-stock.js';

const MENU = ['Logística', 'Producción', 'Control de fabricación', 'Orden'];
const OBJETO = 'ORDEN_PROD';

const numTxt = (n) => String(Number(n));
const estadoTxt = (e) => `${e} ${ESTADOS_ORDEN[e] || ''}`.trim();

/** Stock libre de cada insumo contra lo que necesita la orden (sumado por material). */
async function disponibilidad(client, tenant_id, centro, componentes) {
  const necesidad = necesidadPorMaterial(componentes, 'cantidad_necesaria');
  const libres = new Map();
  for (const sku of necesidad.keys()) {
    const r = await client.query(
      `SELECT qty_disponible FROM inventario_bodega WHERE tenant_id = $1 AND depot_id = $2 AND sku = $3`,
      [tenant_id, centro, sku]
    );
    libres.set(sku, r.rowCount ? Number(r.rows[0].qty_disponible) : 0);
  }
  return componentes.map((c) => {
    const libre = libres.get(c.sku) ?? 0;
    return {
      ...c,
      libre,
      falta: r3(Math.max(necesidad.get(c.sku) - libre, 0)),
    };
  });
}

async function cambiarEstado(client, tenant_id, orden, nuevo, operator, extraSql = '') {
  const antes = orden.cabecera.estado;
  await client.query(
    `UPDATE erp_ordenes_produccion SET estado = $3${extraSql} WHERE tenant_id = $1 AND aufnr = $2`,
    [tenant_id, orden.cabecera.aufnr, nuevo]
  );
  await registrarCambio(client, {
    tenant_id, objeto: OBJETO, clave: orden.cabecera.aufnr, campo: 'Estado',
    antes: estadoTxt(antes), despues: estadoTxt(nuevo), operator,
  });
  orden.cabecera.estado = nuevo;
}

async function liberar(client, tenant_id, orden, operator) {
  if (orden.cabecera.estado !== 'CRTD') {
    throw fallo(`La orden ${orden.cabecera.aufnr} ya no está abierta (estado ${estadoTxt(orden.cabecera.estado)})`);
  }
  await reservarOrden(client, tenant_id, orden);
  await cambiarEstado(client, tenant_id, orden, 'REL', operator, ', liberada_at = NOW()');
}

/** Reescala los componentes a una nueva cantidad de orden (misma proporción). */
async function reescalar(client, tenant_id, orden, nuevaCantidad) {
  const factor = nuevaCantidad / Number(orden.cabecera.cantidad);
  for (const c of orden.componentes) {
    const q = Math.max(r3(Number(c.cantidad_necesaria) * factor), 0.001);
    await client.query(
      `UPDATE erp_ordenes_componentes SET cantidad_necesaria = $4 WHERE tenant_id = $1 AND aufnr = $2 AND posicion = $3`,
      [tenant_id, orden.cabecera.aufnr, c.posicion, q]
    );
    c.cantidad_necesaria = q;
  }
}

async function reintentarVentas(client, env, tenant_id, porCentro) {
  if (!porCentro.size || !(await isWmsEnabledForTenant(client, env, tenant_id))) return [];
  const liberadas = [];
  for (const [centro, skus] of porCentro) {
    const r = await reintentarQuiebres(client, { tenant_id, depot_id: centro, skus: [...skus] });
    liberadas.push(...r.liberadas);
  }
  return liberadas;
}

export const CO01 = {
  code: 'CO01',
  titulo: 'Crear orden de producción',
  menu: MENU,
  async post({ client, tenant_id, body, operator }) {
    const mat = await leerMaterialFabricable(client, tenant_id, body.material);
    const centro = await validarCentro(client, tenant_id, body.centro);
    const lista = await leerLista(client, tenant_id, mat.sku, centro.depot_id);
    const q = cantidad(body.cantidad, { campo: 'Cantidad total' });
    const inicio = fecha(body.fecha_inicio, { campo: 'Fecha de inicio' });
    const fin = fecha(body.fecha_fin, { campo: 'Fecha de fin' });
    if (inicio && fin && fin < inicio) throw fallo('La fecha de fin no puede ser anterior a la de inicio');
    const nota = texto(body.texto, { campo: 'Texto', max: 160 });
    const conLiberacion = body.liberar === true || body.liberar === 'true';

    const precios = new Map(lista.posiciones.map((p) => [Number(p.posicion), Number(p.precio_estandar || 0)]));
    const componentes = explotarLista(lista.cabecera, lista.posiciones, q)
      .map((c) => ({ ...c, centro: centro.depot_id, precio_plan: precios.get(c.posicion) || 0 }));
    const disp = await disponibilidad(client, tenant_id, centro.depot_id, componentes);

    if (body.solo_verificar) {
      const faltan = [...new Set(disp.filter((d) => d.falta > 0).map((d) => d.sku))];
      return {
        tipo: faltan.length ? 'W' : 'S',
        mensaje: faltan.length
          ? `Faltan insumos para liberar la orden: ${faltan.slice(0, 5).join(', ')}${faltan.length > 5 ? '…' : ''}. Se puede grabar sin liberar.`
          : `Hay stock libre para los ${disp.length} componente(s)`,
        componentes: disp,
        verificado: true,
      };
    }

    const aufnr = await siguienteNumero(client, tenant_id, RANGOS.ORDEN_PRODUCCION);
    await client.query(
      `INSERT INTO erp_ordenes_produccion (tenant_id, aufnr, clase_orden, sku, centro, alternativa, cantidad, unidad,
                                           fecha_inicio, fecha_fin, estado, texto, created_by)
       VALUES ($1, $2, 'PP01', $3, $4, '01', $5, $6, COALESCE($7::date, CURRENT_DATE), $8, 'CRTD', $9, $10)`,
      [tenant_id, aufnr, mat.sku, centro.depot_id, q, mat.unidad || 'UN', inicio, fin, nota, operadorDe(operator)]
    );
    for (const c of componentes) {
      await client.query(
        `INSERT INTO erp_ordenes_componentes (tenant_id, aufnr, posicion, sku, centro, cantidad_necesaria, unidad,
                                              merma_pct, backflush, precio_plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [tenant_id, aufnr, c.posicion, c.sku, c.centro, c.cantidad_necesaria, c.unidad, c.merma_pct, c.backflush, c.precio_plan]
      );
    }
    if (conLiberacion) {
      const orden = await leerOrden(client, tenant_id, aufnr, { paraActualizar: true });
      try {
        await liberar(client, tenant_id, orden, operator);
      } catch (e) {
        if (e.faltantes) e.message += '. Grabe la orden sin "Liberar" y libérela (CO02) cuando llegue el stock.';
        throw e;
      }
    }
    return {
      mensaje: conLiberacion
        ? `Orden de producción ${aufnr} creada y liberada: sus insumos quedaron apartados`
        : `Orden de producción ${aufnr} creada`,
      orden: aufnr,
      invalidarTorre: conLiberacion,
    };
  },
  screen: `function (ui, params) {
    ui.pantalla(
      ui.grupo('Orden de producción',
        ui.campo({ id: 'material', etiqueta: 'Material', obligatorio: true, f4: 'material', valor: params.material || '', ayuda: 'Debe tener lista de materiales (CS01)' }) +
        ui.campo({ id: 'centro', etiqueta: 'Centro de producción', obligatorio: true, f4: 'centro', valor: params.centro || ui.centroPorDefecto() }) +
        ui.campo({ id: 'clase', etiqueta: 'Clase de orden', valor: 'PP01 Orden de producción', soloLectura: true })
      ) +
      ui.grupo('Cantidades y fechas',
        ui.campo({ id: 'cantidad', etiqueta: 'Cantidad total', tipo: 'number', obligatorio: true, valor: params.cantidad || '', ancho: 10 }) +
        ui.campo({ id: 'fecha_inicio', etiqueta: 'Inicio', tipo: 'date', valor: ui.hoy() }) +
        ui.campo({ id: 'fecha_fin', etiqueta: 'Fin', tipo: 'date', valor: '' }) +
        ui.campo({ id: 'texto', etiqueta: 'Texto', valor: '', ancho: 40 }) +
        ui.campo({ id: 'liberar', etiqueta: 'Liberar al grabar (aparta los insumos)', tipo: 'check', valor: false })
      ) +
      '<div id="componentes"></div>'
    );
    function mostrarComponentes(lista) {
      ui.q('#componentes').innerHTML = ui.grupo('Componentes y disponibilidad', ui.tabla([
        { id: 'posicion', etiqueta: 'Pos.', tipo: 'num' },
        { id: 'sku', etiqueta: 'Componente' },
        { id: 'cantidad_necesaria', etiqueta: 'Necesario', tipo: 'qty' },
        { id: 'unidad', etiqueta: 'UM' },
        { id: 'libre', etiqueta: 'Libre en centro', tipo: 'qty' },
        { id: 'falta', etiqueta: 'Falta', tipo: 'qty' },
        { id: 'backflush', etiqueta: 'Desc. automático', tipo: 'check' },
      ], lista, { resaltar: function (f) { return Number(f.falta) > 0; } }));
    }
    function cuerpo(soloVerificar) {
      var v = ui.valores();
      v.solo_verificar = !!soloVerificar;
      return v;
    }
    ui.botones([
      { texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
        var r = await ui.post('CO01', cuerpo(false));
        ui.ir('CO03', { orden: r.orden }, { mensaje: ['S', r.mensaje] });
      } },
      { texto: 'Verificar disponibilidad', accion: async function () {
        var r = await ui.post('CO01', cuerpo(true));
        mostrarComponentes(r.componentes || []);
        ui.mensaje(r.tipo === 'W' ? 'W' : 'S', r.mensaje);
      } },
    ]);
    ui.foco(params.material ? 'cantidad' : 'material');
  }`,
};

export const CO02 = {
  code: 'CO02',
  titulo: 'Modificar orden de producción',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    return leerOrden(client, tenant_id, params.orden);
  },
  async post({ client, tenant_id, body, operator, env }) {
    const orden = await leerOrden(client, tenant_id, body.orden, { paraActualizar: true });
    const c = orden.cabecera;
    const accion = String(body.accion || 'modificar');

    if (accion === 'liberar') {
      await liberar(client, tenant_id, orden, operator);
      return { mensaje: `Orden ${c.aufnr} liberada: sus insumos quedaron apartados`, orden: c.aufnr, invalidarTorre: true };
    }

    if (accion === 'teco') {
      if (c.estado === 'TECO') throw fallo(`La orden ${c.aufnr} ya tiene cierre técnico`);
      if (c.estado === 'DLFL') throw fallo(`La orden ${c.aufnr} está marcada para borrar`);
      const devueltos = await devolverReservas(client, tenant_id, orden);
      await cambiarEstado(client, tenant_id, orden, 'TECO', operator, ', cerrada_at = NOW()');
      const liberadas = await reintentarVentas(client, env, tenant_id, devueltos);
      const n = [...devueltos.values()].reduce((s, set) => s + set.size, 0);
      return {
        mensaje: `Orden ${c.aufnr} con cierre técnico${n ? `: ${n} insumo(s) apartados volvieron a libre utilización` : ''}` +
          (liberadas.length ? ` · ${liberadas.length} pedido(s) de venta liberado(s) de quiebre: ${liberadas.slice(0, 5).join(', ')}` : ''),
        orden: c.aufnr,
        invalidarTorre: true,
      };
    }

    if (accion === 'borrar') {
      if (c.estado !== 'CRTD') throw fallo(`Solo se puede borrar una orden abierta (CRTD); esta está en ${estadoTxt(c.estado)}. Use el cierre técnico.`);
      await cambiarEstado(client, tenant_id, orden, 'DLFL', operator);
      return { mensaje: `Orden ${c.aufnr} marcada para borrar`, orden: c.aufnr };
    }

    if (accion !== 'modificar') throw fallo(`Acción ${accion} no soportada`);
    if (c.estado === 'TECO' || c.estado === 'DLFL') throw fallo(`La orden ${c.aufnr} (${estadoTxt(c.estado)}) ya no se puede modificar`);

    const cambios = [];
    const anota = (campo, antes, despues) => {
      if (String(antes ?? '') !== String(despues ?? '')) cambios.push({ campo, antes, despues });
    };
    const q = cantidad(body.cantidad, { campo: 'Cantidad total' });
    const inicio = fecha(body.fecha_inicio, { campo: 'Fecha de inicio' });
    const fin = fecha(body.fecha_fin, { campo: 'Fecha de fin' });
    if (inicio && fin && fin < inicio) throw fallo('La fecha de fin no puede ser anterior a la de inicio');
    const nota = texto(body.texto, { campo: 'Texto', max: 160 });
    const fechaTxt = (f) => (f ? String(f).slice(0, 10) : '');

    const cambiaCantidad = numTxt(c.cantidad) !== numTxt(q);
    if (cambiaCantidad) {
      const conMovimientos = Number(c.cantidad_entregada) > 0 || orden.componentes.some((x) => Number(x.cantidad_retirada) > 0);
      if (conMovimientos) {
        throw fallo(`La orden ${c.aufnr} ya tiene consumos o entradas: no se puede cambiar la cantidad. Ciérrela (cierre técnico) y cree otra.`);
      }
      anota('Cantidad total', numTxt(c.cantidad), numTxt(q));
    }
    anota('Fecha de inicio', fechaTxt(c.fecha_inicio), inicio || '');
    anota('Fecha de fin', fechaTxt(c.fecha_fin), fin || '');
    anota('Texto', c.texto || '', nota || '');
    if (!cambios.length) return { tipo: 'W', mensaje: 'No se han modificado datos', orden: c.aufnr };

    if (cambiaCantidad) {
      // En una orden liberada: se devuelve lo apartado, se reescala y se vuelve a apartar.
      const liberada = c.estado === 'REL';
      if (liberada) await devolverReservas(client, tenant_id, orden);
      await reescalar(client, tenant_id, orden, q);
      orden.cabecera.cantidad = q;
      if (liberada) await reservarOrden(client, tenant_id, orden);
    }
    await client.query(
      `UPDATE erp_ordenes_produccion SET cantidad = $3, fecha_inicio = $4, fecha_fin = $5, texto = $6
       WHERE tenant_id = $1 AND aufnr = $2`,
      [tenant_id, c.aufnr, q, inicio, fin, nota]
    );
    for (const x of cambios) {
      await registrarCambio(client, {
        tenant_id, objeto: OBJETO, clave: c.aufnr, campo: x.campo, antes: x.antes, despues: x.despues, operator,
      });
    }
    return {
      mensaje: `Orden ${c.aufnr} modificada (${cambios.length} cambio(s))`,
      orden: c.aufnr,
      invalidarTorre: cambiaCantidad && c.estado === 'REL',
    };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Orden', ui.campo({ id: 'orden', etiqueta: 'Orden', obligatorio: true, f4: 'orden', valor: params.orden || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', primario: true, accion: async function () {
        var v = ui.valores();
        if (!v.orden) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        editar(await ui.get('CO02', { orden: v.orden }));
      } }]);
      ui.foco('orden');
    }
    function editar(d) {
      var c = d.cabecera;
      var cerrada = c.estado === 'TECO' || c.estado === 'DLFL';
      ui.titulo('Modificar orden ' + c.aufnr + ' — ' + c.sku + ' ' + (c.nombre || ''));
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'orden', etiqueta: 'Orden', valor: c.aufnr, soloLectura: true }) +
          ui.campo({ id: 'material', etiqueta: 'Material', valor: c.sku + ' ' + (c.nombre || ''), soloLectura: true, ancho: 36 }) +
          ui.campo({ id: 'estado', etiqueta: 'Estado', valor: c.estado + ' ' + c.texto_estado, soloLectura: true }) +
          ui.campo({ id: 'cantidad', etiqueta: 'Cantidad total', tipo: 'number', valor: ui.num(c.cantidad), soloLectura: cerrada, ancho: 10 }) +
          ui.campo({ id: 'entregada', etiqueta: 'Entregado', valor: ui.num(c.cantidad_entregada) + ' ' + c.unidad, soloLectura: true }) +
          ui.campo({ id: 'fecha_inicio', etiqueta: 'Inicio', tipo: 'date', valor: c.fecha_inicio ? String(c.fecha_inicio).slice(0, 10) : '', soloLectura: cerrada }) +
          ui.campo({ id: 'fecha_fin', etiqueta: 'Fin', tipo: 'date', valor: c.fecha_fin ? String(c.fecha_fin).slice(0, 10) : '', soloLectura: cerrada }) +
          ui.campo({ id: 'texto', etiqueta: 'Texto', valor: c.texto || '', soloLectura: cerrada, ancho: 40 })
        ) +
        ui.grupo('Componentes', ui.tabla([
          { id: 'posicion', etiqueta: 'Pos.', tipo: 'num' },
          { id: 'sku', etiqueta: 'Componente' },
          { id: 'texto_breve', etiqueta: 'Texto breve' },
          { id: 'cantidad_necesaria', etiqueta: 'Necesario', tipo: 'qty' },
          { id: 'cantidad_reservada', etiqueta: 'Apartado', tipo: 'qty' },
          { id: 'cantidad_retirada', etiqueta: 'Consumido', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
        ], d.componentes)) +
        '<p class="erp-ayuda"><b>Liberar</b> aparta los insumos (la Torre ya no puede venderlos). ' +
        '<b>Cierre técnico</b> da la orden por terminada: lo apartado que no se usó vuelve a libre y la orden ya no admite movimientos.</p>'
      );
      async function accion(nombre) {
        var v = ui.valores();
        var body = { orden: c.aufnr, accion: nombre, cantidad: v.cantidad, fecha_inicio: v.fecha_inicio, fecha_fin: v.fecha_fin, texto: v.texto };
        var r = await ui.post('CO02', body);
        if (r.tipo === 'W') return ui.mensaje('W', r.mensaje);
        ui.ir('CO03', { orden: c.aufnr }, { mensaje: ['S', r.mensaje] });
      }
      var b = [];
      if (!cerrada) b.push({ texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: function () { return accion('modificar'); } });
      if (c.estado === 'CRTD') b.push({ texto: 'Liberar', accion: function () { return accion('liberar'); } });
      if (!cerrada) b.push({ texto: 'Cierre técnico', accion: function () { return accion('teco'); } });
      if (c.estado === 'CRTD') b.push({ texto: 'Borrar', accion: function () { return accion('borrar'); } });
      b.push({ texto: 'Visualizar (CO03)', accion: function () { ui.ir('CO03', { orden: c.aufnr }); } });
      b.push({ texto: 'Otra orden', tecla: 'F3', accion: inicial });
      ui.botones(b);
    }
    if (params.orden) ui.get('CO02', { orden: params.orden }).then(editar, inicial);
    else inicial();
  }`,
};

export const CO03 = {
  code: 'CO03',
  titulo: 'Visualizar orden de producción',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const orden = await leerOrden(client, tenant_id, params.orden);
    const c = orden.cabecera;
    const docs = await client.query(
      `SELECT d.mblnr, d.zeile, d.clase_movimiento, d.sku, d.cantidad, d.unidad, d.importe, d.rspos,
              m.fecha_contabilizacion, m.anulado_por, m.created_by
       FROM erp_documentos_material_pos d
       JOIN erp_documentos_material m ON m.tenant_id = d.tenant_id AND m.mblnr = d.mblnr
       WHERE d.tenant_id = $1 AND d.aufnr = $2
       ORDER BY d.mblnr, d.zeile`,
      [tenant_id, c.aufnr]
    );
    const cambios = await client.query(
      `SELECT campo, valor_antes, valor_despues, usuario, created_at
       FROM erp_cambios WHERE tenant_id = $1 AND objeto = $2 AND clave = $3
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [tenant_id, OBJETO, c.aufnr]
    );
    // Costos: plan (receta × precio estándar al crear la orden) contra lo real.
    const suma = (clases) => docs.rows
      .filter((d) => clases.includes(d.clase_movimiento))
      .reduce((s, d) => s + (d.clase_movimiento.endsWith('2') ? -1 : 1) * Number(d.importe), 0);
    const plan = orden.componentes.reduce((s, x) => s + Number(x.cantidad_necesaria) * Number(x.precio_plan), 0);
    const consumido = suma(['261', '262']);
    const entregado = suma(['101', '102']);
    const avance = Number(c.cantidad) > 0 ? Number(c.cantidad_entregada) / Number(c.cantidad) : 0;
    const planProporcional = plan * Math.min(avance, 1);
    const redondear = (n) => Math.round(n * 100) / 100;
    return {
      ...orden,
      documentos: docs.rows,
      cambios: cambios.rows,
      costos: {
        plan_insumos: redondear(plan),
        plan_a_lo_entregado: redondear(planProporcional),
        consumido_real: redondear(consumido),
        desviacion: redondear(consumido - planProporcional),
        entregado_valorado: redondear(entregado),
      },
    };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Orden', ui.campo({ id: 'orden', etiqueta: 'Orden', obligatorio: true, f4: 'orden', valor: params.orden || '' })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', primario: true, accion: async function () {
        var v = ui.valores();
        if (!v.orden) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        mostrar(await ui.get('CO03', { orden: v.orden }));
      } }]);
      ui.foco('orden');
    }
    function mostrar(d) {
      var c = d.cabecera;
      var k = d.costos;
      var pendiente = Math.max(Number(c.cantidad) - Number(c.cantidad_entregada), 0);
      ui.titulo('Orden de producción ' + c.aufnr + ' — ' + c.sku + ' ' + (c.nombre || ''));
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'orden', etiqueta: 'Orden', valor: c.aufnr + ' (' + c.clase_orden + ')', soloLectura: true }) +
          ui.campo({ id: 'material', etiqueta: 'Material', valor: c.sku + ' ' + (c.nombre || ''), soloLectura: true, ancho: 36 }) +
          ui.campo({ id: 'centro', etiqueta: 'Centro', valor: c.centro + (c.nombre_centro ? ' ' + c.nombre_centro : ''), soloLectura: true, ancho: 28 }) +
          ui.campo({ id: 'estado', etiqueta: 'Estado', valor: c.estado + ' ' + c.texto_estado, soloLectura: true, ancho: 26 }) +
          ui.campo({ id: 'cantidad', etiqueta: 'Cantidad total', valor: ui.num(c.cantidad) + ' ' + c.unidad, soloLectura: true }) +
          ui.campo({ id: 'entregada', etiqueta: 'Entregado', valor: ui.num(c.cantidad_entregada) + (c.entrega_final ? ' (entrega final)' : ''), soloLectura: true }) +
          ui.campo({ id: 'pendiente', etiqueta: 'Por fabricar', valor: ui.num(pendiente), soloLectura: true }) +
          ui.campo({ id: 'inicio', etiqueta: 'Inicio', valor: ui.fecha(c.fecha_inicio), soloLectura: true }) +
          ui.campo({ id: 'fin', etiqueta: 'Fin', valor: ui.fecha(c.fecha_fin), soloLectura: true }) +
          (c.texto ? ui.campo({ id: 'texto', etiqueta: 'Texto', valor: c.texto, soloLectura: true, ancho: 40 }) : '')
        ) +
        ui.grupo('Componentes', ui.tabla([
          { id: 'posicion', etiqueta: 'Pos.', tipo: 'num' },
          { id: 'sku', etiqueta: 'Componente', enlace: function (f) { ui.ir('MMBE', { material: f.sku }); } },
          { id: 'texto_breve', etiqueta: 'Texto breve' },
          { id: 'cantidad_necesaria', etiqueta: 'Necesario', tipo: 'qty' },
          { id: 'cantidad_reservada', etiqueta: 'Apartado', tipo: 'qty' },
          { id: 'cantidad_retirada', etiqueta: 'Consumido', tipo: 'qty' },
          { id: 'pendiente', etiqueta: 'Por consumir', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
          { id: 'backflush', etiqueta: 'Desc. automático', tipo: 'check' },
          { id: 'libre', etiqueta: 'Libre en centro', tipo: 'qty' },
        ], d.componentes)) +
        ui.grupo('Costos (a precio estándar)',
          ui.campo({ id: 'k1', etiqueta: 'Insumos plan (orden completa)', valor: ui.dinero(k.plan_insumos), soloLectura: true }) +
          ui.campo({ id: 'k2', etiqueta: 'Plan para lo entregado', valor: ui.dinero(k.plan_a_lo_entregado), soloLectura: true }) +
          ui.campo({ id: 'k3', etiqueta: 'Insumos consumidos', valor: ui.dinero(k.consumido_real), soloLectura: true }) +
          ui.campo({ id: 'k4', etiqueta: 'Desviación', valor: ui.dinero(k.desviacion), soloLectura: true, ayuda: 'Consumido menos plan para lo entregado. Positiva = se gastó más de lo previsto.' }) +
          ui.campo({ id: 'k5', etiqueta: 'Producto entregado', valor: ui.dinero(k.entregado_valorado), soloLectura: true })
        ) +
        ui.grupo('Movimientos de mercancías', d.documentos.length ? ui.tabla([
          { id: 'mblnr', etiqueta: 'Doc. material', enlace: function (f) { ui.ir('MIGO', { documento: f.mblnr }); } },
          { id: 'zeile', etiqueta: 'Línea', tipo: 'num' },
          { id: 'clase_movimiento', etiqueta: 'CMv' },
          { id: 'sku', etiqueta: 'Material' },
          { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
          { id: 'importe', etiqueta: 'Importe', tipo: 'money' },
          { id: 'fecha_contabilizacion', etiqueta: 'Fe. contab.', tipo: 'date' },
          { id: 'anulado_por', etiqueta: 'Anulado por' },
        ], d.documentos) : '<p class="erp-ayuda">Sin consumos ni entradas todavía.</p>') +
        ui.grupo('Modificaciones', d.cambios.length ? ui.tabla([
          { id: 'created_at', etiqueta: 'Fecha', tipo: 'date' },
          { id: 'usuario', etiqueta: 'Usuario' },
          { id: 'campo', etiqueta: 'Campo' },
          { id: 'valor_antes', etiqueta: 'Valor anterior' },
          { id: 'valor_despues', etiqueta: 'Valor nuevo' },
        ], d.cambios) : '<p class="erp-ayuda">La orden no ha sido modificada.</p>')
      );
      var abierta = ['REL', 'PDLV', 'DLV'].indexOf(c.estado) >= 0;
      var b = [];
      if (abierta && pendiente > 0) b.push({ texto: 'Entrada de lo fabricado (MIGO)', primario: true, accion: function () { ui.ir('MIGO', { operacion: 'A01', referencia: 'R08', orden: c.aufnr }); } });
      if (abierta) b.push({ texto: 'Consumir insumos (MIGO)', accion: function () { ui.ir('MIGO', { operacion: 'A07', referencia: 'R08', orden: c.aufnr }); } });
      if (c.estado === 'CRTD') b.push({ texto: 'Liberar (CO02)', primario: true, accion: function () { ui.ir('CO02', { orden: c.aufnr }); } });
      b.push({ texto: 'Modificar (CO02)', accion: function () { ui.ir('CO02', { orden: c.aufnr }); } });
      b.push({ texto: 'Otra orden', tecla: 'F3', accion: inicial });
      ui.botones(b);
    }
    if (params.orden) ui.get('CO03', { orden: params.orden }).then(mostrar, inicial);
    else inicial();
  }`,
};

export const COOIS = {
  code: 'COOIS',
  titulo: 'Lista de órdenes de producción',
  menu: ['Logística', 'Producción', 'Control de fabricación', 'Sistema de información'],
  async get({ client, tenant_id, params }) {
    const valores = [tenant_id];
    const filtros = ['o.tenant_id = $1'];
    const add = (sql, v) => { valores.push(v); filtros.push(sql.replaceAll('?', `$${valores.length}`)); };
    if (params.material) add('(o.sku ILIKE ? OR p.nombre ILIKE ?)', `%${String(params.material).slice(0, 64)}%`);
    if (params.centro) add('o.centro = ?', String(params.centro).slice(0, 64));
    const estado = leerEstadoFiltro(params.estado);
    if (estado === 'ABIERTAS') add('o.estado = ANY(?::text[])', ['CRTD', ...ESTADOS_CON_MOVIMIENTOS]);
    else if (estado) add('o.estado = ?', estado);
    if (params.desde) add('o.fecha_inicio >= ?::date', fecha(params.desde, { campo: 'Desde' }));
    if (params.hasta) add('o.fecha_inicio <= ?::date', fecha(params.hasta, { campo: 'Hasta' }));
    const r = await client.query(
      `SELECT o.aufnr, o.sku, p.nombre, o.centro, o.cantidad, o.cantidad_entregada,
              GREATEST(o.cantidad - o.cantidad_entregada, 0) AS pendiente, o.unidad, o.estado,
              o.fecha_inicio::text AS fecha_inicio, o.fecha_fin::text AS fecha_fin, o.texto, o.created_by
       FROM erp_ordenes_produccion o
       LEFT JOIN productos p ON p.tenant_id = o.tenant_id AND p.sku = o.sku
       WHERE ${filtros.join(' AND ')}
       ORDER BY o.aufnr DESC
       LIMIT 500`,
      valores
    );
    return { ordenes: r.rows.map((x) => ({ ...x, texto_estado: `${x.estado} ${ESTADOS_ORDEN[x.estado] || ''}` })) };
  },
  screen: `function (ui, params) {
    var estados = [['ABIERTAS', 'Abiertas (sin cierre técnico)'], ['', 'Todas'], ['CRTD', 'CRTD Abierta'], ['REL', 'REL Liberada'],
      ['PDLV', 'PDLV Entregada parcialmente'], ['DLV', 'DLV Entregada'], ['TECO', 'TECO Cierre técnico'], ['DLFL', 'DLFL Petición de borrado']];
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'material', etiqueta: 'Material', f4: 'material', valor: params.material || '' }) +
      ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro', valor: params.centro || '' }) +
      ui.campo({ id: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: estados, valor: params.estado != null ? params.estado : 'ABIERTAS' }) +
      ui.campo({ id: 'desde', etiqueta: 'Inicio desde', tipo: 'date', valor: params.desde || '' }) +
      ui.campo({ id: 'hasta', etiqueta: 'hasta', tipo: 'date', valor: params.hasta || '' })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('COOIS', ui.valores());
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'aufnr', etiqueta: 'Orden', enlace: function (f) { ui.ir('CO03', { orden: f.aufnr }); } },
        { id: 'sku', etiqueta: 'Material' },
        { id: 'nombre', etiqueta: 'Texto breve' },
        { id: 'centro', etiqueta: 'Centro' },
        { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
        { id: 'cantidad_entregada', etiqueta: 'Entregado', tipo: 'qty' },
        { id: 'pendiente', etiqueta: 'Por fabricar', tipo: 'qty' },
        { id: 'unidad', etiqueta: 'UM' },
        { id: 'texto_estado', etiqueta: 'Estado' },
        { id: 'fecha_inicio', etiqueta: 'Inicio', tipo: 'date' },
        { id: 'fecha_fin', etiqueta: 'Fin', tipo: 'date' },
      ], data.ordenes);
      ui.mensaje('S', data.ordenes.length + ' orden(es) de producción');
    }
    ui.botones([
      { texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar },
      { texto: 'Crear orden (CO01)', accion: function () { ui.ir('CO01', {}); } },
    ]);
    ejecutar();
  }`,
};

export default [CO01, CO02, CO03, COOIS];
