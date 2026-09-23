// src/erp/transacciones/material.js
// Maestro de materiales: MM01 (crear), MM02 (modificar), MM03 (visualizar), MM60 (lista).
//
// El material ES el producto que usa la bodega de la Torre (tabla productos):
// lo que crees acá aparece en la pestaña Bodega y lo pueden pedir los pedidos
// de venta que entran por webhook. El stock NO se toca acá (igual que en SAP):
// solo entra por MIGO.

import {
  fallo, texto, importe, cantidad, opcion,
  validarCentro, leerMaterial,
} from '../core.js';

export const TIPOS_MATERIAL = [
  ['HAWA', 'Mercaderías (compra-venta)'],
  ['ROH', 'Materia prima'],
  ['HALB', 'Producto semielaborado'],
  ['FERT', 'Producto terminado'],
  ['VERP', 'Embalaje'],
];

export const UNIDADES = [
  ['UN', 'Unidad'], ['CJ', 'Caja'], ['KG', 'Kilogramo'], ['L', 'Litro'],
  ['M', 'Metro'], ['PAL', 'Pallet'], ['PAQ', 'Paquete'],
];

const MENU = ['Logística', 'Gestión de materiales', 'Maestro de materiales'];

async function detalleMaterial(client, tenant_id, sku) {
  const mat = await leerMaterial(client, tenant_id, sku);
  const centros = await client.query(
    `SELECT i.depot_id AS centro, d.nombre AS nombre_centro, i.qty_disponible, i.qty_reservada,
            i.qty_minima, i.ubicacion
     FROM inventario_bodega i
     LEFT JOIN depots d ON d.tenant_id = i.tenant_id AND d.depot_id = i.depot_id
     WHERE i.tenant_id = $1 AND i.sku = $2
     ORDER BY i.depot_id`,
    [tenant_id, mat.sku]
  );
  return { material: mat, centros: centros.rows };
}

function leerDatosBasicos(body) {
  return {
    nombre: texto(body.nombre, { campo: 'Texto breve', max: 256, requerido: true }),
    unidad: opcion(body.unidad, UNIDADES.map((u) => u[0]), { campo: 'Unidad medida base', porDefecto: 'UN' }),
    tipo_material: opcion(body.tipo_material, TIPOS_MATERIAL.map((t) => t[0]), { campo: 'Tipo de material', porDefecto: 'HAWA' }),
    grupo_articulos: texto(body.grupo_articulos, { campo: 'Grupo de artículos', max: 16 }),
    peso_bruto_kg: body.peso_bruto_kg === '' || body.peso_bruto_kg == null
      ? null
      : cantidad(body.peso_bruto_kg, { campo: 'Peso bruto', permitirCero: true }),
    precio_estandar: importe(body.precio_estandar, { campo: 'Precio estándar' }),
  };
}

/** Amplía el material a un centro (vista "Almacén" en SAP) sin tocar la cantidad. */
async function ampliarACentro(client, tenant_id, sku, body) {
  if (!body.centro) return null;
  const centro = await validarCentro(client, tenant_id, body.centro);
  const minimo = body.qty_minima === '' || body.qty_minima == null
    ? 0
    : cantidad(body.qty_minima, { campo: 'Punto de pedido', permitirCero: true });
  const ubicacion = texto(body.ubicacion, { campo: 'Ubicación', max: 64 });
  await client.query(
    `INSERT INTO inventario_bodega (tenant_id, depot_id, sku, qty_disponible, qty_reservada, qty_minima, ubicacion)
     VALUES ($1, $2, $3, 0, 0, $4, $5)
     ON CONFLICT (tenant_id, depot_id, sku) DO UPDATE SET
       qty_minima = EXCLUDED.qty_minima,
       ubicacion = COALESCE(EXCLUDED.ubicacion, inventario_bodega.ubicacion),
       updated_at = NOW()`,
    [tenant_id, centro.depot_id, sku, minimo, ubicacion]
  );
  return centro.depot_id;
}

// ─── Pantalla compartida MM01/MM02/MM03 ────────────────────────────────────
// `modo` llega como parámetro: 'crear' | 'modificar' | 'visualizar'.
const PANTALLA_MATERIAL = `function (ui, params, modo) {
  var TIPOS = ${JSON.stringify(TIPOS_MATERIAL)};
  var UNIDADES = ${JSON.stringify(UNIDADES)};

  function pantallaInicial() {
    ui.pantalla(
      ui.grupo('Material',
        ui.campo({ id: 'material', etiqueta: 'Material', obligatorio: true, f4: modo === 'crear' ? null : 'material', valor: params.material || '' }) +
        (modo === 'crear' ? ui.campo({ id: 'tipo_material', etiqueta: 'Tipo de material', tipo: 'select', opciones: TIPOS, valor: 'HAWA' }) : '')
      ) +
      '<p class="erp-ayuda">' + (modo === 'crear'
        ? 'Código del material (SKU). Es el mismo código que usan los pedidos de venta de la Torre.'
        : 'Ingrese el material y presione Enter.') + '</p>'
    );
    ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: continuar }]);
    ui.foco('material');
  }

  async function continuar() {
    var v = ui.valores();
    if (!v.material) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
    if (modo === 'crear') {
      var existe = await ui.get('MM03', { material: v.material }, { silencioso: true }).catch(function () { return null; });
      if (existe) return ui.mensaje('E', 'El material ' + v.material + ' ya existe');
      return detalle({ material: { sku: v.material, tipo_material: v.tipo_material, unidad: 'UN', precio_estandar: 0 }, centros: [] });
    }
    var data = await ui.get('MM03', { material: v.material });
    detalle(data);
  }

  function detalle(data) {
    var m = data.material;
    var lectura = modo === 'visualizar';
    var centros = data.centros || [];
    var tabla = centros.length
      ? ui.tabla([
          { id: 'centro', etiqueta: 'Centro' },
          { id: 'nombre_centro', etiqueta: 'Nombre' },
          { id: 'qty_disponible', etiqueta: 'Libre utilización', tipo: 'qty' },
          { id: 'qty_reservada', etiqueta: 'Reservado', tipo: 'qty' },
          { id: 'qty_minima', etiqueta: 'Punto de pedido', tipo: 'qty' },
          { id: 'ubicacion', etiqueta: 'Ubicación' },
        ], centros)
      : '<p class="erp-ayuda">Todavía no está ampliado a ningún centro.</p>';

    ui.titulo((modo === 'crear' ? 'Crear' : modo === 'modificar' ? 'Modificar' : 'Visualizar') + ' material ' + m.sku);
    ui.pantalla(
      ui.pestanas([
        { titulo: 'Datos básicos 1', html:
          ui.grupo('Datos generales',
            ui.campo({ id: 'material', etiqueta: 'Material', valor: m.sku, soloLectura: true }) +
            ui.campo({ id: 'nombre', etiqueta: 'Texto breve', valor: m.nombre || '', obligatorio: true, soloLectura: lectura, ancho: 40 }) +
            ui.campo({ id: 'tipo_material', etiqueta: 'Tipo de material', tipo: 'select', opciones: TIPOS, valor: m.tipo_material || 'HAWA', soloLectura: lectura }) +
            ui.campo({ id: 'unidad', etiqueta: 'Unidad medida base', tipo: 'select', opciones: UNIDADES, valor: m.unidad || 'UN', soloLectura: lectura }) +
            ui.campo({ id: 'grupo_articulos', etiqueta: 'Grupo de artículos', valor: m.grupo_articulos || '', soloLectura: lectura }) +
            ui.campo({ id: 'peso_bruto_kg', etiqueta: 'Peso bruto (KG)', tipo: 'number', valor: m.peso_bruto_kg == null ? '' : m.peso_bruto_kg, soloLectura: lectura })
          ) },
        { titulo: 'Contabilidad', html:
          ui.grupo('Valoración',
            ui.campo({ id: 'precio_estandar', etiqueta: 'Precio estándar (CLP)', tipo: 'number', valor: m.precio_estandar || 0, soloLectura: lectura })
          ) },
        { titulo: 'Almacén / Centros', html:
          tabla +
          (lectura ? '' : ui.grupo('Ampliar a centro / modificar datos de centro',
            ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro', valor: centros.length ? '' : (ui.centroPorDefecto() || '') }) +
            ui.campo({ id: 'qty_minima', etiqueta: 'Punto de pedido', tipo: 'number', valor: '' }) +
            ui.campo({ id: 'ubicacion', etiqueta: 'Ubicación', valor: '' })
          ))
        },
      ])
    );

    var botones = [{ texto: 'Atrás', tecla: 'F3', accion: function () { ui.titulo(null); pantallaInicial(); } }];
    if (!lectura) botones.unshift({ texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: grabar });
    if (lectura) {
      botones.unshift({ texto: 'Modificar', accion: function () { ui.ir('MM02', { material: m.sku }); } });
      botones.push({ texto: 'Resumen de stocks (MMBE)', accion: function () { ui.ir('MMBE', { material: m.sku }); } });
    }
    ui.botones(botones);
    if (!lectura) ui.foco('nombre');
  }

  async function grabar() {
    var v = ui.valores();
    var r = await ui.post(modo === 'crear' ? 'MM01' : 'MM02', v);
    if (modo === 'crear') {
      // Como en SAP: al crear se vuelve a la pantalla inicial, con el campo
      // vacío y listo para el material siguiente. Que la pantalla cambie es
      // la señal de que grabó; el mensaje verde solo acompaña.
      params = {};
      ui.titulo(null);
      pantallaInicial();
      ui.mensaje('S', r.mensaje);
      return;
    }
    var data = await ui.get('MM03', { material: r.material });
    detalle(data);
    ui.mensaje('S', r.mensaje);
  }

  if (params.material && modo !== 'crear') {
    ui.get('MM03', { material: params.material }).then(detalle, pantallaInicial);
  } else {
    pantallaInicial();
  }
}`;

function pantallaModo(modo) {
  return `function (ui, params) { (${PANTALLA_MATERIAL})(ui, params, '${modo}'); }`;
}

export const MM01 = {
  code: 'MM01',
  titulo: 'Crear material',
  menu: MENU,
  async post({ client, tenant_id, body }) {
    const sku = texto(body.material, { campo: 'Material', max: 64, requerido: true });
    const datos = leerDatosBasicos(body);
    const r = await client.query(
      `INSERT INTO productos (tenant_id, sku, nombre, unidad, activo, tipo_material,
                              grupo_articulos, peso_bruto_kg, precio_estandar)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, sku) DO NOTHING
       RETURNING sku`,
      [tenant_id, sku, datos.nombre, datos.unidad, datos.tipo_material,
        datos.grupo_articulos, datos.peso_bruto_kg, datos.precio_estandar]
    );
    if (!r.rowCount) throw fallo(`El material ${sku} ya existe`, 409);
    const centro = await ampliarACentro(client, tenant_id, sku, body);
    return {
      mensaje: `Se ha creado el material ${sku}${centro ? ` (centro ${centro})` : ''}`,
      material: sku,
    };
  },
  screen: pantallaModo('crear'),
};

export const MM02 = {
  code: 'MM02',
  titulo: 'Modificar material',
  menu: MENU,
  async post({ client, tenant_id, body }) {
    const mat = await leerMaterial(client, tenant_id, body.material, { paraActualizar: true });
    const datos = leerDatosBasicos(body);
    await client.query(
      `UPDATE productos SET nombre = $3, unidad = $4, tipo_material = $5, grupo_articulos = $6,
              peso_bruto_kg = $7, precio_estandar = $8, updated_at = NOW()
       WHERE tenant_id = $1 AND sku = $2`,
      [tenant_id, mat.sku, datos.nombre, datos.unidad, datos.tipo_material,
        datos.grupo_articulos, datos.peso_bruto_kg, datos.precio_estandar]
    );
    await ampliarACentro(client, tenant_id, mat.sku, body);
    return { mensaje: `Se ha modificado el material ${mat.sku}`, material: mat.sku };
  },
  screen: pantallaModo('modificar'),
};

export const MM03 = {
  code: 'MM03',
  titulo: 'Visualizar material',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    return detalleMaterial(client, tenant_id, params.material);
  },
  screen: pantallaModo('visualizar'),
};

export const MM60 = {
  code: 'MM60',
  titulo: 'Lista de materiales',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const filtros = ['p.tenant_id = $1'];
    const valores = [tenant_id];
    if (params.material) {
      valores.push(`%${String(params.material).slice(0, 64)}%`);
      filtros.push(`(p.sku ILIKE $${valores.length} OR p.nombre ILIKE $${valores.length})`);
    }
    if (params.tipo_material) {
      valores.push(String(params.tipo_material).slice(0, 4));
      filtros.push(`p.tipo_material = $${valores.length}`);
    }
    const r = await client.query(
      `SELECT p.sku, p.nombre, p.tipo_material, p.unidad, p.grupo_articulos, p.precio_estandar,
              p.activo, p.updated_at
       FROM productos p
       WHERE ${filtros.join(' AND ')}
       ORDER BY p.sku
       LIMIT 500`,
      valores
    );
    return { materiales: r.rows };
  },
  screen: `function (ui, params) {
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'material', etiqueta: 'Material / texto', valor: params.material || '' }) +
      ui.campo({ id: 'tipo_material', etiqueta: 'Tipo de material', tipo: 'select',
        opciones: [['', '(todos)']].concat(${JSON.stringify(TIPOS_MATERIAL)}), valor: '' })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('MM60', ui.valores());
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'sku', etiqueta: 'Material', enlace: function (f) { ui.ir('MM03', { material: f.sku }); } },
        { id: 'nombre', etiqueta: 'Texto breve' },
        { id: 'tipo_material', etiqueta: 'Tipo' },
        { id: 'unidad', etiqueta: 'UMB' },
        { id: 'grupo_articulos', etiqueta: 'Grupo art.' },
        { id: 'precio_estandar', etiqueta: 'Precio estándar', tipo: 'money' },
      ], data.materiales);
      ui.mensaje('S', data.materiales.length + ' material(es) seleccionado(s)');
    }
    ui.botones([
      { texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar },
      { texto: 'Crear material (MM01)', accion: function () { ui.ir('MM01'); } },
    ]);
    ejecutar();
  }`,
};

export default [MM01, MM02, MM03, MM60];
