# ERP módulo MM — Guía de uso y de extensión

Un ERP tipo SAP, módulo **MM (Gestión de materiales)**, conectado a la Torre de Control.
Usa los mismos códigos de transacción, clases de movimiento y nombres que SAP, así que lo que
aprendas acá te sirve en un SAP real.

- **Entrar:** `https://<tu-worker>/erp`, o el botón **ERP** en la cabecera de la Torre.
  Es el mismo usuario y contraseña de la Torre.
- **Datos:** usa la misma base de datos que la Torre. Lo que hagas acá cambia el stock que la Torre reserva y despacha.

---

## 1. Diccionario SAP → este sistema

| En SAP | Acá | Qué es |
|---|---|---|
| Material | `productos` (SKU) | El producto. Es el mismo SKU que traen los pedidos de venta (Shopify, ERP, etc.) |
| Centro | Bodega (`depots`) | El lugar físico donde está el stock. En la Torre se llama "bodega" |
| Acreedor / Proveedor | `erp_proveedores` | A quién le compras. Número desde 100000 |
| Pedido de compra (EKKO/EKPO) | `erp_pedidos_compra(_pos)` | Lo que le pides al proveedor. Número desde 4500000000, posiciones 10, 20, 30… |
| Documento de material (MKPF/MSEG) | `erp_documentos_material(_pos)` | El "comprobante" de cada movimiento de stock. Número desde 5000000000 |
| Clase de movimiento | `clase_movimiento` | Código de 3 dígitos que dice qué tipo de movimiento fue (tabla abajo) |
| Stock libre utilización | `inventario_bodega.qty_disponible` | Lo que se puede vender o reservar ahora |
| Stock reservado | `inventario_bodega.qty_reservada` | Lo que la Torre apartó para pedidos de venta en picking o packing |
| Punto de pedido | `inventario_bodega.qty_minima` | Bajo esta cantidad, MMBE lo marca y ofrece "Pedir" |

### Clases de movimiento

| Clase | Qué hace | Dónde nace |
|---|---|---|
| **101** | Entrada de mercancías por pedido de compra (+ stock) | MIGO |
| **102** | Anulación de un 101 | MIGO → A03 Anulación |
| **501** | Entrada sin pedido (+ stock), por ejemplo una devolución o un regalo del proveedor | MIGO → R10 Otros |
| **502** | Anulación de un 501 | MIGO |
| **551** | Salida por desguace o merma: cajas rotas, vencidos (− stock) | MIGO → A07 Salida |
| **552** | Anulación de un 551 | MIGO |
| **561** | Entrada inicial de stock (alta de producto en la Torre) | Torre (solo lectura en MB51) |
| **601** | Salida por entrega: el despacho que confirma packing en la Torre | Torre (solo lectura en MB51) |
| **701 / 702** | Diferencia de inventario (+/−): sobrante o faltante al contar | MI07, o ajustes manuales de la Torre |

---

## 2. Transacciones disponibles

Escribe el código en el campo de comandos (arriba a la izquierda) y presiona **Enter**.

| Código | Nombre | Para qué |
|---|---|---|
| MM01 | Crear material | Dar de alta un producto nuevo (sin stock) |
| MM02 | Modificar material | Cambiar datos, precio o punto de pedido, o ampliarlo a otro centro |
| MM03 | Visualizar material | Ver la ficha y el stock por centro |
| MM60 | Lista de materiales | Buscar materiales |
| XK01 / XK02 / XK03 | Proveedor crear / modificar / visualizar | Maestro de proveedores. El RUT se valida con dígito verificador |
| MKVZ | Lista de proveedores | Buscar proveedores |
| ME21N | Crear pedido | Pedido de compra al proveedor |
| ME22N | Modificar pedido | Cambiar cantidad, precio o fecha, borrar posiciones o añadir nuevas (con reglas SAP, ver abajo) |
| ME23N | Visualizar pedido | Ver el pedido con lo recibido, lo pendiente, el historial de entradas y las modificaciones |
| ME2N | Pedidos por proveedor / material | Lista de posiciones de pedido y lo que falta por llegar |
| MIGO | Movimiento de mercancías | Entradas 101/501, salidas 551, anulaciones y visualizar documentos |
| MMBE | Resumen de stocks | Libre, reservado por la Torre, en pedido y valor |
| MB51 | Lista de documentos de material | Todos los movimientos: los del ERP y los de la Torre |
| MI01 | Crear documento de inventario | Elegir centro y materiales a contar (o todos los del centro) |
| MI04 | Ingresar recuento | Anotar lo contado, a ciegas (no muestra el stock del sistema) |
| MI03 | Visualizar documento de inventario | Contado vs sistema, diferencias y su valor |
| MI20 | Lista de diferencias | Todas las diferencias pendientes de contabilizar, con su valor |
| MI07 | Contabilizar diferencias | Ajusta el stock: 701 sobrante, 702 faltante |

### Reglas de ME22N (las mismas de SAP)

- **Cantidad**: no puede quedar bajo lo ya recibido.
- **Precio**: solo se cambia en posiciones sin entradas de mercancía (lo recibido ya se valoró con el precio anterior).
- **Borrar**: marca el *indicador de borrado*. La posición queda visible pero sin pendiente: no suma "En pedido" en MMBE ni admite MIGO.
  - Solo se puede borrar si no tiene entradas; si las tiene, anúlalas primero en MIGO.
  - Desmarcar la casilla la restaura.
- **Posiciones nuevas**: siguen la numeración (30, 40…). No se permiten si el proveedor está bloqueado.
- **Auditoría**: cada campo cambiado queda en ME23N → *Modificaciones*, con usuario, valor anterior y valor nuevo (en SAP son CDHDR/CDPOS, tabla `erp_cambios` acá).

### Inventario físico paso a paso

1. **MI01**: crea el documento, por ejemplo "Conteo mensual Bodega Central".
   - Un material no puede estar en dos inventarios abiertos del mismo centro.
2. **MI04**: sale alguien con la hoja a contar y anota lo que ve.
   - Es **a ciegas**: la pantalla no muestra cuánto dice el sistema, para que nadie "ajuste" el conteo.
   - Vacío = no contado; **0** = contado y no hay nada.
   - Se puede recontar (volver a MI04) mientras no se haya contabilizado.
3. **MI03 / MI20**: revisa las diferencias y su valor en pesos.
   - Si una diferencia se ve rara, recuenta antes de contabilizar.
4. **MI07**: contabiliza (usa **Verificar** primero).
   - Sobrante → 701 (sube el stock libre). Faltante → 702 (lo baja).
   - Queda un documento de material que ves en MB51.
   - Si un sobrante alcanza para pedidos de venta en quiebre, se liberan solos.

**Importante:** cuenta también lo que está apartado para pedidos (reservado por la Torre), porque sigue físicamente en la bodega hasta el packing.
- Si falta mercadería **ya reservada**, MI07 no contabiliza y te avisa.
- Primero hay que resolver esos pedidos (o recontar): así la Torre nunca queda con reservas de stock que no existe.
- Lo ideal es contar cuando no hay movimientos (antes de abrir o después del despacho), porque MI07 compara contra el stock del momento en que contabilizas.

### Teclas (como en SAP)

| Tecla | Acción |
|---|---|
| `Enter` | Continuar |
| `F3` | Atrás |
| `F4` | Ayuda de búsqueda en el campo donde está el cursor |
| `F8` | Ejecutar un reporte |
| `Ctrl+S` | Grabar o contabilizar |
| `/nCÓDIGO` | Sale de la transacción actual y abre otra |
| `/oCÓDIGO` | Abre la transacción en otra pestaña |
| `Ctrl+/` | Ir al campo de comandos |

Enlace directo a una transacción: `/erp#MMBE?material=SKU-1`.

---

## 3. El circuito de compras paso a paso

1. **MM01**: crea el material, por ejemplo `AGUA-12`, "Caja agua 12x500ml".
   - En *Contabilidad* pon el precio estándar.
   - En *Almacén / Centros* elige el centro y el punto de pedido.
2. **XK01**: crea el proveedor. Te devuelve un número, por ejemplo `100000`.
3. **ME21N**: crea el pedido con proveedor `100000`, material `AGUA-12`, cantidad 24 y centro Bodega Central.
   - **Verificar** revisa sin grabar. **Grabar** te da el número `4500000000`.
   - El stock todavía **no** sube: un pedido es solo una promesa.
4. **MIGO**, cuando llega el camión:
   - Elige *A01 Entrada de mercancías* + *R01 Pedido*, escribe el pedido y presiona Enter.
   - Marca **OK** en lo que llegó y corrige la cantidad si llegó menos.
   - Presiona **Contabilizar**. Nace el documento `5000000000` y **el stock sube**.
   - El pedido queda PARCIAL si falta algo, o CERRADO si llegó todo.
5. La Torre ya ve ese stock. Cuando entra un pedido de venta con ese SKU, la Torre lo **reserva**; **MMBE** lo muestra como "Reservado (Torre)".
   - Si el pedido de venta llegó **antes** que la mercadería, queda en **QUIEBRE** y MMBE lo muestra en la columna "Demanda en quiebre".
   - Al contabilizar un MIGO que sube stock (101, 501 o una anulación 552), el sistema reintenta solo esos pedidos, del más antiguo al más nuevo, y los pasa a picking.
   - El mensaje verde dice cuáles se liberaron. **Verificar** te muestra cuáles se liberarían, sin grabar.
   - El botón "Pedir" de MMBE sugiere una cantidad que ya incluye esa demanda.
6. Cuando la Torre confirma el **packing**, el reservado se descuenta y en **MB51** aparece como **601**.
7. ¿Te equivocaste? **MIGO → A03 Anulación → documento**.
   - Crea el movimiento inverso (102/502/552) y devuelve lo recibido al pedido.
   - No te deja anular si el stock ya se vendió: el sistema nunca deja stock negativo.

### Reglas que el sistema garantiza

- **Todo o nada:** cada Grabar o Contabilizar corre en una transacción SQL. Si una posición falla, no se graba ninguna.
- **Nunca stock negativo** (mensaje "Déficit de stock libre utilización").
- **No se recibe más de lo pedido** en un 101.
- **Un documento se anula una sola vez.**
- **Números correlativos sin huecos:** Verificar no consume número.
- **Auditoría:** cada Grabar queda en `audit_log` con el usuario (`erp.me21n`, `erp.migo`, …).

---

## 4. Cómo agregar una transacción nueva

Cada transacción es un objeto JavaScript con esta forma:

```js
export const MB52 = {
  code: 'MB52',                                   // lo que se escribe en el campo de comandos
  titulo: 'Stock de almacén valorado',            // título en la barra
  menu: ['Logística', 'Gestión de materiales', 'Gestión de stocks', 'Entorno'], // carpeta del menú
  async get({ client, tenant_id, params, operator }) { ... },   // opcional: lectura (GET)
  async post({ client, tenant_id, body, operator }) { ... },    // opcional: grabar (POST, transacción SQL)
  screen: `function (ui, params) { ... }`,        // la pantalla (corre en el navegador)
};
```

### Paso a paso: ejemplo completo (MB52 — stock valorado por centro)

**1. Crea `src/erp/transacciones/mb52.js`:**

```js
const MENU = ['Logística', 'Gestión de materiales', 'Gestión de stocks', 'Entorno'];

export const MB52 = {
  code: 'MB52',
  titulo: 'Stock de almacén valorado',
  menu: MENU,
  async get({ client, tenant_id, params }) {
    const valores = [tenant_id];
    let filtro = '';
    if (params.centro) { valores.push(params.centro); filtro = ' AND i.depot_id = $2'; }
    const r = await client.query(
      `SELECT i.depot_id AS centro, COUNT(*) AS materiales,
              SUM((i.qty_disponible + i.qty_reservada) * p.precio_estandar) AS valor
       FROM inventario_bodega i
       JOIN productos p ON p.tenant_id = i.tenant_id AND p.sku = i.sku
       WHERE i.tenant_id = $1${filtro}
       GROUP BY i.depot_id ORDER BY i.depot_id`,
      valores
    );
    return { filas: r.rows };
  },
  screen: `function (ui, params) {
    ui.pantalla(
      ui.grupo('Criterios de selección', ui.campo({ id: 'centro', etiqueta: 'Centro', f4: 'centro' })) +
      '<div id="resultado"></div>'
    );
    async function ejecutar() {
      var data = await ui.get('MB52', ui.valores());
      ui.q('#resultado').innerHTML = ui.tabla([
        { id: 'centro', etiqueta: 'Centro' },
        { id: 'materiales', etiqueta: 'N° materiales', tipo: 'num' },
        { id: 'valor', etiqueta: 'Valor (CLP)', tipo: 'money' },
      ], data.filas);
      ui.mensaje('S', data.filas.length + ' centro(s)');
    }
    ui.botones([{ texto: 'Ejecutar', tecla: 'F8', primario: true, accion: ejecutar }]);
  }`,
};

export default [MB52];
```

**2. Regístrala en `src/erp/registry.js`:**

```js
import mb52 from './transacciones/mb52.js';
const MODULOS = [material, proveedor, pedido, migo, stock, mb52];
```

**3. Prueba y despliega:**

```bash
npx vitest run --config vitest.config.node.mjs src/erp
npx wrangler deploy --env staging
```

El test de `src/erp/erp.test.js` revisa solo que:
- el código no esté repetido,
- la pantalla sea JavaScript válido,
- el menú y el título existan.

Eso es todo: la transacción aparece en el menú, en el campo de comandos y en la API
(`GET /api/erp/tx/MB52`) con login y auditoría incluidos.

### Si tu transacción graba datos (`post`)

- Valida con los helpers de `src/erp/core.js`:
  - `texto()`, `cantidad()`, `importe()`, `fecha()`, `opcion()`, `rutChileno()`
  - `validarCentro()`, `leerMaterial()`, `leerProveedor()`
- Para un error "de SAP" usa `throw fallo('mensaje')`. El usuario lo ve en rojo en la barra de estado y **nada se graba**.
- Para números correlativos usa `siguienteNumero(client, tenant_id, RANGOS.X)`. Agrega tu rango en `RANGOS`.
- Si mueves stock, **no escribas `inventario_bodega` a mano**: reutiliza la lógica de `migo.js` (`moverStock`) para que la Torre y MB51 lo vean.
- Para auditar cambios de campos usa `registrarCambio()` de `core.js` (ver ME22N).
- Si necesitas una tabla nueva:
  - agrégala a `src/erp/schema.js` (respaldo en runtime),
  - y a una migración `migrations/0XX_*.sql` con RLS (copia el bloque `DO $$ ... $$` de la 025).

### El objeto `ui` (lo que recibe cada pantalla)

| Función | Qué hace |
|---|---|
| `ui.pantalla(html)` | Reemplaza el contenido de la pantalla |
| `ui.titulo(texto)` | Cambia el título (`null` vuelve al de la transacción) |
| `ui.grupo(titulo, html)` | Recuadro con título (group box de SAP) |
| `ui.pestanas([{titulo, html}])` | Pestañas (todas se leen con `ui.valores()`) |
| `ui.campo({id, etiqueta, tipo, valor, obligatorio, soloLectura, f4, ancho, ayuda, opciones})` | Campo con etiqueta. `tipo`: text, number, date, select, check. `f4`: material, proveedor, centro, pedido |
| `ui.valores()` | `{id: valor}` de todos los campos |
| `ui.celda({fila, col, valor, tipo, f4})` + `ui.filas()` | Grillas editables (ver ME21N) |
| `ui.tabla(columnas, filas, {resaltar})` | Tabla de resultados. Columnas: `{id, etiqueta, tipo: qty/money/num/date/check/estado, enlace: fn}` |
| `ui.botones([{texto, tecla, primario, accion}])` | Botones de la aplicación. `tecla`: Enter, F3, F8, Ctrl+S |
| `ui.get(code, params)` / `ui.post(code, body)` | Llamar a la API de una transacción (si falla, el error ya se muestra) |
| `ui.mensaje(tipo, texto)` | Barra de estado: S verde, E rojo, W amarillo, I azul |
| `ui.ir(code, params)` | Saltar a otra transacción (F3 vuelve) |
| `ui.foco(id)`, `ui.q(sel)`, `ui.qa(sel)` | Foco y selectores dentro de la pantalla |
| `ui.num()`, `ui.dinero()`, `ui.fecha()`, `ui.hoy()`, `ui.esc()` | Formatos (`esc` escapa HTML: úsalo siempre con texto del usuario) |
| `ui.centroPorDefecto()` | Centro por defecto del tenant |

> ⚠️ `screen` es un string: adentro **no uses backticks ni `${}`** (se evaluarían en el servidor).
> Usa comillas simples y concatenación con `+`.

---

## 5. Ejercicios sugeridos (en orden de dificultad)

1. **MB52**: el ejemplo de arriba.
2. **MB1B / clase 311 — Traslado entre centros**: resta en un centro y suma en otro, en un solo documento con dos líneas.
3. **ME29N — Liberación de pedidos**: un pedido sobre cierto monto queda bloqueado hasta que un admin lo libere (`operator.is_admin`).
4. **MIRO — Verificación de facturas**: el siguiente módulo natural (FI). Registra la factura del proveedor contra el pedido y lo recibido (el "3-way match").

---

## 6. Mapa de archivos

```
src/erp/
  core.js                 validaciones, errores tipo SAP, rangos de números
  schema.js               tablas (respaldo runtime de migrations/025_erp_mm.sql)
  registry.js             lista de transacciones + ayudas F4   ← aquí registras las nuevas
  transacciones/
    material.js           MM01 MM02 MM03 MM60
    proveedor.js          XK01 XK02 XK03 MKVZ
    pedido.js             ME21N ME22N ME23N ME2N
    migo.js               MIGO (101/102/501/502/551/552)
    stock.js              MMBE MB51
    inventario.js         MI01 MI04 MI03 MI20 MI07
  ui/
    page.js               HTML y estilos de /erp
    cliente.js            "SAP GUI": campo de comandos, teclas, F4, barra de estado, objeto ui
  erp.test.js             tests
src/api/erp.js            API /api/erp/tx/:CODE y /api/erp/f4/:ayuda
```
