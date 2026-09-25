// src/erp/ui/cliente.js
// Runtime del navegador del ERP: el "SAP GUI". Arma el campo de comandos, el
// menú SAP Easy Access, la barra de estado, las teclas (Enter, F3, F4, F8,
// Ctrl+S) y el objeto `ui` que recibe cada pantalla de transacción.
//
// OJO al editar: esto es un string que se inyecta en el HTML. No uses
// backticks ni barras invertidas adentro (se interpretarían aquí, en el servidor).

export const ERP_CLIENTE_SCRIPT = `
(function () {
  'use strict';
  var ERP = window.ERP;
  var contenido = document.getElementById('erp-contenido');
  var tituloEl = document.getElementById('erp-titulo');
  var barraBotones = document.getElementById('erp-botones');
  var estadoEl = document.getElementById('erp-estado');
  var estadoIcono = document.getElementById('erp-estado-icono');
  var txActualEl = document.getElementById('erp-tx-actual');
  var comando = document.getElementById('erp-comando');

  var generacion = 0;
  var pila = [];
  var actual = null;
  var botonesActuales = [];
  var enlaces = [];
  var ocupado = false;

  // ─── Utilidades de formato ───────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    return v.toLocaleString('es-CL', { maximumFractionDigits: 3 });
  }
  function dinero(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    return v.toLocaleString('es-CL', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fecha(d) {
    if (!d) return '';
    var s = String(d).slice(0, 10);
    var p = s.split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : s;
  }
  // Lee un número escrito a la chilena (el punto son los miles, la coma decimal).
  // Misma regla que numeroCL del servidor: acá solo sirve para mostrar totales
  // mientras se escribe; el que vale es el del servidor.
  function numeroCL(v) {
    var s = String(v == null ? '' : v).trim().replace(/\s/g, '');
    if (!s) return NaN;
    var punto = s.indexOf('.') >= 0;
    var coma = s.indexOf(',') >= 0;
    if (punto && coma) {
      var decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      var miles = decimal === ',' ? '.' : ',';
      s = s.split(miles).join('').replace(decimal, '.');
    } else if (coma) {
      s = s.replace(',', '.');
    } else if (punto && /^[0-9]{1,3}(\.[0-9]{3})+$/.test(s)) {
      s = s.split('.').join('');
    }
    return Number(s);
  }

  function hoy() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + String(d.getDate()).padStart(2, '0');
  }
  function leerLocal(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function guardarLocal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin storage */ } }

  // ─── Barra de estado (mensajes tipo SAP) ─────────────────────────────────
  var ICONOS = { S: '✔', E: '✖', W: '⚠', I: 'ℹ' };
  function mensaje(tipo, texto) {
    estadoEl.textContent = texto || '';
    estadoIcono.textContent = texto ? (ICONOS[tipo] || '') : '';
    document.getElementById('erp-barra-estado').className = 'erp-barra-estado' + (texto ? ' erp-msg-' + tipo : '');
  }

  // ─── Llamadas a la API ───────────────────────────────────────────────────
  function errorErp(msg) { var e = new Error(msg); e.erp = true; return e; }

  async function llamar(metodo, ruta, body, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(ruta, {
        method: metodo,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (!opts.silencioso) mensaje('E', 'Sin conexión con el servidor');
      throw errorErp('Sin conexión con el servidor');
    }
    if (res.status === 401) {
      window.location.replace('/login?next=/erp');
      throw errorErp('Sesión expirada');
    }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var msg = data.mensaje || data.error || ('Error HTTP ' + res.status);
      if (!opts.silencioso) mensaje(data.tipo || 'E', msg);
      throw errorErp(msg);
    }
    return data;
  }

  function query(params) {
    var usp = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === '' || v == null || v === false) return;
      usp.set(k, String(v));
    });
    var s = usp.toString();
    return s ? '?' + s : '';
  }

  // ─── Objeto ui: lo que recibe cada pantalla ──────────────────────────────
  function crearUi(gen, tx) {
    function vigente() { return gen === generacion; }
    var ui = {
      esc: esc, num: num, dinero: dinero, fecha: fecha, hoy: hoy, numeroCL: numeroCL,
      mensaje: function (t, m) { if (vigente()) mensaje(t, m); },
      titulo: function (t) { if (vigente()) tituloEl.textContent = t || tx.titulo; },
      pantalla: function (html) { if (!vigente()) return; enlaces = []; contenido.innerHTML = html; },
      q: function (sel) { return contenido.querySelector(sel); },
      qa: function (sel) { return Array.prototype.slice.call(contenido.querySelectorAll(sel)); },
      foco: function (id) {
        if (!vigente()) return;
        var el = contenido.querySelector('[data-campo="' + id + '"]');
        if (el) { el.focus(); if (el.select) el.select(); }
      },
      centroPorDefecto: function () { return ERP.centroDefault || ''; },
      get: function (code, params, opts) { return llamar('GET', '/api/erp/tx/' + code + query(params), null, opts); },
      post: function (code, body, opts) { return llamar('POST', '/api/erp/tx/' + code, body || {}, opts); },
      ir: function (code, params, opts) { if (vigente()) irA(code, params || {}, opts || {}); },
      botones: function (lista) { if (vigente()) pintarBotones(lista || []); },

      campo: function (o) {
        var id = 'c-' + o.id;
        var lectura = !!o.soloLectura;
        var etiqueta = '<label for="' + id + '">' + esc(o.etiqueta) + (o.obligatorio ? '<span class="erp-req" title="Obligatorio">*</span>' : '') + '</label>';
        var control;
        if (o.tipo === 'select') {
          control = '<select id="' + id + '" data-campo="' + esc(o.id) + '"' + (lectura ? ' disabled' : '') + '>' +
            (o.opciones || []).map(function (op) {
              return '<option value="' + esc(op[0]) + '"' + (String(op[0]) === String(o.valor) ? ' selected' : '') + '>' + esc(op[1]) + '</option>';
            }).join('') + '</select>';
        } else if (o.tipo === 'check') {
          control = '<input type="checkbox" id="' + id + '" data-campo="' + esc(o.id) + '"' + (o.valor ? ' checked' : '') + (lectura ? ' disabled' : '') + '>';
        } else {
          // Los numéricos van como texto a propósito: con type="number" el
          // navegador reinterpreta "4.500" según su idioma antes de que lo
          // veamos. Acá viaja tal cual y lo lee numeroCL en el servidor.
          var tipo = o.tipo === 'date' ? 'date' : 'text';
          var numerico = o.tipo === 'number';
          control = '<input type="' + tipo + '" id="' + id + '" data-campo="' + esc(o.id) + '" value="' + esc(o.valor == null ? '' : o.valor) + '"' +
            (numerico ? ' inputmode="decimal" class="erp-numerico"' : '') +
            ' style="width:' + ((o.ancho || 18) + 2) + 'ch"' + (lectura ? ' readonly tabindex="-1"' : '') +
            (o.obligatorio ? ' required' : '') + ' autocomplete="off">';
          if (o.f4 && !lectura) control += '<button type="button" class="erp-f4" data-f4="' + esc(o.f4) + '" data-para="' + id + '" title="Ayuda de búsqueda (F4)" tabindex="-1">⌕</button>';
        }
        var ayuda = o.ayuda ? '<span class="erp-ayuda-campo">' + esc(o.ayuda) + '</span>' : '';
        return '<div class="erp-campo' + (lectura ? ' erp-lectura' : '') + '">' + etiqueta + '<div class="erp-control">' + control + ayuda + '</div></div>';
      },

      celda: function (o) {
        var id = 'f' + o.fila + '-' + o.col;
        var attrs = ' id="' + id + '" data-fila="' + o.fila + '" data-col="' + esc(o.col) + '"' + (o.soloLectura ? ' disabled' : '');
        if (o.tipo === 'check') return '<input type="checkbox"' + attrs + (o.valor ? ' checked' : '') + '>';
        var tipo = o.tipo === 'date' ? 'date' : 'text';
        var html = '<input type="' + tipo + '"' + attrs + ' value="' + esc(o.valor == null ? '' : o.valor) + '"' +
          (o.tipo === 'number' ? ' inputmode="decimal" class="erp-numerico"' : '') +
          (o.ancho ? ' style="width:' + (o.ancho + 2) + 'ch"' : '') + ' autocomplete="off">';
        if (o.f4 && !o.soloLectura) html += '<button type="button" class="erp-f4" data-f4="' + esc(o.f4) + '" data-para="' + id + '" title="Ayuda de búsqueda (F4)" tabindex="-1">⌕</button>';
        return '<span class="erp-celda">' + html + '</span>';
      },

      grupo: function (titulo, html) {
        return '<fieldset class="erp-grupo"><legend>' + esc(titulo) + '</legend>' + html + '</fieldset>';
      },

      pestanas: function (lista) {
        var cab = lista.map(function (p, i) {
          return '<button type="button" class="erp-pestana' + (i === 0 ? ' activa' : '') + '" data-pestana="' + i + '">' + esc(p.titulo) + '</button>';
        }).join('');
        var cuerpos = lista.map(function (p, i) {
          return '<div class="erp-pestana-cuerpo" data-cuerpo="' + i + '"' + (i === 0 ? '' : ' hidden') + '>' + p.html + '</div>';
        }).join('');
        return '<div class="erp-pestanas"><div class="erp-pestanas-cab">' + cab + '</div>' + cuerpos + '</div>';
      },

      valores: function () {
        var out = {};
        contenido.querySelectorAll('[data-campo]').forEach(function (el) {
          var k = el.getAttribute('data-campo');
          out[k] = el.type === 'checkbox' ? el.checked : String(el.value || '').trim();
        });
        return out;
      },

      filas: function (opts) {
        opts = opts || {};
        var porFila = {};
        contenido.querySelectorAll('[data-fila][data-col]').forEach(function (el) {
          var f = el.getAttribute('data-fila');
          porFila[f] = porFila[f] || {};
          porFila[f][el.getAttribute('data-col')] = el.type === 'checkbox' ? el.checked : String(el.value || '').trim();
        });
        return Object.keys(porFila).sort(function (a, b) { return a - b; }).map(function (k) { return porFila[k]; })
          .filter(function (f) {
            if (opts.incluirVacias) return true;
            return Object.keys(f).some(function (k) { return typeof f[k] === 'string' && f[k] !== ''; });
          });
      },

      tabla: function (columnas, filas, opts) {
        opts = opts || {};
        var cab = '<tr>' + columnas.map(function (c) {
          var der = ['qty', 'money', 'num'].indexOf(c.tipo) >= 0;
          return '<th' + (der ? ' class="erp-num"' : '') + '>' + esc(c.etiqueta) + '</th>';
        }).join('') + '</tr>';
        if (!filas || !filas.length) {
          return '<table class="erp-tabla"><thead>' + cab + '</thead><tbody><tr><td colspan="' + columnas.length + '" class="erp-vacio">No se han seleccionado datos</td></tr></tbody></table>';
        }
        var cuerpo = filas.map(function (f) {
          var clase = opts.resaltar && opts.resaltar(f) ? ' class="erp-fila-alerta"' : '';
          return '<tr' + clase + '>' + columnas.map(function (c) {
            var v = f[c.id];
            var txt;
            if (c.tipo === 'qty' || c.tipo === 'num') txt = num(v);
            else if (c.tipo === 'money') txt = dinero(v);
            else if (c.tipo === 'date') txt = fecha(v);
            else if (c.tipo === 'check') txt = v ? '✔' : '';
            else if (c.tipo === 'estado') txt = '<span class="erp-estado-' + esc(String(v || '').toLowerCase()) + '">' + esc(v) + '</span>';
            else if (c.tipo === 'accion') txt = '';
            else txt = esc(v);
            if (c.enlace && (c.tipo !== 'accion' || !c.mostrar || c.mostrar(f))) {
              var idx = enlaces.push({ fn: c.enlace, fila: f }) - 1;
              txt = c.tipo === 'accion'
                ? '<button type="button" class="erp-btn-mini" data-enlace="' + idx + '">' + esc(c.texto || 'Ir') + '</button>'
                : (v == null || v === '' ? '' : '<a href="#" data-enlace="' + idx + '">' + txt + '</a>');
            }
            var der = ['qty', 'money', 'num'].indexOf(c.tipo) >= 0;
            return '<td' + (der ? ' class="erp-num"' : '') + '>' + txt + '</td>';
          }).join('') + '</tr>';
        }).join('');
        return '<div class="erp-tabla-scroll"><table class="erp-tabla"><thead>' + cab + '</thead><tbody>' + cuerpo + '</tbody></table></div>';
      },
    };
    return ui;
  }

  // ─── Barra de botones de la aplicación ───────────────────────────────────
  function pintarBotones(lista) {
    botonesActuales = lista;
    barraBotones.innerHTML = lista.map(function (b, i) {
      return '<button type="button" class="erp-btn' + (b.primario ? ' erp-btn-primario' : '') + '" data-boton="' + i + '">' +
        esc(b.texto) + (b.tecla ? ' <kbd>' + esc(b.tecla) + '</kbd>' : '') + '</button>';
    }).join('');
  }

  function ejecutarAccion(fn) {
    if (ocupado) return;
    ocupado = true;
    document.body.classList.add('erp-ocupado');
    Promise.resolve().then(fn).catch(function (e) {
      if (!e || !e.erp) { console.error(e); mensaje('E', (e && e.message) || 'Error inesperado'); }
    }).then(function () {
      ocupado = false;
      document.body.classList.remove('erp-ocupado');
    });
  }

  function botonPorTecla(tecla) {
    for (var i = 0; i < botonesActuales.length; i++) if (botonesActuales[i].tecla === tecla) return botonesActuales[i];
    return null;
  }

  // ─── Navegación entre transacciones ──────────────────────────────────────
  function irA(code, params, opts) {
    code = String(code || '').toUpperCase();
    if (code && !ERP.screens[code]) { mensaje('E', 'La transacción ' + code + ' no existe'); return; }
    if (actual && !opts.sinHistorial) pila.push(actual);
    if (pila.length > 30) pila.shift();
    abrir(code, params, opts);
  }

  function abrir(code, params, opts) {
    opts = opts || {};
    generacion += 1;
    actual = { code: code, params: params || {} };
    enlaces = [];
    mensaje(null, '');
    pintarBotones([]);
    contenido.innerHTML = '<p class="erp-ayuda">Cargando…</p>';
    contenido.scrollTop = 0;
    contenido.scrollLeft = 0;
    var hash = code ? '#' + code + query(params) : '#';
    try { history.replaceState(null, '', hash === '#' ? location.pathname : hash); } catch (e) { /* ignore */ }

    if (!code) {
      txActualEl.textContent = 'ERP';
      tituloEl.textContent = 'SAP Easy Access — Menú de usuario';
      document.title = 'ERP · Easy Access';
      pintarInicio();
    } else {
      var tx = ERP.catalogo[code];
      txActualEl.textContent = code;
      tituloEl.textContent = tx.titulo;
      document.title = code + ' · ' + tx.titulo;
      recordarReciente(code);
      var ui = crearUi(generacion, tx);
      try {
        var r = ERP.screens[code](ui, Object.assign({}, params || {}));
        if (r && r.catch) r.catch(function (e) { if (!e || !e.erp) mensaje('E', (e && e.message) || 'Error'); });
      } catch (e) {
        console.error(e);
        mensaje('E', 'Error en la pantalla ' + code + ': ' + e.message);
      }
    }
    if (opts.mensaje) mensaje(opts.mensaje[0], opts.mensaje[1]);
  }

  function atras() {
    var b = botonPorTecla('F3');
    if (b) return ejecutarAccion(b.accion);
    var prev = pila.pop();
    if (prev) abrir(prev.code, prev.params);
    else abrir('', {});
  }

  function ejecutarComando(texto) {
    var t = String(texto || '').trim().toUpperCase();
    comando.value = '';
    if (!t) return;
    if (t === '/N' || t === '/NEX' || t === 'SMEN') { pila = []; return abrir('', {}); }
    if (t.indexOf('/O') === 0) { window.open('/erp#' + t.slice(2), '_blank'); return; }
    if (t.indexOf('/N') === 0) { pila = []; t = t.slice(2); }
    if (!ERP.screens[t]) return mensaje('E', 'La transacción ' + t + ' no existe');
    irA(t, {}, {});
  }

  // ─── Menú SAP Easy Access ────────────────────────────────────────────────
  function recordarReciente(code) {
    var r = leerLocal('erp_recientes', []).filter(function (c) { return c !== code; });
    r.unshift(code);
    guardarLocal('erp_recientes', r.slice(0, 8));
  }

  function arbolMenu() {
    var raiz = { hijos: {}, tx: [] };
    Object.keys(ERP.catalogo).forEach(function (code) {
      var tx = ERP.catalogo[code];
      var nodo = raiz;
      tx.menu.forEach(function (nivel) {
        nodo.hijos[nivel] = nodo.hijos[nivel] || { hijos: {}, tx: [] };
        nodo = nodo.hijos[nivel];
      });
      nodo.tx.push(tx);
    });
    function pintar(nodo) {
      var html = '<ul>';
      Object.keys(nodo.hijos).forEach(function (nombre) {
        html += '<li><details open><summary>📁 ' + esc(nombre) + '</summary>' + pintar(nodo.hijos[nombre]) + '</details></li>';
      });
      nodo.tx.forEach(function (tx) {
        html += '<li class="erp-menu-tx"><a href="#" data-tx="' + esc(tx.code) + '"><span class="erp-menu-code">' + esc(tx.code) + '</span> ' + esc(tx.titulo) + '</a></li>';
      });
      return html + '</ul>';
    }
    return pintar(raiz);
  }

  function pintarInicio() {
    var recientes = leerLocal('erp_recientes', []).filter(function (c) { return ERP.catalogo[c]; });
    contenido.innerHTML =
      '<div class="erp-inicio">' +
        '<nav class="erp-menu" aria-label="Menú SAP">' +
          '<div class="erp-menu-titulo">⭐ Favoritos</div>' +
          (recientes.length
            ? '<ul>' + recientes.map(function (c) { return '<li class="erp-menu-tx"><a href="#" data-tx="' + c + '"><span class="erp-menu-code">' + c + '</span> ' + esc(ERP.catalogo[c].titulo) + '</a></li>'; }).join('') + '</ul>'
            : '<p class="erp-ayuda">Las transacciones que uses aparecerán aquí.</p>') +
          '<div class="erp-menu-titulo">📂 Menú SAP</div>' + arbolMenu() +
        '</nav>' +
        '<section class="erp-bienvenida">' +
          '<h2>Bienvenido al ERP — módulos MM (materiales) y PP (producción)</h2>' +
          '<p>Escribe un código de transacción en el campo de comandos de arriba (por ejemplo <b>ME21N</b>) y presiona <kbd>Enter</kbd>, o haz clic en el menú de la izquierda.</p>' +
          '<h3>Circuito de compras (hazlo en este orden la primera vez)</h3>' +
          '<ol class="erp-pasos">' +
            '<li><a href="#" data-tx="MM01">MM01</a> Crear el material (el producto que compras y vendes).</li>' +
            '<li><a href="#" data-tx="XK01">XK01</a> Crear el proveedor que te lo vende.</li>' +
            '<li><a href="#" data-tx="ME21N">ME21N</a> Crear el pedido de compra (todavía no hay stock).</li>' +
            '<li><a href="#" data-tx="MIGO">MIGO</a> Cuando llega el camión: entrada de mercancías, clase 101. <b>Aquí sube el stock</b>.</li>' +
            '<li><a href="#" data-tx="MMBE">MMBE</a> Ver el stock: libre, reservado por la Torre y en pedido.</li>' +
            '<li><a href="#" data-tx="MB51">MB51</a> Ver todos los movimientos, incluidos los despachos de la Torre (601).</li>' +
          '</ol>' +
          '<h3>Circuito de producción</h3>' +
          '<ol class="erp-pasos">' +
            '<li><a href="#" data-tx="CS01">CS01</a> Crear la receta (lista de materiales) del producto terminado (FERT) o semielaborado (HALB).</li>' +
            '<li><a href="#" data-tx="CO01">CO01</a> Crear la orden de producción. <b>Verificar</b> muestra qué insumos faltan.</li>' +
            '<li><a href="#" data-tx="CO02">CO02</a> Liberar la orden: <b>aparta los insumos</b> para que la Torre no los venda.</li>' +
            '<li><a href="#" data-tx="MIGO">MIGO</a> Salida + Orden (261) para entregar insumos a producción; Entrada + Orden (101) para lo fabricado. Los insumos con descuento automático bajan solos.</li>' +
            '<li><a href="#" data-tx="CO02">CO02</a> Cierre técnico (TECO) cuando no se fabrica más: lo apartado que sobró vuelve a libre.</li>' +
            '<li><a href="#" data-tx="COOIS">COOIS</a> Ver todas las órdenes y su avance.</li>' +
          '</ol>' +
          '<h3>Teclas como en SAP</h3>' +
          '<ul class="erp-teclas">' +
            '<li><kbd>Enter</kbd> continuar</li><li><kbd>F3</kbd> atrás</li><li><kbd>F4</kbd> ayuda de búsqueda en un campo</li>' +
            '<li><kbd>F8</kbd> ejecutar un reporte</li><li><kbd>Ctrl</kbd>+<kbd>S</kbd> grabar</li>' +
            '<li><kbd>/n</kbd>CÓDIGO sale de la transacción actual y abre otra · <kbd>/o</kbd>CÓDIGO la abre en otra pestaña</li>' +
          '</ul>' +
        '</section>' +
      '</div>';
  }

  // ─── Ayuda de búsqueda F4 ────────────────────────────────────────────────
  var popup = document.getElementById('erp-f4');
  var popupLista = document.getElementById('erp-f4-lista');
  var popupBuscar = document.getElementById('erp-f4-buscar');
  var popupDestino = null;
  var popupTipo = null;
  var popupTimer = null;

  function abrirF4(tipo, inputId) {
    popupTipo = tipo;
    popupDestino = document.getElementById(inputId);
    document.getElementById('erp-f4-titulo').textContent = 'Ayuda de búsqueda: ' + tipo;
    popupBuscar.value = popupDestino && popupDestino.value ? popupDestino.value : '';
    popup.hidden = false;
    popupBuscar.focus();
    popupBuscar.select();
    buscarF4();
  }
  function cerrarF4() {
    popup.hidden = true;
    if (popupDestino) popupDestino.focus();
    popupDestino = null;
  }
  async function buscarF4() {
    popupLista.innerHTML = '<li class="erp-ayuda">Buscando…</li>';
    try {
      var data = await llamar('GET', '/api/erp/f4/' + popupTipo + query({ q: popupBuscar.value.trim() }), null, { silencioso: true });
      popupLista.innerHTML = data.valores.length
        ? data.valores.map(function (v) {
            return '<li><button type="button" data-valor="' + esc(v.valor) + '"><b>' + esc(v.valor) + '</b> <span>' + esc(v.texto || '') + '</span></button></li>';
          }).join('')
        : '<li class="erp-ayuda">Sin resultados</li>';
    } catch (e) {
      popupLista.innerHTML = '<li class="erp-ayuda">' + esc(e.message) + '</li>';
    }
  }
  popupBuscar.addEventListener('input', function () { clearTimeout(popupTimer); popupTimer = setTimeout(buscarF4, 250); });
  popupLista.addEventListener('click', function (e) {
    var b = e.target.closest('[data-valor]');
    if (!b || !popupDestino) return;
    popupDestino.value = b.getAttribute('data-valor');
    popupDestino.dispatchEvent(new Event('change', { bubbles: true }));
    cerrarF4();
  });
  document.getElementById('erp-f4-cerrar').addEventListener('click', cerrarF4);

  // ─── Eventos globales ────────────────────────────────────────────────────
  contenido.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tx],[data-enlace],[data-f4],[data-pestana]');
    if (!t) return;
    if (t.hasAttribute('data-tx')) { e.preventDefault(); irA(t.getAttribute('data-tx'), {}, {}); return; }
    if (t.hasAttribute('data-enlace')) {
      e.preventDefault();
      var en = enlaces[Number(t.getAttribute('data-enlace'))];
      if (en) ejecutarAccion(function () { return en.fn(en.fila); });
      return;
    }
    if (t.hasAttribute('data-f4')) { abrirF4(t.getAttribute('data-f4'), t.getAttribute('data-para')); return; }
    if (t.hasAttribute('data-pestana')) {
      var cont = t.closest('.erp-pestanas');
      var idx = t.getAttribute('data-pestana');
      cont.querySelectorAll('.erp-pestana').forEach(function (b) { b.classList.toggle('activa', b === t); });
      cont.querySelectorAll('.erp-pestana-cuerpo').forEach(function (c) { c.hidden = c.getAttribute('data-cuerpo') !== idx; });
    }
  });

  barraBotones.addEventListener('click', function (e) {
    var b = e.target.closest('[data-boton]');
    if (!b) return;
    var def = botonesActuales[Number(b.getAttribute('data-boton'))];
    if (def) ejecutarAccion(def.accion);
  });

  comando.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); ejecutarComando(comando.value); }
  });
  document.getElementById('erp-comando-ok').addEventListener('click', function () { ejecutarComando(comando.value); });
  document.getElementById('erp-atras').addEventListener('click', atras);
  document.getElementById('erp-inicio').addEventListener('click', function () { pila = []; abrir('', {}); });
  document.getElementById('erp-salir').addEventListener('click', async function () {
    try { await fetch('/api/operator/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
    window.location.replace('/login?next=/erp');
  });

  document.addEventListener('keydown', function (e) {
    if (!popup.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); cerrarF4(); }
      if (e.key === 'Enter' && e.target === popupBuscar) {
        e.preventDefault();
        var primero = popupLista.querySelector('[data-valor]');
        if (primero) primero.click();
      }
      return;
    }
    if (e.key === 'F3') { e.preventDefault(); atras(); return; }
    if (e.key === 'F8') { e.preventDefault(); var b8 = botonPorTecla('F8'); if (b8) ejecutarAccion(b8.accion); return; }
    if (e.key === 'F4') {
      e.preventDefault();
      var el = document.activeElement;
      var f4 = el && el.id ? contenido.querySelector('[data-para="' + el.id + '"]') : null;
      if (f4) abrirF4(f4.getAttribute('data-f4'), el.id);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      var bs = botonPorTecla('Ctrl+S');
      if (bs) ejecutarAccion(bs.accion);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); comando.focus(); return; }
    if (e.key === 'Enter' && contenido.contains(e.target) && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      var be = botonPorTecla('Enter');
      if (be) { e.preventDefault(); ejecutarAccion(be.accion); }
    }
  });

  // Enlaces directos (/erp#MMBE?material=X) abiertos con la página ya cargada.
  window.addEventListener('hashchange', function () {
    var h = desdeHash();
    if (!h.code || ERP.screens[h.code]) irA(h.code, h.params, {});
  });

  window.addEventListener('unhandledrejection', function (e) {
    if (e.reason && e.reason.erp) e.preventDefault();
  });

  // ─── Arranque ────────────────────────────────────────────────────────────
  function desdeHash() {
    var h = decodeURIComponent(location.hash.replace('#', ''));
    if (!h) return { code: '', params: {} };
    var partes = h.split('?');
    var params = {};
    new URLSearchParams(partes[1] || '').forEach(function (v, k) { params[k] = v; });
    return { code: partes[0].toUpperCase(), params: params };
  }

  llamar('GET', '/api/erp/f4/centro', null, { silencioso: true }).then(function (d) {
    ERP.centros = d.valores || [];
    ERP.centroDefault = ERP.centros.length ? ERP.centros[0].valor : '';
  }).catch(function () { /* sin centros */ }).then(function () {
    var inicio = desdeHash();
    if (inicio.code && !ERP.screens[inicio.code]) inicio.code = '';
    abrir(inicio.code, inicio.params);
    comando.focus();
  });
})();
`;
