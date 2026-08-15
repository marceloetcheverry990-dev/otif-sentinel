# Implementation Plan: Autenticación Torre de Control

## Overview

Implementa autenticación para la Torre de Control y sus APIs en seis waves. La secuencia está diseñada para nunca dejar el sistema en un estado inconsistente:

1. **Wave 1** — Crear el helper criptográfico compartido (`hmac.js`) y el helper de operador (`operator-auth.js`) con smoke tests. Gate: tests en verde antes de tocar cualquier endpoint.
2. **Wave 2** — Migrar `driver-auth.js` para usar `hmac.js`. Gate: toda la suite de autenticacion-chofer en verde antes de avanzar. Este wave protege el trabajo ya desplegado.
3. **Wave 3** — Login de operador (`operator-login.js`) y página HTML (`login-page.js`). Genuinamente paralelas entre sí.
4. **Wave 4** — Tests de `operator-login.js` y `hmac.js`. Dependen de Wave 3 (T4.1 necesita `operator-login.js`) y de Wave 2 (T5.1 necesita `driver-auth.js` migrado para el test de consistencia cruzada).
5. **Wave 5** — Proteger los nueve endpoints (en paralelo entre sí), tests adicionales de `operator-auth.js`, configuración de entorno, y eliminación atómica de `auth.js`.
6. **Wave 6** — Tests de preservación completos, re-login automático en UI, commits de código y specs con hashes.

---

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["T1", "T2"],
      "description": "Helper criptográfico + smoke tests — gate obligatorio antes de Wave 2"
    },
    {
      "wave": 2,
      "tasks": ["T3"],
      "description": "Migrar driver-auth.js a hmac.js + regresión completa de autenticacion-chofer"
    },
    {
      "wave": 3,
      "tasks": ["T4", "T5"],
      "description": "Login de operador y página HTML — genuinamente paralelas entre sí"
    },
    {
      "wave": 4,
      "tasks": ["T4.1", "T5.1"],
      "description": "Tests de operator-login.js (depende de T4) y hmac.js (depende de T3 para test de consistencia cruzada)"
    },
    {
      "wave": 5,
      "tasks": ["T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14", "T15"],
      "description": "Nueve endpoints protegidos (paralelo) + tests adicionales + eliminación atómica de auth.js"
    },
    {
      "wave": 6,
      "tasks": ["T16"],
      "description": "Tests de preservación, re-login automático en UI, commits de cierre"
    }
  ]
}
```

---

## Tasks

### Wave 1 — Helper criptográfico (gate obligatorio)

- [ ] **T1. Crear `src/helpers/hmac.js`**

  Crear el archivo con las primitivas HMAC compartidas:

  ```javascript
  export const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' };

  export async function importHmacKey(secret, usage = ['sign', 'verify']) {
    // crypto.subtle.importKey('raw', encode(secret), HMAC_ALGO, false, usage)
    // Validar que secret tiene al menos 32 bytes; lanzar error con [hmac] prefix si no
  }

  export function base64urlEncode(buffer) { ... }

  export function base64urlDecode(str) { ... }
  ```

  Reglas:
  - `importHmacKey` valida que el secreto tenga ≥ 32 bytes antes de importar. Si no, lanza `Error('[hmac] Secret must be at least 32 bytes')`
  - `base64urlEncode` y `base64urlDecode` son las mismas funciones que hoy están en `driver-auth.js` — copiar la implementación exacta, no reescribir

  **Validates:** Req 7.6

- [ ] **T2. Crear `src/helpers/operator-auth.js` y smoke tests**

  Crear `operator-auth.js` con `signOperatorToken`, `verifyOperatorToken` y `verifyCredentials` (interna).

  **`signOperatorToken(payload, env)`:**
  - Validar que `env.DASHBOARD_SECRET` existe y tiene ≥ 32 bytes (mismo patrón que `driver-auth.js` con `JWT_SECRET`)
  - `JWT_EXPIRY_SECONDS = 8 * 60 * 60` (8 horas)
  - Mismo algoritmo de construcción JWT que `driver-auth.js`, usando `importHmacKey` de `hmac.js`

  **`verifyOperatorToken(request, env)`:**
  - Mismo patrón que `verifyDriverToken`
  - Verificar firma con `DASHBOARD_SECRET`
  - Verificar `payload.exp` presente y no vencido
  - Verificar `payload.role === 'operator'` — si el role es incorrecto retornar `{ ok: false, response: HTTP 403 { code: 'role_incorrecto' } }`
  - Retornar `{ ok: true, payload }` o `{ ok: false, response: Response(401|403) }`

  **`verifyCredentials(username, password, env)` — función interna, NO exportada:**
  - Implementar comparación de tiempo constante usando `Promise.all` para username y password simultáneamente
  - Ver pseudocódigo exacto en design.md sección "Mecanismo de comparación de tiempo constante"
  - Nunca cortocircuitar entre username y password

  **Crear `src/helpers/operator-auth.test.js`** con los smoke tests mínimos de Wave 1:

  1. `signOperatorToken` genera token con exactamente 3 partes separadas por `.`
  2. `verifyOperatorToken` sobre el token generado con el mismo `DASHBOARD_SECRET` retorna `{ ok: true }` con `role === 'operator'` y `tenant_id` en el payload
  3. `verifyOperatorToken` con `DASHBOARD_SECRET` diferente retorna `{ ok: false }` con código `token_invalido`

  **Criterio de completitud de Wave 1:** `vitest --run src/helpers/operator-auth.test.js` pasa sin errores. Si falla, NO avanzar a Wave 2.

  **Validates:** Req 1.4, 1.7, 2.3–2.5, 7.1–7.5

---

### Wave 2 — Migración de driver-auth.js (gate de regresión)

- [ ] **T3. Migrar `driver-auth.js` para usar primitivas de `hmac.js`**

  **Cambio quirúrgico:** reemplazar las funciones `base64urlEncode`, `base64urlDecode` y `getKey` definidas localmente en `driver-auth.js` por imports de `hmac.js`:

  ```javascript
  // Antes (en driver-auth.js):
  const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
  function base64urlEncode(buffer) { ... }
  function base64urlDecode(str) { ... }
  async function getKey(secret) { ... }

  // Después:
  import { HMAC_ALGO, importHmacKey, base64urlEncode, base64urlDecode } from './hmac.js';
  // Reemplazar todas las referencias a ALGORITHM por HMAC_ALGO
  // Reemplazar todas las llamadas a getKey(secret) por importHmacKey(secret)
  ```

  La lógica de negocio de `driver-auth.js` (`signDriverToken`, `verifyDriverToken`, validación de secreto) **no cambia ni una línea**.

  **Test de regresión obligatorio:** ejecutar toda la suite de autenticacion-chofer:
  ```
  vitest --run src/helpers/driver-auth.test.js
  vitest --run src/api/handlers-smoke.test.js
  vitest --run src/api/bug-condition.test.js
  vitest --run src/api/fix-checking.test.js
  ```

  **Criterio de completitud de Wave 2:** los cuatro archivos de test pasan sin errores. Si alguno falla, revertir el cambio en `driver-auth.js` antes de investigar — no dejar el archivo en estado inconsistente.

  **Por qué es Wave 2 separada:** `driver-auth.js` ya está en producción protegiendo choferes reales. Tocar ese archivo requiere su propia verificación de regresión aislada antes de avanzar.

  **Validates:** Req 7.6 (y regresión de spec autenticacion-chofer completa)

---

### Wave 3 — Login de operador y página HTML

T4 y T5 son genuinamente paralelas entre sí: no tienen dependencias cruzadas.

- [ ] **T4. Crear `src/api/operator-login.js` y registrar ruta en `index.js`**

  Implementar `handleOperatorLogin(request, env)` con el flujo exacto del design.md:

  1. Extraer IP: `CF-Connecting-IP` → `X-Forwarded-For` → `'unknown'`
  2. `checkRateLimit(ip, '/api/operator/login', 10, 900000)` — importar de `src/monitoring/rate-limiter.js`
  3. Parsear body JSON `{ username, password }` — HTTP 400 si faltan campos
  4. Verificar que `MONITORING_USERNAME`, `MONITORING_PASSWORD`, `DASHBOARD_SECRET`, `MONITORING_TENANT_ID` están configurados — HTTP 503 si alguno falta
  5. `await verifyCredentials(username, password, env)` — HTTP 401 `{ code: 'credenciales_invalidas' }` si falla
  6. `await signOperatorToken({ role: 'operator', tenant_id: env.MONITORING_TENANT_ID }, env)`
  7. HTTP 200 `{ token }`

  En `index.js`, agregar antes de las rutas de app móvil:
  ```javascript
  import { handleOperatorLogin } from './api/operator-login.js';
  // ...
  if (request.method === "POST" && url.pathname === "/api/operator/login") {
    return handleOperatorLogin(request, env);
  }
  ```

  **Validates:** Req 1.1–1.8, 8.1–8.8

- [ ] **T5. Crear `src/api/login-page.js` y registrar ruta en `index.js`**

  Implementar `handleLoginPage(request, env)` que retorna HTML autocontenido con:
  - Formulario con campos `username` y `password`
  - JavaScript inline que hace `POST /api/operator/login`, guarda el token en `sessionStorage` bajo la clave `'operator_token'`, y redirige a `/control-tower`
  - Manejo de HTTP 401 con mensaje "Credenciales incorrectas"
  - Manejo de HTTP 429 con mensaje "Demasiados intentos, esperá N segundos"
  - Sin CDNs ni dependencias externas
  - CSS mínimo inline (formulario centrado, usable en cualquier navegador)

  En `index.js`:
  ```javascript
  import { handleLoginPage } from './api/login-page.js';
  // ...
  if (request.method === "GET" && url.pathname === "/login") {
    return handleLoginPage(request, env);
  }
  ```

  **Validates:** Req 6.1–6.5

---

### Wave 4 — Tests de operator-login.js y hmac.js

T4.1 depende de T4 (necesita que `operator-login.js` exista para importarlo).
T5.1 depende de T3 (el test 21 de consistencia cruzada necesita `driver-auth.js` ya migrado).
Ambas satisfacen esas dependencias al llegar a Wave 4, por lo que pueden ejecutarse en paralelo entre sí.

- [ ] **T4.1. Crear `src/api/operator-login.test.js`**

  Tests 13–18 del design.md (sección Testing Strategy — "Tests del handler `operator-login.js`"):

  13. **Rate limit antes de credenciales:** mockear `checkRateLimit` para que devuelva `allowed: false` → el handler retorna HTTP 429 sin llegar a llamar a `verifyCredentials`
  14. **Campos faltantes:** body `{}`, body `{ username: 'admin' }` sin password, body `{ password: 'x' }` sin username → todos retornan HTTP 400
  15. **`MONITORING_USERNAME` no configurado:** env sin ese binding → retorna HTTP 503 sin llamar a `verifyCredentials`
  16. **`MONITORING_TENANT_ID` no configurado:** env sin ese binding → retorna HTTP 503
  17. **Credenciales inválidas:** credenciales incorrectas → retorna HTTP 401 `{ code: 'credenciales_invalidas' }` sin revelar cuál campo falló
  18. **Login exitoso:** credenciales correctas → retorna HTTP 200 con `{ token }`, el token tiene 3 partes, verifica con `DASHBOARD_SECRET`, y `payload.tenant_id === env.MONITORING_TENANT_ID`

  Mockear `verifyCredentials` donde sea necesario para aislar el handler del comportamiento criptográfico.

  **Validates:** Req 1.1–1.8, 8.1–8.8

- [ ] **T5.1. Crear `src/helpers/hmac.test.js`**

  Tests 19–21 del design.md (sección Testing Strategy — "Tests del helper `hmac.js`"):

  19. **Round-trip base64url:** `base64urlDecode(base64urlEncode(buffer))` produce bytes idénticos al input original, para varios buffers de longitud variable (0 bytes, 1 byte, 32 bytes, 64 bytes)

  20. **`importHmacKey` con secreto < 32 bytes:** pasar un string de 31 bytes lanza error con prefijo `[hmac]`. Pasar un string vacío `""` también lanza error. Pasar exactamente 32 bytes no lanza error.

  21. **Consistencia cruzada entre módulos:** firmar el mismo mensaje con la misma clave invocando `importHmacKey` dos veces (simulando un llamador desde `operator-auth.js` y otro desde `driver-auth.js`) produce HMACs idénticos. Este test confirma que la función compartida no produce resultados distintos según quién la llama.

  **Validates:** Req 7.6

---

### Wave 5 — Nueve endpoints protegidos + eliminación atómica de auth.js

Las tareas T6–T14 pueden ejecutarse en paralelo entre sí. T15 es atómica y va separada.

En todos los casos el patrón de protección es idéntico — agregar estas dos líneas al inicio del handler, antes de cualquier otra operación:

```javascript
import { verifyOperatorToken } from '../helpers/operator-auth.js';
// ...
const auth = await verifyOperatorToken(request, env);
if (!auth.ok) return auth.response;
```

- [ ] **T6. Proteger `GET /control-tower` — `renderControlTower` en `api/dashboard.js`**

  Importar `verifyOperatorToken`. Agregar guarda como primera operación del handler, antes del `withDb`.

  **Validates:** Req 2.1–2.6

- [ ] **T7. Proteger `GET /api/control-tower-viajes` — `getControlTowerViajesAPI` en `api/dashboard.js`**

  Importar `verifyOperatorToken` (ya importado si T6 se ejecutó antes). Agregar guarda antes del `requireTenantId`.

  **Validates:** Req 3.1

- [ ] **T8. Proteger `GET /dashboard/monitoring` y `GET /api/dashboard/data` — `renderDashboard` y `getDashboardData` en `monitoring/dashboard.js`**

  Un solo import de `verifyOperatorToken` cubre ambas funciones. Agregar guarda al inicio de cada una.

  **Validates:** Req 4.1, 3.3

- [ ] **T9. Proteger `GET /dashboard/executive` — `renderExecutiveDashboard` en `monitoring/dashboard-executive.js`**

  Importar `verifyOperatorToken`. Agregar guarda al inicio del handler HTML.

  **Validates:** Req 4.2

- [ ] **T10. Proteger `GET /api/dashboard/executive` — `getExecutiveDashboardData` en `api/dashboard-executive.js`**

  Importar `verifyOperatorToken`. Agregar guarda antes del `withDb`.

  **Validates:** Req 3.2

- [ ] **T11. Proteger `GET /dashboard/operaciones` — `renderDashboardOperaciones` en `monitoring/dashboard-operaciones.js`**

  Importar `verifyOperatorToken`. Agregar guarda al inicio del handler HTML.

  **Validates:** Req 4.3

- [ ] **T12. Proteger `GET /api/gps/live` — `getLiveFleet` en `api/gps.js`**

  Importar `verifyOperatorToken`. Agregar guarda antes del `requireTenantId` — la autenticación va primero, luego la validación de tenant.

  **Validates:** Req 5.1–5.5

- [ ] **T13. Agregar `MONITORING_TENANT_ID` y documentar `DASHBOARD_SECRET` en `wrangler.jsonc`**

  En la sección `vars` de `wrangler.jsonc`:
  ```jsonc
  "MONITORING_TENANT_ID": "empresa_base"
  ```

  En los comentarios de variables pendientes de configurar como secrets:
  ```
  // DASHBOARD_SECRET: configurar con `wrangler secret put DASHBOARD_SECRET`
  // Generar con: openssl rand -base64 32
  ```

  `DASHBOARD_SECRET` va como Cloudflare Secret (no texto plano en `vars`) — no escribirlo en `wrangler.jsonc`, solo documentar el comando para configurarlo.

  **Validates:** Req 1.7, 7.7

- [ ] **T14. Agregar tests adicionales de `operator-auth.js` (wave 5)**

  Extender `src/helpers/operator-auth.test.js` con los casos del design.md sección Testing Strategy:

  - Token expirado → `{ ok: false, code: 'token_expirado' }`
  - Token sin campo `exp` → `{ ok: false, code: 'token_invalido' }`
  - Token con `role: 'chofer'` → `{ ok: false, response: HTTP 403, code: 'role_incorrecto' }`
  - Token de chofer (firmado con `JWT_SECRET`) verificado con `verifyOperatorToken` → `{ ok: false }`
  - `verifyCredentials` con username correcto y password incorrecto: retorna `false` y `crypto.subtle.verify` fue llamado exactamente 2 veces (sin cortocircuito)
  - `verifyCredentials` con username incorrecto y password correcto: retorna `false` y `crypto.subtle.verify` fue llamado exactamente 2 veces
  - `verifyCredentials` con credenciales correctas: retorna `true`
  - `verifyCredentials` con password vacío `""`: retorna `false` sin lanzar excepción

  **Validates:** Req 1.5, 2.3–2.5, 7.5

- [ ] **T15. Eliminar `monitoring/auth.js` y migrar `dashboard-operational.js` — tarea atómica**

  Esta tarea crea un commit único que hace ambos cambios simultáneamente. No puede haber un commit intermedio donde `auth.js` no existe pero `dashboard-operational.js` todavía lo importa.

  **Paso A:** En `dashboard-operational.js`, reemplazar:
  ```javascript
  import { validateDashboardAccess, unauthorizedResponse } from '../monitoring/auth.js';
  ```
  por:
  ```javascript
  import { verifyOperatorToken } from '../helpers/operator-auth.js';
  ```

  Y reemplazar:
  ```javascript
  const auth = validateDashboardAccess(request, env);
  if (!auth.authorized) {
    return unauthorizedResponse(auth.error);
  }
  ```
  por:
  ```javascript
  const auth = await verifyOperatorToken(request, env);
  if (!auth.ok) return auth.response;
  ```

  Agregar `async` a la función `getOperationalDashboardData` si no lo tiene ya.

  **Paso B:** Eliminar `src/monitoring/auth.js`.

  **Verificar antes de commitear:** `grep -r "monitoring/auth" src/` debe retornar 0 resultados.

  **Validates:** Req 3.4, 9.4

---

### Wave 6 — Tests de preservación, re-login automático y cierre

- [ ] **T16. Tests de preservación, parche de re-login en UI y commits de cierre**

  **T16.1 — Tests de preservación de los nueve endpoints**

  Crear `src/api/operator-auth-preservation.test.js` con los tests del design.md sección "Tests de preservación":

  Para cada uno de los nueve endpoints:
  - Con `Token_de_Operador` válido → mismo status y mismo formato de respuesta que hoy
  - Sin token → HTTP 401 `{ code: 'token_ausente' }`
  - Con token de chofer (firmado con `JWT_SECRET`) → HTTP 403 `{ code: 'role_incorrecto' }`

  Ejecutar: `vitest --run src/api/operator-auth-preservation.test.js`

  **T16.2 — Parche de re-login automático en `POLLING_EVENTOS_SCRIPT`**

  En `src/ui/client/pollingYEventos.js`, dentro de `actualizarViajesSilencioso`, agregar manejo del HTTP 401 con `code: 'token_expirado'`:

  ```javascript
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.code === 'token_expirado') {
      window.location.href = '/login';
      return;
    }
  }
  ```

  Ejecutar snapshot test: `vitest --run --config vitest.config.ui.js src/ui.test.js` para confirmar que el parche no rompió el output HTML del panel.

  **T16.3 — Actualizar `docs/deployment-guide.md`**

  En la sección "Fase 2 — Deployment del worker", agregar:
  ```
  npx wrangler secret put DASHBOARD_SECRET
  # Generar con: openssl rand -base64 32
  ```
  Y en la sección de Variables, documentar `MONITORING_TENANT_ID` como variable requerida con su valor por defecto `'empresa_base'`.

  **T16.4 — Commits de cierre**

  Commit de código:
  ```
  feat(auth): autenticacion-torre-control — protección completa de Torre de Control y APIs operativas
  ```

  Commit de specs:
  ```
  docs(specs): autenticacion-torre-control — requirements, design y tasks completos
  ```

  Registrar ambos hashes en este archivo:

  | Commit | Hash | Descripción |
  |--------|------|-------------|
  | Código | _pendiente_ | feat(auth): autenticacion-torre-control |
  | Specs  | _pendiente_ | docs(specs): autenticacion-torre-control |

  **Validates:** Req 9.1–9.6, 6.3

---

## Notes

- **Gate de Wave 1:** `operator-auth.test.js` (smoke tests T2) debe pasar antes de empezar T3. Sin excepción.
- **Gate de Wave 2:** los cuatro archivos de test de autenticacion-chofer deben pasar antes de empezar Wave 3. Sin excepción. Si `driver-auth.js` se modificó y algún test falla, revertir antes de investigar.
- **Wave 3 es genuinamente paralela:** T4 y T5 no tienen dependencias cruzadas entre sí.
- **Wave 4 también es paralela entre sí:** T4.1 y T5.1 pueden ejecutarse simultáneamente porque sus dependencias distintas (T4 y T3 respectivamente) ya están satisfechas al llegar a Wave 4.
- **T15 es atómica:** eliminar `auth.js` y migrar `dashboard-operational.js` en el mismo commit. Verificar con `grep -r "monitoring/auth" src/` que no quedan referencias antes de commitear.
- **`DASHBOARD_SECRET` nunca en `wrangler.jsonc`:** va exclusivamente como Cloudflare Secret. Documentar el comando, no el valor.
- **`MONITORING_TENANT_ID` sí en `wrangler.jsonc`:** es el identificador del tenant, no una credencial.
- **Los endpoints de app móvil de chofer no se tocan en ninguna wave:** `verifyDriverToken`, `signDriverToken` y los seis endpoints de autenticacion-chofer son out of scope excepto por la refactorización quirúrgica de T3.
