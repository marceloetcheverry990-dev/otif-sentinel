// src/erp/transacciones/lista-materiales.js
// Listas de materiales (recetas): CS01 crear, CS02 modificar, CS03 visualizar.
// Dicen qué componentes lleva un producto fabricado (FERT o HALB) y cuánto de
// cada uno para una cantidad base. Una orden de producción COPIA la receta al
// crearse: cambiar la receta después no cambia órdenes ya creadas (igual que SAP).

import { fallo, texto, cantidad, validarCentro, registrarCambio, operadorDe } from '../core.js';
import { leerLista, leerMaterialFabricable, validarComponentes, r3 } from '../produccion.js';

const MENU = ['Logística', 'Producción', 'Datos maestros', 'Lista de materiales'];
const OBJETO = 'LISTA_MAT';

const numTxt = (n) => String(Number(n));
const siNo = (b) => (b ? 'sí' : 'no');
const claveLista = (sku, centro) => `${sku} / ${centro}`;

/** Costo de insumos de la receta según el precio estándar de cada componente. */
function costear(cabecera, posiciones) {
  const filas = posiciones.map((p) => ({
    ...p,
    costo: Math.round(Number(p.cantidad) * (1 + Number(p.merma_pct) / 100) * Number(p.precio_estandar || 0) * 100) / 100,
  }));
  const total = filas.reduce((s, p) => s + p.costo, 0);
  return {
    posiciones: filas,
    costo_total: Math.round(total * 100) / 100,
    costo_unitario: Math.round((total / Number(cabecera.cantidad_base)) * 100) / 100,
  };
}

async function insertarPosiciones(client, tenant_id, sku, centro, posiciones) {
  for (const p of posiciones) {
    await client.query(
      `INSERT INTO erp_listas_materiales_pos (tenant_id, sku, centro, alternativa, posicion, componente, cantidad,
                                              unidad, merma_pct, backflush, texto)
       VALUES ($1, $2, $3, '01', $4, $5, $6, $7, $8, $9, $10)`,
      [tenant_id, sku, centro, p.posicion, p.componente, p.cantidad, p.unidad, p.merma_pct, p.backflush, p.texto]
    );
  }
}

// Pantalla compartida por CS01 y CS02: cabecera + grilla de componentes.
const PANTALLA_EDICION = `
    function grilla(ui, filas) {
      return '<table class="erp-tabla erp-tabla-editable"><thead><tr>' +
        '<th>Pos.</th><th>Componente</th><th>Texto breve</th><th>Cantidad</th><th>UM</th><th>Merma %</th>' +
        '<th title="Se descuenta solo al dar entrada a lo fabricado (backflush)">Desc. automático</th><th>Borrar</th>' +
        '</tr></thead><tbody>' +
        filas.map(function (f, i) {
          return '<tr>' +
            '<td class="erp-num">' + (f.posicion ? String(f.posicion).padStart(4, '0') : '') +
              '<input type="hidden" data-fila="' + i + '" data-col="posicion" value="' + (f.posicion || '') + '"></td>' +
            '<td>' + ui.celda({ fila: i, col: 'componente', valor: f.componente, f4: 'material', ancho: 14 }) + '</td>' +
            '<td class="erp-texto-breve" data-texto="' + i + '">' + ui.esc(f.texto_breve || '') + '</td>' +
            '<td>' + ui.celda({ fila: i, col: 'cantidad', valor: f.cantidad == null ? '' : ui.num(f.cantidad), tipo: 'number', ancho: 8 }) + '</td>' +
            '<td data-unidad="' + i + '">' + ui.esc(f.unidad || '') + '</td>' +
            '<td>' + ui.celda({ fila: i, col: 'merma_pct', valor: f.merma_pct == null || Number(f.merma_pct) === 0 ? '' : ui.num(f.merma_pct), tipo: 'number', ancho: 5 }) + '</td>' +
            '<td>' + ui.celda({ fila: i, col: 'backflush', tipo: 'check', valor: f.backflush !== false }) + '</td>' +
            '<td>' + (f.posicion ? ui.celda({ fila: i, col: 'borrar', tipo: 'check', valor: false }) : '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>' +
        '<p class="erp-ayuda">Las cantidades son para la <b>cantidad base</b> de la cabecera. ' +
        '<b>Merma %</b>: lo que se pierde en la fabricación; se suma a lo que se saca de bodega. ' +
        '<b>Desc. automático</b>: el insumo se descuenta solo al dar entrada a lo fabricado; si no, bodega lo entrega con MIGO 261.</p>';
    }
    function activarGrilla(ui) {
      ui.qa('[data-col="componente"]').forEach(function (inp) {
        inp.addEventListener('change', function () { completar(ui, Number(inp.dataset.fila), inp.value); });
      });
    }
    async function completar(ui, i, sku) {
      var celdaTexto = ui.q('[data-texto="' + i + '"]');
      var celdaUm = ui.q('[data-unidad="' + i + '"]');
      if (!sku) { if (celdaTexto) celdaTexto.textContent = ''; if (celdaUm) celdaUm.textContent = ''; return; }
      var data = await ui.get('MM03', { material: sku }, { silencioso: true }).catch(function () { return null; });
      if (!data) { if (celdaTexto) celdaTexto.textContent = ''; return ui.mensaje('E', 'El material ' + sku + ' no existe'); }
      if (celdaTexto) celdaTexto.textContent = data.material.nombre;
      if (celdaUm) celdaUm.textContent = data.material.unidad;
    }
`;

export const CS01 = {
  code: 'CS01',
  titulo: 'Crear lista de materiales',
  menu: MENU,
  async post({ client, tenant_id, body, operator }) {
    const mat = await leerMaterialFabricable(client, tenant_id, body.material);
    const centro = await validarCentro(client, tenant_id, body.centro);
    const existe = await client.query(
      `SELECT 1 FROM erp_listas_materiales WHERE tenant_id = $1 AND sku = $2 AND centro = $3 AND alternativa = '01'`,
      [tenant_id, mat.sku, centro.depot_id]
    );
    if (existe.rowCount) {
      throw fallo(`Ya existe una lista de materiales para ${mat.sku} en el centro ${centro.depot_id} (modifíquela con CS02)`, 409);
    }
    const base = cantidad(body.cantidad_base, { campo: 'Cantidad base' });
    const nota = texto(body.texto, { campo: 'Texto', max: 160 });
    // En CS01 la numeración la pone el sistema: 0010, 0020, 0030…
    const filas = (Array.isArray(body.posiciones) ? body.posiciones : []).map((f) => ({ ...f, posicion: null }));
    const posiciones = await validarComponentes(client, tenant_id, { sku: mat.sku, centro: centro.depot_id, filas });

    if (body.solo_verificar) {
      return { mensaje: `No se han encontrado errores (${posiciones.length} componente(s))`, verificado: true };
    }
    await client.query(
      `INSERT INTO erp_listas_materiales (tenant_id, sku, centro, alternativa, cantidad_base, unidad, texto, created_by)
       VALUES ($1, $2, $3, '01', $4, $5, $6, $7)`,
      [tenant_id, mat.sku, centro.depot_id, base, mat.unidad || 'UN', nota, operadorDe(operator)]
    );
    await insertarPosiciones(client, tenant_id, mat.sku, centro.depot_id, posiciones);
    return {
      mensaje: `Lista de materiales de ${mat.sku} creada en el centro ${centro.depot_id} con ${posiciones.length} componente(s)`,
      material: mat.sku,
      centro: centro.depot_id,
    };
  },
  screen: `function (ui, params) {
    ${PANTALLA_EDICION}
    var filas = [];
    for (var i = 0; i < 6; i++) filas.push({});

    function render() {
      var cab = ui.valores();
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'material', etiqueta: 'Material', obligatorio: true, f4: 'material', valor: cab.material || params.material || '', ayuda: 'Producto terminado (FERT) o semielaborado (HALB)' }) +
          ui.campo({ id: 'centro', etiqueta: 'Centro', obligatorio: true, f4: 'centro', valor: cab.centro || params.centro || ui.centroPorDefecto() }) +
          ui.campo({ id: 'cantidad_base', etiqueta: 'Cantidad base', tipo: 'number', obligatorio: true, valor: cab.cantidad_base || '1', ancho: 8, ayuda: 'Para cuántas unidades del material es la receta' }) +
          ui.campo({ id: 'texto', etiqueta: 'Texto', valor: cab.texto || '', ancho: 40 })
        ) +
        ui.grupo('Componentes', grilla(ui, filas))
      );
      activarGrilla(ui);
    }
    function cuerpo(soloVerificar) {
      var v = ui.valores();
      v.posiciones = ui.filas();
      v.solo_verificar = !!soloVerificar;
      return v;
    }
    render();
    ui.botones([
      { texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
        var r = await ui.post('CS01', cuerpo(false));
        ui.ir('CS03', { material: r.material, centro: r.centro }, { mensaje: ['S', r.mensaje] });
      } },
      { texto: 'Verificar', accion: async function () { ui.mensaje('S', (await ui.post('CS01', cuerpo(true))).mensaje); } },
      { texto: 'Añadir posiciones', accion: function () { filas = ui.filas({ incluirVacias: true }).concat([{}, {}, {}]); render(); } },
    ]);
    ui.foco('material');
  }`,
};

export const CS02 = {
  code: 'CS02',
  titulo: 'Modificar lista de materiales',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    return leerLista(client, tenant_id, params.material, params.centro);
  },
  async post({ client, tenant_id, body, operator }) {
    const actual = await leerLista(client, tenant_id, body.material, body.centro, { paraActualizar: true });
    const { sku, centro } = actual.cabecera;
    const base = cantidad(body.cantidad_base, { campo: 'Cantidad base' });
    const nota = texto(body.texto, { campo: 'Texto', max: 160 });
    const posiciones = await validarComponentes(client, tenant_id, { sku, centro, filas: body.posiciones });

    // Diferencias campo a campo (se registran en el documento de modificación).
    const cambios = [];
    const anota = (campo, antes, despues, posicion = null) => {
      if (String(antes ?? '') !== String(despues ?? '')) cambios.push({ campo, antes, despues, posicion });
    };
    anota('Cantidad base', numTxt(actual.cabecera.cantidad_base), numTxt(base));
    anota('Texto', actual.cabecera.texto || '', nota || '');
    const antes = new Map(actual.posiciones.map((p) => [Number(p.posicion), p]));
    const despues = new Map(posiciones.map((p) => [p.posicion, p]));
    for (const [pos, p] of antes) {
      if (!despues.has(pos)) anota('Posición borrada', `${p.componente} ${numTxt(p.cantidad)} ${p.unidad}`, '', pos);
    }
    for (const [pos, p] of despues) {
      const a = antes.get(pos);
      if (!a) {
        anota('Posición nueva', '', `${p.componente} ${numTxt(p.cantidad)} ${p.unidad}`, pos);
        continue;
      }
      anota('Componente', a.componente, p.componente, pos);
      anota('Cantidad', numTxt(a.cantidad), numTxt(p.cantidad), pos);
      anota('Merma %', numTxt(a.merma_pct), numTxt(p.merma_pct), pos);
      anota('Desc. automático', siNo(a.backflush), siNo(p.backflush), pos);
      anota('Texto posición', a.texto || '', p.texto || '', pos);
    }

    if (!cambios.length) return { tipo: 'W', mensaje: 'No se han modificado datos', material: sku, centro };
    if (body.solo_verificar) {
      return { mensaje: `No se han encontrado errores (${cambios.length} cambio(s) por grabar)`, verificado: true };
    }

    await client.query(
      `UPDATE erp_listas_materiales SET cantidad_base = $4, texto = $5, updated_at = NOW()
       WHERE tenant_id = $1 AND sku = $2 AND centro = $3 AND alternativa = '01'`,
      [tenant_id, sku, centro, base, nota]
    );
    await client.query(
      `DELETE FROM erp_listas_materiales_pos WHERE tenant_id = $1 AND sku = $2 AND centro = $3 AND alternativa = '01'`,
      [tenant_id, sku, centro]
    );
    await insertarPosiciones(client, tenant_id, sku, centro, posiciones);
    for (const c of cambios) {
      await registrarCambio(client, {
        tenant_id, objeto: OBJETO, clave: claveLista(sku, centro), posicion: c.posicion,
        campo: c.campo, antes: c.antes, despues: c.despues, operator,
      });
    }
    return {
      mensaje: `Lista de materiales de ${sku} modificada (${cambios.length} cambio(s)). Las órdenes ya creadas no cambian.`,
      material: sku,
      centro,
    };
  },
  screen: `function (ui, params) {
    ${PANTALLA_EDICION}
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Lista de materiales',
        ui.campo({ id: 'material', etiqueta: 'Material', obligatorio: true, f4: 'material', valor: params.material || '' }) +
        ui.campo({ id: 'centro', etiqueta: 'Centro', obligatorio: true, f4: 'centro', valor: params.centro || ui.centroPorDefecto() })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', primario: true, accion: async function () {
        var v = ui.valores();
        if (!v.material || !v.centro) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        editar(await ui.get('CS02', { material: v.material, centro: v.centro }));
      } }]);
      ui.foco('material');
    }
    function editar(d) {
      var c = d.cabecera;
      var filas = d.posiciones.map(function (p) {
        return { posicion: p.posicion, componente: p.componente, texto_breve: p.texto_breve, cantidad: p.cantidad, unidad: p.unidad, merma_pct: p.merma_pct, backflush: p.backflush };
      }).concat([{}, {}, {}]);
      function render() {
        ui.titulo('Modificar lista de materiales ' + c.sku + ' — ' + (c.nombre || ''));
        ui.pantalla(
          ui.grupo('Cabecera',
            ui.campo({ id: 'material', etiqueta: 'Material', valor: c.sku, soloLectura: true }) +
            ui.campo({ id: 'centro', etiqueta: 'Centro', valor: c.centro, soloLectura: true }) +
            ui.campo({ id: 'cantidad_base', etiqueta: 'Cantidad base', tipo: 'number', obligatorio: true, valor: ui.num(c.cantidad_base), ancho: 8 }) +
            ui.campo({ id: 'unidad', etiqueta: 'UM', valor: c.unidad, soloLectura: true, ancho: 5 }) +
            ui.campo({ id: 'texto', etiqueta: 'Texto', valor: c.texto || '', ancho: 40 })
          ) +
          ui.grupo('Componentes', grilla(ui, filas))
        );
        activarGrilla(ui);
      }
      function cuerpo(soloVerificar) {
        var v = ui.valores();
        v.posiciones = ui.filas();
        v.solo_verificar = !!soloVerificar;
        return v;
      }
      render();
      ui.botones([
        { texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
          var r = await ui.post('CS02', cuerpo(false));
          if (r.tipo === 'W') return ui.mensaje('W', r.mensaje);
          ui.ir('CS03', { material: r.material, centro: r.centro }, { mensaje: ['S', r.mensaje] });
        } },
        { texto: 'Verificar', accion: async function () { var r = await ui.post('CS02', cuerpo(true)); ui.mensaje(r.tipo === 'W' ? 'W' : 'S', r.mensaje); } },
        { texto: 'Añadir posiciones', accion: function () { filas = ui.filas({ incluirVacias: true }).concat([{}, {}, {}]); render(); } },
        { texto: 'Otra lista', tecla: 'F3', accion: inicial },
      ]);
    }
    if (params.material && params.centro) ui.get('CS02', { material: params.material, centro: params.centro }).then(editar, inicial);
    else inicial();
  }`,
};

export const CS03 = {
  code: 'CS03',
  titulo: 'Visualizar lista de materiales',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const lista = await leerLista(client, tenant_id, params.material, params.centro);
    const { sku, centro } = lista.cabecera;
    const costo = costear(lista.cabecera, lista.posiciones);
    const cambios = await client.query(
      `SELECT posicion, campo, valor_antes, valor_despues, usuario, created_at
       FROM erp_cambios WHERE tenant_id = $1 AND objeto = $2 AND clave = $3
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [tenant_id, OBJETO, claveLista(sku, centro)]
    );
    const usos = await client.query(
      `SELECT DISTINCT x.sku, p.nombre FROM erp_listas_materiales_pos x
       LEFT JOIN productos p ON p.tenant_id = x.tenant_id AND p.sku = x.sku
       WHERE x.tenant_id = $1 AND x.centro = $2 AND x.componente = $3 ORDER BY x.sku LIMIT 50`,
      [tenant_id, centro, sku]
    );
    return {
      cabecera: lista.cabecera,
      posiciones: costo.posiciones.map((p) => ({ ...p, cantidad_con_merma: r3(Number(p.cantidad) * (1 + Number(p.merma_pct) / 100)) })),
      costo_total: costo.costo_total,
      costo_unitario: costo.costo_unitario,
      cambios: cambios.rows,
      usado_en: usos.rows,
    };
  },
  screen: `function (ui, params) {
    function inicial() {
      ui.titulo(null);
      ui.pantalla(ui.grupo('Lista de materiales',
        ui.campo({ id: 'material', etiqueta: 'Material', obligatorio: true, f4: 'material', valor: params.material || '' }) +
        ui.campo({ id: 'centro', etiqueta: 'Centro', obligatorio: true, f4: 'centro', valor: params.centro || ui.centroPorDefecto() })));
      ui.botones([{ texto: 'Continuar', tecla: 'Enter', primario: true, accion: async function () {
        var v = ui.valores();
        if (!v.material || !v.centro) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
        mostrar(await ui.get('CS03', { material: v.material, centro: v.centro }));
      } }]);
      ui.foco('material');
    }
    function mostrar(d) {
      var c = d.cabecera;
      ui.titulo('Lista de materiales ' + c.sku + ' — ' + (c.nombre || ''));
      ui.pantalla(
        ui.grupo('Cabecera',
          ui.campo({ id: 'material', etiqueta: 'Material', valor: c.sku + ' ' + (c.nombre || ''), soloLectura: true, ancho: 36 }) +
          ui.campo({ id: 'tipo', etiqueta: 'Tipo', valor: c.tipo_material || '', soloLectura: true, ancho: 5 }) +
          ui.campo({ id: 'centro', etiqueta: 'Centro', valor: c.centro, soloLectura: true }) +
          ui.campo({ id: 'base', etiqueta: 'Cantidad base', valor: ui.num(c.cantidad_base) + ' ' + c.unidad, soloLectura: true }) +
          ui.campo({ id: 'costo', etiqueta: 'Costo de insumos', valor: ui.dinero(d.costo_total) + ' (' + ui.dinero(d.costo_unitario) + ' por ' + c.unidad + ')', soloLectura: true, ancho: 30 }) +
          (c.texto ? ui.campo({ id: 'texto', etiqueta: 'Texto', valor: c.texto, soloLectura: true, ancho: 40 }) : '')
        ) +
        ui.grupo('Componentes', ui.tabla([
          { id: 'posicion', etiqueta: 'Pos.', tipo: 'num' },
          { id: 'componente', etiqueta: 'Componente', enlace: function (f) { ui.ir('MM03', { material: f.componente }); } },
          { id: 'texto_breve', etiqueta: 'Texto breve' },
          { id: 'tipo_material', etiqueta: 'Tipo' },
          { id: 'cantidad', etiqueta: 'Cantidad', tipo: 'qty' },
          { id: 'unidad', etiqueta: 'UM' },
          { id: 'merma_pct', etiqueta: 'Merma %', tipo: 'num' },
          { id: 'cantidad_con_merma', etiqueta: 'Con merma', tipo: 'qty' },
          { id: 'backflush', etiqueta: 'Desc. automático', tipo: 'check' },
          { id: 'precio_estandar', etiqueta: 'Precio estándar', tipo: 'money' },
          { id: 'costo', etiqueta: 'Costo', tipo: 'money' },
        ], d.posiciones)) +
        (d.usado_en.length ? ui.grupo('Se usa como componente en', ui.tabla([
          { id: 'sku', etiqueta: 'Material', enlace: function (f) { ui.ir('CS03', { material: f.sku, centro: c.centro }); } },
          { id: 'nombre', etiqueta: 'Texto breve' },
        ], d.usado_en)) : '') +
        ui.grupo('Modificaciones', d.cambios.length ? ui.tabla([
          { id: 'created_at', etiqueta: 'Fecha', tipo: 'date' },
          { id: 'usuario', etiqueta: 'Usuario' },
          { id: 'posicion', etiqueta: 'Pos.' },
          { id: 'campo', etiqueta: 'Campo' },
          { id: 'valor_antes', etiqueta: 'Valor anterior' },
          { id: 'valor_despues', etiqueta: 'Valor nuevo' },
        ], d.cambios) : '<p class="erp-ayuda">La lista de materiales no ha sido modificada.</p>')
      );
      ui.botones([
        { texto: 'Crear orden de producción (CO01)', primario: true, accion: function () { ui.ir('CO01', { material: c.sku, centro: c.centro }); } },
        { texto: 'Modificar (CS02)', accion: function () { ui.ir('CS02', { material: c.sku, centro: c.centro }); } },
        { texto: 'Otra lista', tecla: 'F3', accion: inicial },
      ]);
    }
    if (params.material && params.centro) ui.get('CS03', { material: params.material, centro: params.centro }).then(mostrar, inicial);
    else inicial();
  }`,
};

export default [CS01, CS02, CS03];
