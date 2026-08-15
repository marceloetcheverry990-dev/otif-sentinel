# Autenticación Torre de Control — Design

## Overview

La Torre de Control y sus APIs asociadas están hoy completamente sin protección. Este spec agrega autenticación mediante un token de sesión de operador (JWT HS256 firmado con `DASHBOARD_SECRET`) emitido después de un login con credencial compartida de equipo. El fix es quirúrgico: un helper nuevo, un endpoint de login, una página HTML de login, y guardas en los handlers existentes. Ninguna lógica de negocio cambia.

La estrategia es paralela a `autenticacion-chofer` pero con su propio dominio:
- `driver-auth.js` → tokens de chofer, firmados con `JWT_SECRET`, payload `{chofer_id, rut, tenant_id, exp}`
- `operator-auth.js` → tokens de operador, firmados con `DASHBOARD_SECRET`, payload `{role: 'operator', tenant_id, exp}`

Los dos dominios son mutuamente excluyentes por diseño de secretos: un token de chofer no puede pasar la verificación de operador y viceversa, aunque alguien tenga acceso a ambos secrets.

---

## Glossary

- **Token_de_Operador**: JWT HS256 firmado con `DASHBOARD_SECRET`. Payload: `{role: 'operator', tenant_id, exp}`. Expira en 8 horas.
- **DASHBOARD_SECRET**: Binding nuevo de Cloudflare Workers. Mínimo 32 bytes. Exclusivo para `operator-auth.js`.
- **JWT_SECRET**: Binding existente. Exclusivo para `driver-auth.js`. No se toca en este spec.
- **verifyOperatorToken**: Función en `operator-auth.js`. Verifica firma, expiración y `role === 'operator'` de un Token_de_Operador.
- **signOperatorToken**: Función en `operator-auth.js`. Emite un Token_de_Operador.
- **verifyCredentials**: Función interna en `operator-auth.js`. Compara username y password recibidos contra `MONITORING_USERNAME`/`MONITORING_PASSWORD` usando comparación de tiempo constante.

---

## Mecanismo de comparación de tiempo constante (Req 1.5)

Este es el punto técnico más delicado del spec. Las credenciales `MONITORING_USERNAME` y `MONITORING_PASSWORD` son strings de texto plano en el entorno. Compararlos con `===` filtra información sobre la longitud del prefijo correcto a través del tiempo de respuesta.

**Mecanismo elegido: firmar el valor recibido y el valor correcto con la misma clave HMAC, comparar con `crypto.subtle.verify`.**

El flujo para verificar el password (idem para el username):

```
1. key = await crypto.subtle.importKey(
     'raw',
     encode(env.DASHBOARD_SECRET),
     { name: 'HMAC', hash: 'SHA-256' },
     false,
     ['sign', 'verify']
   )

2. mac_correcto = await crypto.subtle.sign(
     { name: 'HMAC' },
     key,
     encode(env.MONITORING_PASSWORD)   // ← el valor correcto como mensaje
   )

3. coincide = await crypto.subtle.verify(
     { name: 'HMAC' },
     key,
     mac_correcto,                      // ← lo que deberíamos recibir
     encode(password_recibido)          // ← lo que llegó en el request
   )
```

`crypto.subtle.verify` en el paso 3 computa internamente `HMAC(key, password_recibido)` y lo compara con `mac_correcto` usando comparación de tiempo constante por diseño del W3C Web Crypto spec. El resultado es `true` si y solo si `password_recibido === env.MONITORING_PASSWORD`, pero sin filtrar cuántos caracteres coinciden.

**Por qué la clave es `DASHBOARD_SECRET` y no efímera:** No importa cuál sea la clave mientras sea la misma para ambas firmas — el secreto que protege las credenciales sigue siendo el valor del password en el entorno, no la clave HMAC. Usar `DASHBOARD_SECRET` como clave evita generar una clave aleatoria por request (que sería correcto también) y es más simple de auditar.

**Caso borde cubierto:** Si `MONITORING_PASSWORD` es una string vacía `""`, el HMAC de `""` es perfectamente computable. No hay riesgo de error al importar una clave de 0 bytes (ese riesgo existía en el enfoque anterior donde el password era la clave).

**Username y password se verifican siempre en paralelo:** Nunca se cortocircuita la verificación con `if (username_ok) { verificar_password }`. Ambas comparaciones se ejecutan siempre, y solo al final se combina el resultado con `&&`, para que el tiempo de respuesta no revele si el username fue correcto.

---

## Architecture

### Módulos nuevos y modificados

```
src/
├── helpers/
│   ├── hmac.js                 ← NUEVO: primitivas HMAC compartidas (importHmacKey, base64url)
│   ├── driver-auth.js          (modificado: reemplaza primitivas internas por imports de hmac.js)
│   └── operator-auth.js        ← NUEVO: signOperatorToken, verifyOperatorToken, verifyCredentials
├── api/
│   ├── operator-login.js       ← NUEVO: handler POST /api/operator/login
│   ├── login-page.js           ← NUEVO: handler GET /login (HTML)
│   ├── dashboard.js            (modificado: renderControlTower + getControlTowerViajesAPI protegidos)
│   ├── gps.js                  (modificado: getLiveFleet protegido)
│   ├── dashboard-executive.js  (modificado: getExecutiveDashboardData protegido)
│   └── dashboard-operational.js (modificado: migra de validateDashboardAccess a verifyOperatorToken)
├── monitoring/
│   ├── auth.js                 ← ELIMINADO: código muerto — único importador migra a verifyOperatorToken
│   ├── dashboard.js            (modificado: getDashboardData + renderDashboard protegidos)
│   ├── dashboard-executive.js  (modificado: renderExecutiveDashboard protegido)
│   └── dashboard-operaciones.js (modificado: renderDashboardOperaciones protegido)
└── index.js                    (modificado: nuevas rutas /login y /api/operator/login)
```

### Flujo completo: login → acceso al panel

```
Navegador                         Worker
    |                                |
    |  GET /login                    |
    | ──────────────────────────────>|
    |                                |  login-page.js: devuelve HTML con formulario
    | <──────────────────────────────|
    |                                |
    |  POST /api/operator/login      |
    |  { username, password }        |
    | ──────────────────────────────>|
    |                                |  operator-login.js:
    |                                |    1. checkRateLimit(ip, 10, 900000)
    |                                |    2. verifyCredentials(username, password, env)
    |                                |       → HMAC tiempo constante
    |                                |    3. signOperatorToken({role:'operator', tenant_id}, env)
    |  { token }                     |
    | <──────────────────────────────|
    |  sessionStorage.setItem(token) |
    |                                |
    |  GET /control-tower            |
    |  Authorization: Bearer <token> |
    | ──────────────────────────────>|
    |                                |  dashboard.js:
    |                                |    1. verifyOperatorToken(request, env)
    |                                |    2. queries DB (sin cambios)
    |                                |    3. renderControlTowerDashboard(...)
    |  HTML del panel                |
    | <──────────────────────────────|
```

### Flujo: token expirado → re-login automático

```
Navegador (JS del panel)          Worker
    |                                |
    |  GET /api/control-tower-viajes |
    |  Authorization: Bearer <token expirado>
    | ──────────────────────────────>|
    |  HTTP 401 { code: "token_expirado" }
    | <──────────────────────────────|
    |                                |
    |  window.location = '/login'    |
    |  (redirect automático)         |
```

---

## Components and Interfaces

### `src/helpers/hmac.js` — nuevo (helper compartido)

Contiene las primitivas HMAC que tanto `operator-auth.js` como `driver-auth.js` necesitan. Extraerlas aquí cumple el Requirement 7.6 y evita que los dos helpers de autenticación de alto nivel diverjan silenciosamente en su implementación criptográfica.

Exports:

```javascript
// Algoritmo compartido
export const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' };

// Importar clave HMAC desde un string de secreto
export async function importHmacKey(secret, usage = ['sign', 'verify'])

// Base64url encode (ArrayBuffer → string)
export function base64urlEncode(buffer)

// Base64url decode (string → Uint8Array)
export function base64urlDecode(str)
```

`operator-auth.js` y `driver-auth.js` importan estas primitivas desde `hmac.js`. Los helpers de alto nivel (`signOperatorToken`, `verifyOperatorToken`, `signDriverToken`, `verifyDriverToken`) permanecen en sus archivos separados — la separación de dominios de token se mantiene. Solo las primitivas criptográficas sin semántica de negocio son compartidas.

**`driver-auth.js` recibe una modificación mínima** en este spec: reemplaza sus funciones `base64urlEncode`, `base64urlDecode` y `getKey` internas por los imports de `hmac.js`. La lógica de negocio de `driver-auth.js` no cambia.

---

### `src/helpers/operator-auth.js` — nuevo

Archivo central del spec. Contiene tres funciones exportadas:

#### `signOperatorToken(payload, env)`

Mismo patrón que `signDriverToken` en `driver-auth.js`, usando `DASHBOARD_SECRET` en lugar de `JWT_SECRET`.

```javascript
// payload esperado: { role: 'operator', tenant_id: string }
// exp: 8 horas = 8 * 60 * 60 = 28800 segundos
export async function signOperatorToken(payload, env)
```

El payload del token incluye `role: 'operator'` como campo explícito. Esto permite que `verifyOperatorToken` rechace tokens con `role` incorrecto sin necesidad de inferir el tipo de token de otra forma.

#### `verifyOperatorToken(request, env)`

Mismo patrón que `verifyDriverToken` en `driver-auth.js`. Verifica:
1. Header `Authorization: Bearer` presente
2. Estructura JWT válida (3 partes separadas por `.`)
3. Firma HMAC-SHA256 válida usando `DASHBOARD_SECRET`
4. `payload.exp` presente y no vencido
5. `payload.role === 'operator'` — si el role es cualquier otra cosa, HTTP 403 (no 401)

Retorna `{ ok: true, payload }` o `{ ok: false, response: Response(401|403) }`.

Código de error `role_incorrecto` (HTTP 403) en lugar de `token_invalido` para distinguir el caso de un token de chofer usado en endpoints de Torre de Control — facilita el debugging.

#### `verifyCredentials(username, password, env)` — función interna (no exportada)

Implementa la comparación de tiempo constante descrita en la sección de mecanismo. No es exportada porque solo la usa `operator-login.js` a través de `loginOperator`.

```javascript
// Retorna: Promise<boolean>
// true si username === MONITORING_USERNAME Y password === MONITORING_PASSWORD
// Las dos verificaciones se ejecutan siempre en paralelo (Promise.all),
// nunca en cortocircuito, para no filtrar si el username fue correcto.
async function verifyCredentials(username, password, env)
```

Pseudocódigo del interior:

```
key = importHmacKey(DASHBOARD_SECRET)  // de hmac.js

[mac_username_correcto, mac_password_correcto] = await Promise.all([
  sign(key, encode(env.MONITORING_USERNAME)),
  sign(key, encode(env.MONITORING_PASSWORD))
])

[username_ok, password_ok] = await Promise.all([
  verify(key, mac_username_correcto, encode(username_recibido)),
  verify(key, mac_password_correcto, encode(password_recibido))
])

return username_ok && password_ok
```

Las cuatro operaciones async (2 sign + 2 verify) se ejecutan en dos rondas de `Promise.all`. El tiempo de respuesta es aproximadamente uniforme independientemente de cuántos caracteres coincidan.

---

### `src/api/operator-login.js` — nuevo

Handler para `POST /api/operator/login`.

```javascript
export async function handleOperatorLogin(request, env)
```

Flujo:
1. Extraer IP del request (`CF-Connecting-IP` → `X-Forwarded-For` → `'unknown'`)
2. `checkRateLimit(ip, '/api/operator/login', 10, 900000)` — si falla, HTTP 429
3. Parsear body JSON `{ username, password }`
4. Validar que ambos campos están presentes — HTTP 400 si faltan
5. Verificar que `MONITORING_USERNAME`, `MONITORING_PASSWORD`, `DASHBOARD_SECRET` y `MONITORING_TENANT_ID` están configurados — HTTP 503 si alguno falta
6. `verifyCredentials(username, password, env)` — si falla, HTTP 401 `{ error: "Credenciales inválidas", code: "credenciales_invalidas" }`
7. `tenant_id = env.MONITORING_TENANT_ID`
8. `signOperatorToken({ role: 'operator', tenant_id }, env)` — HTTP 200 `{ token }`

**Nota sobre `tenant_id` en el token del operador:** El login de operador no recibe `tenant_id` en el request — el operador solo provee username y password. El valor de `tenant_id` en el payload del token se obtiene del binding de entorno `MONITORING_TENANT_ID`. Si este binding no está configurado, el handler rechaza con HTTP 503.

Esto garantiza que en un deployment multi-tenant futuro, el operador del tenant A recibe un token con `tenant_id: 'empresa_a'`, y ese token no puede usarse para acceder a datos del tenant B — tanto porque los secrets de deployment serían distintos como porque el `tenant_id` en el token no coincidiría. El comodín `'*'` fue descartado explícitamente por este motivo.

`MONITORING_TENANT_ID` se agrega a `wrangler.jsonc` con el valor `'empresa_base'` para el deployment actual. Es un binding de texto plano (no secret) porque no es sensible — es el identificador del tenant, no una credencial.

---

### `src/api/login-page.js` — nuevo

Handler para `GET /login`. Devuelve una página HTML autocontenida con:
- Formulario simple: campos username y password, botón de submit
- JavaScript inline que hace `POST /api/operator/login`, guarda el token en `sessionStorage` y redirige a `/control-tower`
- Manejo de error 401 (credenciales incorrectas) con mensaje visible
- Manejo de error 429 (rate limit) con mensaje "Demasiados intentos, esperá N segundos"
- Sin dependencias externas (sin CDNs, sin frameworks)
- CSS mínimo inline para que sea usable

El JavaScript del panel de Torre de Control (en `ui.js`, dentro del `POLLING_EVENTOS_SCRIPT`) recibirá un parche mínimo: cuando cualquier fetch devuelva HTTP 401 con `code: "token_expirado"`, redirigir a `/login`. Esto aplica al menos a `actualizarViajesSilencioso` que corre cada 5 segundos.

---

### Modificaciones en `index.js`

Dos rutas nuevas agregadas antes de las rutas de app móvil:

```javascript
// Login de operador
if (request.method === "GET" && url.pathname === "/login") {
  return handleLoginPage(request, env);
}
if (request.method === "POST" && url.pathname === "/api/operator/login") {
  return handleOperatorLogin(request, env);
}
```

Endpoints existentes protegidos agregando `verifyOperatorToken` como primera operación:

| Endpoint | Archivo | Cambio |
|---|---|---|
| `GET /control-tower` | `api/dashboard.js` → `renderControlTower` | + verifyOperatorToken al inicio |
| `GET /api/control-tower-viajes` | `api/dashboard.js` → `getControlTowerViajesAPI` | + verifyOperatorToken al inicio |
| `GET /dashboard/monitoring` | `monitoring/dashboard.js` → `renderDashboard` | + verifyOperatorToken al inicio |
| `GET /api/dashboard/data` | `monitoring/dashboard.js` → `getDashboardData` | + verifyOperatorToken al inicio |
| `GET /dashboard/executive` | `monitoring/dashboard-executive.js` → `renderExecutiveDashboard` | + verifyOperatorToken al inicio |
| `GET /api/dashboard/executive` | `api/dashboard-executive.js` → `getExecutiveDashboardData` | + verifyOperatorToken al inicio |
| `GET /dashboard/operaciones` | `monitoring/dashboard-operaciones.js` → `renderDashboardOperaciones` | + verifyOperatorToken al inicio |
| `GET /api/dashboard/operational` | `api/dashboard-operational.js` → `getOperationalDashboardData` | elimina import de `auth.js`, agrega import directo de `verifyOperatorToken` desde `operator-auth.js` |
| `GET /api/gps/live` | `api/gps.js` → `getLiveFleet` | + verifyOperatorToken al inicio |

En todos los casos el patrón es idéntico — primeras dos líneas del handler:

```javascript
const auth = await verifyOperatorToken(request, env);
if (!auth.ok) return auth.response;
// ... resto del handler sin cambios
```

### Eliminación de `monitoring/auth.js`

Confirmado por grep: el único importador real de `validateDashboardAccess` y `unauthorizedResponse` en todo el proyecto es `dashboard-operational.js` (líneas 4, 31 y 33). Las demás apariciones son JSDoc dentro del propio `auth.js`.

**Decisión: `monitoring/auth.js` se elimina como parte de este spec.** Una vez que `dashboard-operational.js` migre a `verifyOperatorToken`, el archivo queda sin ningún importador externo. Mantenerlo sería código muerto desde el primer commit. No hay documentación externa que lo referencie ni planes de uso en otro módulo.

`dashboard-operational.js` pasa de:
```javascript
// Antes — importa de auth.js, síncrono, shape {authorized, user, error}
import { validateDashboardAccess, unauthorizedResponse } from '../monitoring/auth.js';
// ...
const auth = validateDashboardAccess(request, env);
if (!auth.authorized) {
  return unauthorizedResponse(auth.error);
}
```

a:
```javascript
// Después — importa de operator-auth.js directamente, async, shape {ok, response}
import { verifyOperatorToken } from '../helpers/operator-auth.js';
// ...
const auth = await verifyOperatorToken(request, env);
if (!auth.ok) return auth.response;
```

---

## Data Models

Este spec no agrega ni modifica tablas de base de datos. Los únicos cambios de datos son:

- **`wrangler.jsonc`**: agrega tres variables de entorno nuevas:
  - `MONITORING_TENANT_ID` (texto plano, valor `'empresa_base'`)
  - `DASHBOARD_SECRET` (secret, mínimo 32 bytes — configurar con `wrangler secret put DASHBOARD_SECRET`)
  - Los bindings `MONITORING_USERNAME` y `MONITORING_PASSWORD` ya existen; se mantienen sin cambio

- **`sessionStorage` del navegador**: el token de operador se guarda bajo la clave `'operator_token'` en el navegador del operador. No hay persistencia del lado del servidor — el worker es stateless.

---

## Correctness Properties

### Property 1: Separación de dominios de token

Para cualquier token válido generado por `signDriverToken` (con `JWT_SECRET`), `verifyOperatorToken` (que usa `DASHBOARD_SECRET`) retorna `{ ok: false }`. Para cualquier token válido generado por `signOperatorToken` (con `DASHBOARD_SECRET`), `verifyDriverToken` (que usa `JWT_SECRET`) retorna `{ ok: false }`.

**Validates: Requirements 7.5**

### Property 2: Tiempo constante en verificación de credenciales

Para cualquier combinación de (username_recibido, password_recibido), `verifyCredentials` siempre ejecuta exactamente las mismas operaciones criptográficas y el tiempo de respuesta no revela información sobre cuántos caracteres coinciden.

**Validates: Requirements 1.5**

### Property 3: Rate limit antes de verificación de credenciales

Para cualquier IP que haya superado 10 requests en 15 minutos, el handler retorna HTTP 429 antes de llegar a `verifyCredentials` — incluso si las credenciales serían correctas.

**Validates: Requirements 8.3**

### Property 4: Preservación del comportamiento post-auth

Para cualquier request con Token_de_Operador válido a cualquier endpoint protegido, la respuesta es idéntica a la respuesta actual del endpoint sin autenticación.

**Validates: Requirements 9.1–9.6**

---

## Error Handling

| Condición | Endpoint | Respuesta |
|---|---|---|
| Sin header Authorization | Cualquier endpoint protegido | HTTP 401 `{ code: "token_ausente" }` + `WWW-Authenticate` |
| Token expirado | Cualquier endpoint protegido | HTTP 401 `{ code: "token_expirado" }` |
| Firma inválida / formato incorrecto | Cualquier endpoint protegido | HTTP 401 `{ code: "token_invalido" }` |
| `role !== 'operator'` en el token | Cualquier endpoint protegido | HTTP 403 `{ code: "role_incorrecto" }` |
| Credenciales incorrectas | POST /api/operator/login | HTTP 401 `{ code: "credenciales_invalidas" }` — sin revelar cuál campo |
| Rate limit excedido | POST /api/operator/login | HTTP 429 `{ code: "rate_limit_excedido", retry_after_seconds: N }` |
| `MONITORING_USERNAME`/`PASSWORD` no configurados | POST /api/operator/login | HTTP 503 `{ error: "Servicio no configurado" }` |
| `MONITORING_TENANT_ID` no configurado | POST /api/operator/login | HTTP 503 `{ error: "Servicio no configurado" }` |
| `DASHBOARD_SECRET` ausente o < 32 bytes | Cualquier función de operator-auth | Error en tiempo de ejecución con log `[operator-auth]` — igual que driver-auth.js |

---

## Testing Strategy

El testing sigue la misma estructura de dos fases que `autenticacion-chofer`: primero tests unitarios del helper criptográfico y del handler de login, luego tests de preservación para los nueve endpoints protegidos.

### Tests del helper `operator-auth.js` y `hmac.js`

**Archivo:** `src/helpers/operator-auth.test.js`

**Casos requeridos:**

1. **Estructura del token:** `signOperatorToken({ role: 'operator', tenant_id: 'empresa_base' }, env)` retorna un string con exactamente 3 partes separadas por `.`

2. **Round-trip correcto:** `verifyOperatorToken` aplicado sobre el token generado por `signOperatorToken` con el mismo `DASHBOARD_SECRET` retorna `{ ok: true }` y el payload incluye `role`, `tenant_id`, `exp`

3. **Rechazo con secreto distinto:** `verifyOperatorToken` con un `env` que tiene un `DASHBOARD_SECRET` diferente al usado para firmar retorna `{ ok: false }` con código `token_invalido`

4. **Token expirado:** token generado con `exp` en el pasado retorna `{ ok: false }` con código `token_expirado`

5. **Token sin `exp`:** token válido en firma pero sin campo `exp` retorna `{ ok: false }` con código `token_invalido` — mismo bug que encontramos y corregimos en `driver-auth.js`

6. **Role incorrecto:** token con `role: 'chofer'` en el payload retorna `{ ok: false, response: HTTP 403 }` con código `role_incorrecto` — no 401

7. **Token de chofer rechazado:** token generado por `signDriverToken` con `JWT_SECRET` retorna `{ ok: false }` cuando se verifica con `verifyOperatorToken` (que usa `DASHBOARD_SECRET`)

### Tests de `verifyCredentials` — foco en ausencia de cortocircuito

**La pregunta clave:** ¿`verifyCredentials` ejecuta siempre las dos comparaciones HMAC, incluso cuando el username es incorrecto?

No podemos medir el tiempo de respuesta en un test de Vitest con suficiente precisión para detectar timing differences de microsegundos. Lo que sí podemos verificar es la estructura de ejecución mediante mocking:

```javascript
// Test: ambas ramas HMAC se ejecutan siempre
it('verifyCredentials ejecuta verify para username Y password siempre', async () => {
  const verifySpy = vi.spyOn(crypto.subtle, 'verify');

  // Username correcto, password incorrecto
  await verifyCredentials('admin', 'wrong_password', env);
  expect(verifySpy).toHaveBeenCalledTimes(2); // una vez para username, una para password

  verifySpy.mockClear();

  // Username incorrecto, password correcto
  await verifyCredentials('wrong_user', 'correct_password', env);
  expect(verifySpy).toHaveBeenCalledTimes(2); // idem — no cortocircuita

  verifySpy.mockClear();

  // Ambos incorrectos
  await verifyCredentials('wrong_user', 'wrong_password', env);
  expect(verifySpy).toHaveBeenCalledTimes(2); // idem
});
```

Esto verifica que `Promise.all` efectivamente lanza las dos comparaciones y no hay un `if` de cortocircuito entre ellas.

**Casos adicionales de `verifyCredentials`:**

8. **Credenciales correctas:** retorna `true`
9. **Username correcto, password incorrecto:** retorna `false`, y `crypto.subtle.verify` fue llamado exactamente 2 veces
10. **Username incorrecto, password correcto:** retorna `false`, y `crypto.subtle.verify` fue llamado exactamente 2 veces
11. **Ambos incorrectos:** retorna `false`, y `crypto.subtle.verify` fue llamado exactamente 2 veces
12. **Password vacío `""`:** retorna `false` sin lanzar excepción — el HMAC de `""` es computable

### Tests del handler `operator-login.js`

**Archivo:** `src/api/operator-login.test.js`

13. **Rate limit aplicado antes de credenciales:** si la IP superó 10 intentos, retorna HTTP 429 sin llamar a `verifyCredentials`
14. **Campos faltantes:** body sin `username` o sin `password` retorna HTTP 400
15. **`MONITORING_USERNAME` no configurado:** retorna HTTP 503 sin llamar a `verifyCredentials`
16. **Credenciales inválidas:** retorna HTTP 401 `{ code: "credenciales_invalidas" }` sin revelar cuál campo falló
17. **Login exitoso:** retorna HTTP 200 con `{ token }`, el token tiene 3 partes y verifica con `DASHBOARD_SECRET`
18. **`MONITORING_TENANT_ID` en el payload del token:** el token generado en login exitoso contiene `tenant_id === env.MONITORING_TENANT_ID`

### Tests de preservación — los nueve endpoints

**Propósito:** verificar que agregar la guarda de dos líneas no cambia nada en el camino feliz.

**Patrón para cada endpoint:**

```javascript
// Para cada uno de los 9 endpoints protegidos:
it('[endpoint] con token válido devuelve la misma respuesta que antes', async () => {
  const token = await signOperatorToken(
    { role: 'operator', tenant_id: 'empresa_base' },
    TEST_ENV
  );
  const request = makeGetRequest('/control-tower', token);

  const response = await renderControlTower(request, TEST_ENV, mockCtx);

  expect(response.status).toBe(200); // mismo status que sin auth
  // Para endpoints HTML: response.headers.get('Content-Type') incluye 'text/html'
  // Para endpoints JSON: body parseable como JSON con las mismas claves
});

it('[endpoint] sin token devuelve 401', async () => {
  const request = makeGetRequest('/control-tower', null); // sin token
  const response = await renderControlTower(request, TEST_ENV, mockCtx);
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body.code).toBe('token_ausente');
});

it('[endpoint] con token de chofer devuelve 403', async () => {
  const tokenChofer = await signDriverToken(
    { chofer_id: 'c-001', rut: '12345678-9', tenant_id: 'empresa_base' },
    { JWT_SECRET: TEST_ENV.JWT_SECRET }
  );
  const request = makeGetRequest('/control-tower', tokenChofer);
  const response = await renderControlTower(request, TEST_ENV, mockCtx);
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.code).toBe('role_incorrecto');
});
```

Los nueve endpoints cubiertos: `/control-tower`, `/api/control-tower-viajes`, `/dashboard/monitoring`, `/api/dashboard/data`, `/dashboard/executive`, `/api/dashboard/executive`, `/dashboard/operaciones`, `/api/dashboard/operational`, `/api/gps/live`.

### Tests del helper `hmac.js`

19. **Round-trip base64url:** `base64urlDecode(base64urlEncode(buffer))` produce bytes idénticos al input original
20. **`importHmacKey` con secreto < 32 bytes:** lanza error (validación de mínimo de bytes)
21. **Consistencia entre módulos:** firmar el mismo mensaje con la misma clave desde `operator-auth.js` y desde `driver-auth.js` (ambos importando de `hmac.js`) produce el mismo HMAC — confirma que comparten la misma implementación y no divergieron

---

## Trade-offs y decisiones explícitas

**`tenant_id: '*'` eliminado del diseño:** El comodín fue descartado. El token del operador lleva el `tenant_id` real del entorno, obtenido de `MONITORING_TENANT_ID`. Esto garantiza que el modelo multi-tenant sea correcto desde el primer día, sin deuda técnica.

**`operator-auth.js` no importa de `driver-auth.js`:** Ambos helpers importan las primitivas criptográficas desde `hmac.js` (Req 7.6). La separación de alto nivel se mantiene — `signOperatorToken`/`verifyOperatorToken` y `signDriverToken`/`verifyDriverToken` son funciones completamente distintas en archivos distintos. Lo que comparten son solo las primitivas sin semántica de negocio: `importHmacKey`, `base64urlEncode`, `base64urlDecode`.

**`monitoring/auth.js` eliminado:** Confirmado por grep que `dashboard-operational.js` era su único importador real. Una vez que ese archivo migra a `verifyOperatorToken` directamente, `auth.js` queda sin importadores y se elimina. No se mantiene como wrapper — eso sería código muerto documentado.

**Expiración de 8 horas:** Cubre un turno operativo completo sin forzar re-login. El token se guarda en `sessionStorage` — cierra la pestaña y el token desaparece, lo que es el comportamiento correcto para equipos compartidos.
