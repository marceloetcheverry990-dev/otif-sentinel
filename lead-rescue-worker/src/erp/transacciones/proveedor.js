// src/erp/transacciones/proveedor.js
// Maestro de proveedores (en SAP "acreedores"): XK01 crear, XK02 modificar,
// XK03 visualizar, MKVZ lista. Un proveedor bloqueado no acepta pedidos (ME21N).

import {
  fallo, texto, opcion, rutChileno,
  siguienteNumero, RANGOS, leerProveedor, operadorDe,
} from '../core.js';

export const CONDICIONES_PAGO = [
  ['Z000', 'Pago al contado'],
  ['Z015', '15 días neto'],
  ['Z030', '30 días neto'],
  ['Z045', '45 días neto'],
  ['Z060', '60 días neto'],
];

const MENU = ['Logística', 'Gestión de materiales', 'Compras', 'Datos maestros', 'Proveedor'];

function leerDatos(body) {
  const email = texto(body.email, { campo: 'Correo', max: 120 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fallo('Correo electrónico inválido');
  return {
    nombre: texto(body.nombre, { campo: 'Nombre', max: 120, requerido: true }),
    rut: rutChileno(body.rut),
    calle: texto(body.calle, { campo: 'Calle', max: 160 }),
    ciudad: texto(body.ciudad, { campo: 'Ciudad', max: 80 }),
    region: texto(body.region, { campo: 'Región', max: 80 }),
    pais: opcion(body.pais, ['CL', 'AR', 'PE', 'CO', 'MX', 'US', 'CN', 'BR'], { campo: 'País', porDefecto: 'CL' }),
    telefono: texto(body.telefono, { campo: 'Teléfono', max: 32 }),
    email,
    contacto: texto(body.contacto, { campo: 'Persona de contacto', max: 80 }),
    condicion_pago: opcion(body.condicion_pago, CONDICIONES_PAGO.map((c) => c[0]), { campo: 'Condición de pago', porDefecto: 'Z030' }),
    moneda: opcion(body.moneda, ['CLP', 'USD', 'EUR'], { campo: 'Moneda de pedido', porDefecto: 'CLP' }),
    bloqueado: body.bloqueado === true || body.bloqueado === 'true' || body.bloqueado === 'X',
  };
}

const PANTALLA_PROVEEDOR = `function (ui, params, modo) {
  var CONDICIONES = ${JSON.stringify(CONDICIONES_PAGO)};

  function pantallaInicial() {
    if (modo === 'crear') return detalle({});
    ui.pantalla(ui.grupo('Proveedor',
      ui.campo({ id: 'proveedor', etiqueta: 'Proveedor', obligatorio: true, f4: 'proveedor', valor: params.proveedor || '' })
    ));
    ui.botones([{ texto: 'Continuar', tecla: 'Enter', accion: async function () {
      var v = ui.valores();
      if (!v.proveedor) return ui.mensaje('E', 'Rellene todos los campos obligatorios');
      detalle(await ui.get('XK03', { proveedor: v.proveedor }));
    } }]);
    ui.foco('proveedor');
  }

  function detalle(p) {
    var lectura = modo === 'visualizar';
    ui.titulo((modo === 'crear' ? 'Crear proveedor' : (lectura ? 'Visualizar' : 'Modificar') + ' proveedor ' + p.proveedor_id));
    ui.pantalla(ui.pestanas([
      { titulo: 'Dirección', html:
        ui.grupo('Nombre',
          (p.proveedor_id ? ui.campo({ id: 'proveedor', etiqueta: 'Proveedor', valor: p.proveedor_id, soloLectura: true }) : '') +
          ui.campo({ id: 'nombre', etiqueta: 'Nombre', valor: p.nombre || '', obligatorio: true, soloLectura: lectura, ancho: 40 }) +
          ui.campo({ id: 'rut', etiqueta: 'RUT', valor: p.rut || '', soloLectura: lectura, ayuda: '12345678-9' })
        ) +
        ui.grupo('Dirección',
          ui.campo({ id: 'calle', etiqueta: 'Calle / número', valor: p.calle || '', soloLectura: lectura, ancho: 40 }) +
          ui.campo({ id: 'ciudad', etiqueta: 'Población', valor: p.ciudad || '', soloLectura: lectura }) +
          ui.campo({ id: 'region', etiqueta: 'Región', valor: p.region || '', soloLectura: lectura }) +
          ui.campo({ id: 'pais', etiqueta: 'País', valor: p.pais || 'CL', soloLectura: lectura, ancho: 4 })
        ) },
      { titulo: 'Comunicación', html:
        ui.grupo('Comunicación',
          ui.campo({ id: 'telefono', etiqueta: 'Teléfono', valor: p.telefono || '', soloLectura: lectura }) +
          ui.campo({ id: 'email', etiqueta: 'Correo electrónico', valor: p.email || '', soloLectura: lectura, ancho: 40 }) +
          ui.campo({ id: 'contacto', etiqueta: 'Persona de contacto', valor: p.contacto || '', soloLectura: lectura })
        ) },
      { titulo: 'Datos de compras', html:
        ui.grupo('Condiciones',
          ui.campo({ id: 'moneda', etiqueta: 'Moneda de pedido', tipo: 'select', opciones: [['CLP','CLP'],['USD','USD'],['EUR','EUR']], valor: p.moneda || 'CLP', soloLectura: lectura }) +
          ui.campo({ id: 'condicion_pago', etiqueta: 'Condición de pago', tipo: 'select', opciones: CONDICIONES, valor: p.condicion_pago || 'Z030', soloLectura: lectura }) +
          ui.campo({ id: 'bloqueado', etiqueta: 'Bloqueo de pedidos', tipo: 'check', valor: !!p.bloqueado, soloLectura: lectura })
        ) },
    ]));
    var botones = [];
    if (!lectura) botones.push({ texto: 'Grabar', tecla: 'Ctrl+S', primario: true, accion: async function () {
      var v = ui.valores();
      var r = await ui.post(modo === 'crear' ? 'XK01' : 'XK02', v);
      modo = 'modificar';
      detalle(await ui.get('XK03', { proveedor: r.proveedor }));
      ui.mensaje('S', r.mensaje);
    } });
    if (lectura) {
      botones.push({ texto: 'Modificar', accion: function () { ui.ir('XK02', { proveedor: p.proveedor_id }); } });
      botones.push({ texto: 'Pedidos del proveedor (ME2N)', accion: function () { ui.ir('ME2N', { proveedor: p.proveedor_id }); } });
    }
    if (modo !== 'crear') botones.push({ texto: 'Atrás', tecla: 'F3', accion: function () { ui.titulo(null); pantallaInicial(); } });
    ui.botones(botones);
    if (!lectura) ui.foco('nombre');
  }

  if (params.proveedor && modo !== 'crear') {
    ui.get('XK03', { proveedor: params.proveedor }).then(detalle, pantallaInicial);
  } else {
    pantallaInicial();
  }
}`;

function pantallaModo(modo) {
  return `function (ui, params) { (${PANTALLA_PROVEEDOR})(ui, params, '${modo}'); }`;
}

export const XK01 = {
  code: 'XK01',
  titulo: 'Crear proveedor',
  menu: MENU,
  async post({ client, tenant_id, body, operator }) {
    const d = leerDatos(body);
    if (d.rut) {
      const dup = await client.query(
        `SELECT proveedor_id FROM erp_proveedores WHERE tenant_id = $1 AND rut = $2 LIMIT 1`,
        [tenant_id, d.rut]
      );
      if (dup.rowCount) throw fallo(`El RUT ${d.rut} ya está registrado en el proveedor ${dup.rows[0].proveedor_id}`, 409);
    }
    const id = await siguienteNumero(client, tenant_id, RANGOS.PROVEEDOR);
    await client.query(
      `INSERT INTO erp_proveedores (tenant_id, proveedor_id, nombre, rut, calle, ciudad, region, pais,
                                    telefono, email, contacto, condicion_pago, moneda, bloqueado, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [tenant_id, id, d.nombre, d.rut, d.calle, d.ciudad, d.region, d.pais, d.telefono, d.email,
        d.contacto, d.condicion_pago, d.moneda, d.bloqueado, operadorDe(operator)]
    );
    return { mensaje: `Se ha creado el proveedor ${id}`, proveedor: id };
  },
  screen: pantallaModo('crear'),
};

export const XK02 = {
  code: 'XK02',
  titulo: 'Modificar proveedor',
  menu: MENU,
  async post({ client, tenant_id, body }) {
    const actual = await leerProveedor(client, tenant_id, body.proveedor);
    const d = leerDatos(body);
    if (d.rut && d.rut !== actual.rut) {
      const dup = await client.query(
        `SELECT proveedor_id FROM erp_proveedores WHERE tenant_id = $1 AND rut = $2 AND proveedor_id <> $3 LIMIT 1`,
        [tenant_id, d.rut, actual.proveedor_id]
      );
      if (dup.rowCount) throw fallo(`El RUT ${d.rut} ya está registrado en el proveedor ${dup.rows[0].proveedor_id}`, 409);
    }
    await client.query(
      `UPDATE erp_proveedores SET nombre=$3, rut=$4, calle=$5, ciudad=$6, region=$7, pais=$8, telefono=$9,
              email=$10, contacto=$11, condicion_pago=$12, moneda=$13, bloqueado=$14, updated_at=NOW()
       WHERE tenant_id = $1 AND proveedor_id = $2`,
      [tenant_id, actual.proveedor_id, d.nombre, d.rut, d.calle, d.ciudad, d.region, d.pais, d.telefono,
        d.email, d.contacto, d.condicion_pago, d.moneda, d.bloqueado]
    );
    return { mensaje: `Se ha modificado el proveedor ${actual.proveedor_id}`, proveedor: actual.proveedor_id };
  },
  screen: pantallaModo('modificar'),
};

export const XK03 = {
  code: 'XK03',
  titulo: 'Visualizar proveedor',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    return leerProveedor(client, tenant_id, params.proveedor);
  },
  screen: pantallaModo('visualizar'),
};

export const MKVZ = {
  code: 'MKVZ',
  titulo: 'Lista de proveedores',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const valores = [tenant_id];
    let filtro = '';
    if (params.texto) {
      valores.push(`%${String(params.texto).slice(0, 80)}%`);
      filtro = ` AND (nombre ILIKE $2 OR proveedor_id ILIKE $2 OR rut ILIKE $2 OR ciudad ILIKE $2)`;
    }
    const r = await client.query(
      `SELECT proveedor_id, nombre, rut, ciudad, condicion_pago, moneda, bloqueado
       FROM erp_proveedores WHERE tenant_id = $1${filtro}
       ORDER BY proveedor_id LIMIT 500`,
      valores
    );
    return { proveedores: r.rows };
  },
  screen: `function (ui, params) {
    ui.pantalla(ui.grupo('Criterios de selección',
      ui.campo({ id: 'texto', etiqueta: 'Nombre / RUT / ciudad', valor: params.texto || '' })
    ) + '<div id="resultado"></div>');
    async function ejecutar() {
      var data = await ui.get('MKVZ', ui.valores());
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'proveedor_id', etiqueta: 'Proveedor', enlace: function (f) { ui.ir('XK03', { proveedor: f.proveedor_id }); } },
        { id: 'nombre', etiqueta: 'Nombre' },
        { id: 'rut', etiqueta: 'RUT' },
        { id: 'ciudad', etiqueta: 'Población' },
        { id: 'condicion_pago', etiqueta: 'Cond. pago' },
        { id: 'moneda', etiqueta: 'Moneda' },
        { id: 'bloqueado', etiqueta: 'Bloqueado', tipo: 'check' },
      ], data.proveedores);
      ui.mensaje('S', data.proveedores.length + ' proveedor(es) seleccionado(s)');
    }
    ui.botones([
      { texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar },
      { texto: 'Crear proveedor (XK01)', accion: function () { ui.ir('XK01'); } },
    ]);
    ejecutar();
  }`,
};

export default [XK01, XK02, XK03, MKVZ];
