# Autenticación Chofer — Bugfix Design

## Overview

El sistema de autenticación de la app móvil del chofer tiene dos fallas críticas de seguridad y un conjunto de endpoints sin protección alguna. El endpoint `POST /api/choferes/activate` genera un token fake (`jwt_simulado_${Date.now()}`), `POST /api/choferes/login` no emite ningún token, y los seis endpoints operativos posteriores aceptan `tenant_id` + `rut` como única "credencial" — ambos datos públicos o predecibles.

La estrategia del fix es minimal y quirúrgica:

1. Crear un helper `signDriverToken(payload, env)` usando la **Web Crypto API** (nativa en Cloudflare Workers, sin dependencias externas) que emite JWTs HS256 reales firmados con `env.JWT_SECRET`.
2. Crear un middleware `verifyDriverToken(request, env)` reutilizable que verifica la firma, expiration y devuelve el payload del token o lanza 401/403.
3. Hacer que `activate` y `login` usen `signDriverToken` para emitir tokens reales.
4. Proteger los cinco endpoints de app móvil afectados con `verifyDriverToken` al inicio de cada handler.
5. En los endpoints que operan sobre recursos específicos del chofer (`/rutas`, `/evento`, `/sync`), añadir validación de autoría cruzando el `rut` o `chofer_id` del token contra el recurso solicitado.

**Fuera del alcance de este bugfix:** `GET /api/gps/live` (`getLiveFleet`) no es un endpoint de app móvil — expone la posición agregada de toda la flota y pertenece al modelo de autorización de Torre de Control. Su protección se trata en el spec separado `autenticacion-torre-control`.

Este fix no modifica ninguna lógica de negocio existente — solo añade la capa de autenticación que faltaba.

---

## Glossary

- **Bug_Condition (C)**: La condición que activa el bug — cualquier request que llegue a un endpoint protegido del chofer sin un JWT real firmado con `env.JWT_SECRET`, incluyendo requests con el token fake `jwt_simulado_*` o sin token.
- **Property (P)**: El comportamiento correcto esperado — el sistema debe rechazar con HTTP 401/403 todo request que no porte un JWT válido, y los endpoints que emiten tokens deben emitir JWTs firmados criptográficamente.
- **Preservation**: El comportamiento funcional existente que no debe cambiar — validación de credenciales (`rut` + `pin`), lógica de negocio de GPS, eventos operativos, ciclo de vida del viaje, multi-tenant isolation.
- **verifyDriverToken**: Función helper a crear en `src/helpers/driver-auth.js` que verifica la firma del JWT en el header `Authorization: Bearer <token>` usando `crypto.subtle.verify()` (tiempo constante por diseño del W3C Web Crypto spec).
- **signDriverToken**: Función helper a crear en `src/helpers/driver-auth.js` que genera un JWT HS256 firmado con `env.JWT_SECRET` y expiration de 10 horas (cubre turno estándar de 8h más hasta ~1.5h de extensión operativa realista — descarga en destino, cierre de viaje, problemas en ruta).
- **isBugCondition**: Función formal que identifica los inputs que activan el bug (ver sección Bug Details).
- **Web Crypto API**: API nativa del runtime V8/Cloudflare Workers para operaciones criptográficas — `crypto.subtle.importKey`, `crypto.subtle.sign`, `crypto.subtle.verify`. No requiere librerías externas.
- **HS256**: HMAC-SHA256 — algoritmo simétrico de firma JWT donde el mismo secreto firma y verifica.
- **Token expirado — re-login manual**: Cuando cualquier endpoint devuelve HTTP 401 con `code: "token_expirado"`, la app muestra la pantalla de login para que el chofer reingrese el PIN. El PIN no se persiste en el dispositivo (solo `token`, `rut` y `tenantId` quedan en `expo-secure-store`), por lo que no hay refresh automático posible.

---

## Bug Details

### Bug Condition

El bug se activa en dos escenarios distintos pero relacionados:

**Escenario A — Emisión falsa o nula de tokens:** Los endpoints de autenticación no emiten JWTs válidos. `activate` emite un token fake sin firma; `login` no emite ningún token.

**Escenario B — Ausencia de verificación:** Los cuatro endpoints operativos de app móvil del chofer no verifican ningún token antes de procesar el request, aceptando cualquier `tenant_id` + `rut` como credencial suficiente.

**Nota:** `GET /api/gps/live` (`getLiveFleet`) NO está incluido en este escenario. No es un endpoint de app móvil — expone la posición en tiempo real de toda la flota del tenant y su audiencia es la Torre de Control (operadores logísticos), no choferes individuales. Su modelo de autorización es distinto y se trata en el spec `autenticacion-torre-control`. Ver sección "Endpoints fuera de alcance" al final de este documento.

**Formal Specification:**

```
FUNCTION isBugCondition(request, endpoint)
  INPUT:  request  — HTTP request con headers y body
          endpoint — identificador del endpoint destino
  OUTPUT: boolean

  // Escenario A: endpoints emisores que no emiten JWT real
  IF endpoint IN ['POST /api/choferes/activate', 'POST /api/choferes/login'] THEN
    RETURN true  // siempre en condición buggy hasta que el fix esté implementado
  END IF

  // Escenario B: endpoints de app móvil sin verificación de JWT de chofer
  IF endpoint IN [
    'GET  /api/app-chofer-rutas',
    'POST /api/gps/ping',
    'POST /api/chofer/evento',
    'POST /api/app-chofer-sync'
  ] THEN
    authHeader  = request.headers.get('Authorization')
    bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    
    // Bug: el sistema nunca llega a verificar el token, por lo tanto:
    RETURN true  // cualquier request llega al handler sin verificación
  END IF

  // Fuera de alcance: GET /api/gps/live pertenece al modelo de auth de Torre de Control
  // ver spec autenticacion-torre-control

  RETURN false
END FUNCTION
```

### Examples

- **activate emite token fake**: `POST /api/choferes/activate` con body válido devuelve `{"token": "jwt_simulado_1748523600000"}` — el token no tiene firma, puede ser construido por cualquiera con solo conocer la hora del servidor.
- **login no emite token**: `POST /api/choferes/login` con `rut`+`pin` correctos devuelve `{"success": true, "chofer": {...}}` sin ningún campo `token` — la app queda sin credencial de sesión.
- **rutas expuestas sin auth**: `GET /api/app-chofer-rutas?tenant_id=empresa_demo&rut=12345678-9` devuelve rutas, paradas y direcciones de clientes sin ningún token en el request.
- **GPS ping sin auth**: `POST /api/gps/ping` con `{"trip_id": "VIAJE-001", "lat": -33.5, "lng": -70.6, "tenant_id": "empresa_demo"}` acepta coordenadas falsas y corrompe `trip_metrics`.
- **eventos sin autoría**: `POST /api/chofer/evento` con `trip_id` + `stop_id` válidos registra ENTREGA falsa sin verificar que el solicitante sea el chofer asignado.

> **Nota sobre `GET /api/gps/live`:** Este endpoint también carece de autenticación, pero no es un endpoint de chofer — su exposición afecta a toda la flota de la Torre de Control y se trata como bug separado en el spec `autenticacion-torre-control`.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- La validación `rut` + `pin` en `login` y `activate` contra Supabase debe continuar funcionando exactamente igual — el token JWT se añade a la respuesta existente, no reemplaza la validación de credenciales.
- El helper `requireTenantId` sigue siendo la primera validación en todos los endpoints — el JWT check va después, no en lugar de él.
- Toda la lógica de negocio de GPS: filtros de calidad (ruido < 50m, velocidad > 130 km/h, salto > 50 km), acumulación de `km_recorridos_reales` y actualización de `trip_metrics`.
- La máquina de estados operativos de `app-chofer-evento.js`: transiciones LLEGADA → ENTREGA → SALIDA → PROBLEMA, inmutabilidad de `hora_llegada_chofer`, POD inmutable con `foto_url`.
- El recálculo de ETA en cascada via `ctx.waitUntil` en evento SALIDA.
- La lógica del ciclo de vida del viaje en `app-chofer-sync.js`: liberación del camión cuando todas las paradas están resueltas, cierre de `trip_metrics`.
- El aislamiento multi-tenant en todas las queries — `tenant_id` sigue siendo obligatorio y filtrado en todas las consultas SQL.
- El endpoint `POST /api/choferes/check-rut` permanece sin autenticación (es el paso previo al login, no puede exigir token aún).

**Scope:**
Todos los inputs que NO activen la bug condition — requests con JWT válido de un chofer autenticado haciendo operaciones legítimas — deben producir exactamente el mismo resultado que produce el código actual en su lógica de negocio.

---

## Hypothesized Root Cause

Basado en el análisis del código fuente:

1. **Token falso en activate (causa primaria)**: En `app-chofer-activate.js`, el return final usa `jwt_simulado_${Date.now()}` como placeholder. Esto indica que la funcionalidad fue desarrollada sin implementar la criptografía real — el backend Cloudflare Worker no tiene acceso a `jsonwebtoken` (librería Node.js), y el desarrollador usó un placeholder en lugar de usar la Web Crypto API nativa.

2. **Token ausente en login (omisión)**: En `app-chofer-login.js`, el flujo autentica correctamente contra Supabase (`rut` + `pin`) pero la respuesta solo devuelve los datos del chofer sin ningún campo `token`. No hay ningún comentario `// TODO` — parece una omisión sin intención.

3. **Ausencia de middleware de verificación**: Ninguno de los seis endpoints tiene ninguna llamada a una función de verificación de token. No existe un archivo `driver-auth.js` ni ningún helper equivalente en `src/helpers/`. El proyecto nunca implementó la capa de verificación.

4. **Confusión Node.js vs Cloudflare Workers**: La razón probable por la que no se implementó JWT real es que `jsonwebtoken` no funciona en Cloudflare Workers (usa APIs de Node.js no disponibles). La solución correcta — Web Crypto API con `crypto.subtle` — probablemente no era familiar al desarrollador original.

5. **GPS sin auth específica del chofer:** `handleGPSPing` en `gps.js` solo valida `tenant_id` via `requireTenantId`, lo que fue suficiente para el multi-tenant isolation pero nunca se extendió a autenticación a nivel de chofer individual. `getLiveFleet` tiene el mismo problema de ausencia de auth, pero su corrección pertenece al spec `autenticacion-torre-control` — es un endpoint de Torre de Control, no de app móvil.

### Token Expiry During Active Trip

**Problema:** Un token que expira mientras el chofer tiene un viaje activo produce HTTP 401 en el próximo GPS ping o evento, dejando al chofer bloqueado a mitad de ruta.

**Estado real del storage en la app (`logistica-app/src/store/authStore.ts`):**
La app ya usa `expo-secure-store` como backend de persistencia (cifrado por el keystore del SO, no AsyncStorage plano). Lo que se persiste en secure storage es: `token`, `tenantId`, `rut`, `driverName`, `gpsInterval`, `isAuthenticated`. **El PIN no se persiste** — el chofer lo ingresa en el formulario de login y viaja solo en el body del request, sin quedar guardado en el dispositivo.

**Consecuencia:** El refresh silencioso automático con PIN guardado **no es posible** sin que el chofer reingrese el PIN. Si el token expira a mitad de turno, la app no puede re-loguearse sola.

**Decisión de diseño:** Dado que el PIN no está disponible para refresh silencioso, la estrategia correcta es hacer que el token dure lo suficiente para que la expiración no ocurra durante operación normal. Se elige **10 horas de expiración**, que cubre el turno estándar de 8h más hasta ~1.5h de extensión operativa realista (descarga en destino, cierre de viaje, problemas en ruta). 12h sería excesivo — empieza a acercarse a "válido para el turno de mañana"; 10h es el punto justo entre cobertura real y sesión acotada.

Si el token llega a expirar (turno extendido anormal, dispositivo con reloj adelantado), el comportamiento es: la app recibe 401 con `code: "token_expirado"` y muestra la pantalla de login para que el chofer reingrese el PIN. No es silencioso, pero tampoco es un bloqueo irrecuperable — el chofer puede reiniciar sesión en menos de un minuto.

**Lo que NO hace falta cambiar en el storage:** `expo-secure-store` ya está siendo usado correctamente. No se requiere migración desde AsyncStorage como parte de este bugfix — la app ya estaba bien en este aspecto.

---

## Trade-off de sesión

El JWT de 10h con expiración fija, combinado con `expo-secure-store` para el token y PIN no persistido, significa que en la práctica la sesión del chofer dura exactamente 10 horas desde el último login — no se renueva sola. Esta es una decisión deliberada que balancea dos fuerzas: cubrir el turno completo sin interrupciones (prioridad operativa) y acotar la ventana de exposición si el token es comprometido (prioridad de seguridad). Las 24h originales priorizaban demasiado lo primero en detrimento de lo segundo; las 10h son el punto de equilibrio para un turno estándar de 8h con margen real de operación.

---

## Correctness Properties

_For any_ request a `POST /api/choferes/activate` o `POST /api/choferes/login` donde las credenciales (`rut` + `pin`) son válidas y `isBugCondition` retorna true, la función corregida SHALL generar un JWT HS256 firmado con `env.JWT_SECRET`, con payload `{chofer_id, rut, tenant_id, exp}`, devolviendo el campo `token` en la respuesta con HTTP 200.

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition — Endpoints de app móvil rechazan requests sin JWT válido

_For any_ request a los cuatro endpoints de app móvil protegidos donde `isBugCondition` retorna true (token ausente, expirado, inválido o fake), la función corregida SHALL rechazar el request con HTTP 401 antes de ejecutar cualquier lógica de negocio, sin acceder a Supabase ni modificar ningún dato. (`GET /api/gps/live` queda excluido de esta propiedad — pertenece al modelo de autorización de Torre de Control.)

**Validates: Requirements 2.3**

Property 3: Bug Condition — Endpoints con recursos propios validan autoría

_For any_ request a `/api/app-chofer-rutas`, `/api/chofer/evento` o `/api/app-chofer-sync` con un JWT válido donde el `rut` o `chofer_id` del token no coincide con el recurso solicitado, la función corregida SHALL rechazar con HTTP 403, sin exponer datos de otros choferes.

**Validates: Requirements 2.4, 2.7, 2.8**

Property 4: Preservation — Lógica de negocio inalterada para choferes autenticados

_For any_ request donde `isBugCondition` retorna false (token válido, autoría correcta), la función corregida SHALL producir exactamente el mismo resultado que la función original produce actualmente: mismos datos de respuesta, mismas escrituras en base de datos, mismas métricas GPS, mismo ciclo de vida del viaje.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

---

## Fix Implementation

### New File: `src/helpers/driver-auth.js`

Este es el corazón del fix — un helper centralizado con dos funciones que usan exclusivamente Web Crypto API (nativa en Cloudflare Workers):

```javascript
// src/helpers/driver-auth.js

import { CORS_HEADERS } from '../config.js';

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
const JWT_EXPIRY_SECONDS = 10 * 60 * 60; // 10 horas — cubre turno estándar de 8h + ~1.5h de extensión operativa real; si expira, la app muestra re-login manual (el PIN no se persiste, no hay refresh automático)

// Base64url encode/decode (sin dependencias externas)
function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function getKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), ALGORITHM, false, ['sign', 'verify']
  );
}

// Emite un JWT HS256 firmado con env.JWT_SECRET
export async function signDriverToken(payload, env) {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const exp = Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS;
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, exp })));
  const signingInput = `${header}.${body}`;
  const key = await getKey(env.JWT_SECRET);
  const signature = await crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(signature)}`;
}

// Verifica el JWT del header Authorization: Bearer <token>
// Devuelve { ok: true, payload } o una Response de error lista para retornar
// Nota: crypto.subtle.verify() es tiempo constante por diseño del W3C Web Crypto spec —
// no hay comparación === sobre strings ni ArrayBuffers en esta función.
export async function verifyDriverToken(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, response: new Response(
      JSON.stringify({ error: 'No autorizado: token ausente', code: 'token_ausente' }),
      { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )};
  }

  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, response: new Response(
      JSON.stringify({ error: 'No autorizado: token malformado', code: 'token_invalido' }),
      { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )};
  }

  try {
    const signingInput = `${parts[0]}.${parts[1]}`;
    const key = await getKey(env.JWT_SECRET);
    // crypto.subtle.verify() realiza comparación de tiempo constante internamente
    const isValid = await crypto.subtle.verify(
      ALGORITHM, key,
      base64urlDecode(parts[2]),
      new TextEncoder().encode(signingInput)
    );

    if (!isValid) {
      return { ok: false, response: new Response(
        JSON.stringify({ error: 'No autorizado: firma inválida', code: 'token_invalido' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )};
    }

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, response: new Response(
        // code: 'token_expirado' permite a la app distinguir este caso y mostrar pantalla de re-login manual
        JSON.stringify({ error: 'No autorizado: token expirado', code: 'token_expirado' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )};
    }

    return { ok: true, payload };
  } catch {
    return { ok: false, response: new Response(
      JSON.stringify({ error: 'No autorizado: token inválido', code: 'token_invalido' }),
      { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )};
  }
}
```

### Changes Required

**File 1: `src/api/app-chofer-activate.js`**

- Importar `signDriverToken` desde `../helpers/driver-auth.js`
- Reemplazar `token: \`jwt_simulado_${Date.now()}\`` por `token: await signDriverToken({ chofer_id: chofer.chofer_id, rut, tenant_id }, env)`
- La función ya tiene el `rut` del body; añadir `chofer_id` al select de Supabase para incluirlo en el payload del JWT

**File 2: `src/api/app-chofer-login.js`**

- Importar `signDriverToken` desde `../helpers/driver-auth.js`
- Añadir `token: await signDriverToken({ chofer_id: chofer.id, rut, tenant_id }, env)` en la respuesta existente
- La función ya tiene `rut` y `tenant_id`; el `chofer_id` ya viene en `chofer.id`

**File 3: `src/api/app-chofer-rutas.js`**

- Importar `verifyDriverToken` desde `../helpers/driver-auth.js`
- Añadir al inicio: verificar token, y luego verificar que `tokenPayload.rut === rut` del query string
- Cambiar de query params a Bearer token como credencial — el `rut` del query param sigue siendo necesario para la query SQL pero su autorización viene del token

**File 4: `src/api/gps.js` — `handleGPSPing`**

- Importar `verifyDriverToken`
- Añadir verificación de token al inicio del handler
- Verificar que `tokenPayload.tenant_id === body.tenant_id`
- Verificar que el `trip_id` del body pertenece al vehículo asignado al chofer del token (query a `flota_vehiculos` donde `rut_chofer_asignado = tokenPayload.rut`)

> **`getLiveFleet` (File 5 original):** este handler queda fuera del alcance de este bugfix. Su protección con autenticación de Torre de Control se trata en el spec `autenticacion-torre-control`.

**File 5: `src/api/app-chofer-evento.js`**

- Importar `verifyDriverToken`
- Añadir verificación de token **antes** de la validación del tenant (línea 1 del handler)
- Verificar autoría: consultar `flota_vehiculos` para confirmar que `rut_chofer_asignado = tokenPayload.rut` para el `trip_id` recibido
- Responder con HTTP 403 si el chofer autenticado no es el asignado al viaje

**File 6: `src/api/app-chofer-sync.js`**

- Importar `verifyDriverToken`
- Añadir verificación de token al inicio
- Verificar que `tokenPayload.rut === body.rut` — el `rut` en el body debe coincidir con el del token

---

## Endpoints fuera de alcance

### `GET /api/gps/live` — Torre de Control, no app móvil

`getLiveFleet` expone la posición en tiempo real de **toda la flota activa del tenant** — no los datos de un chofer individual. Su audiencia son los operadores logísticos en la Torre de Control (`/control-tower`), no los choferes usando la app móvil.

**Por qué no usa `verifyDriverToken`:** El JWT de chofer (`signDriverToken`) codifica identidad individual — `{chofer_id, rut, tenant_id}`. Un chofer autenticado que llame a este endpoint podría ver la ubicación de todos sus colegas, lo cual no es un permiso que debe tener. El modelo de autorización correcto para este endpoint es acceso de operador/supervisor, no acceso de chofer.

**Estado actual:** `getLiveFleet` actualmente no tiene autenticación de ningún tipo (solo `requireTenantId`). Esto es un bug separado y más amplio: la Torre de Control completa (`/control-tower`, `/dashboard/monitoring`, `/dashboard/executive`, `/dashboard/operaciones`) y sus APIs carecen de autenticación conectada, a pesar de que el helper `validateDashboardAccess` existe en `src/monitoring/auth.js`.

**Tratamiento:** Este bug se documenta y corrige en el spec **`autenticacion-torre-control`**, que tiene su propio requirements.md → design.md → tasks.md. El bug de autenticación de chofer puede declararse completo sin que ese spec esté implementado.

---

## Testing Strategy

### Validation Approach

El testing sigue la metodología de dos fases: primero confirmar el bug con tests en código sin fix (exploratory), luego verificar el fix con tests de corrección y preservación.

Dado que los endpoints involucran operaciones criptográficas (`crypto.subtle`), el framework de testing debe soportar el runtime de Cloudflare Workers. El proyecto usa **Vitest** (ver `package.json`). Para los tests de los helpers criptográficos se usará el `@cloudflare/workers-types` environment o mocks de `crypto.subtle`.

### Exploratory Bug Condition Checking

**Goal**: Demostrar que el bug existe en el código sin fix. Confirmar el root cause y que los endpoints no verifican tokens.

**Test Plan**: Llamar los endpoints directamente en tests unitarios con requests maliciosos (sin token, con token fake, con datos de otro chofer) y observar que los handlers actuales no los rechazan.

**Test Cases**:

1. **activate retorna token fake**: Llamar `activateChofer` con credenciales válidas (mock de Supabase), verificar que el `token` en la respuesta es `jwt_simulado_*` (sin firma) — FALLA en código sin fix porque no hay JWT real.
2. **login no retorna token**: Llamar `loginChofer` con credenciales válidas, verificar que la respuesta contiene un campo `token` — FALLA porque no existe el campo.
3. **rutas sin token**: Llamar `getChoferRutas` sin header `Authorization`, verificar que retorna HTTP 401 — FALLA porque retorna HTTP 200 con los datos.
4. **GPS ping sin token**: Llamar `handleGPSPing` sin header `Authorization` con `trip_id` válido, verificar que retorna HTTP 401 — FALLA porque acepta el ping.
5. **evento sin autoría**: Llamar `handleChoferEvento` con token de un chofer pero `trip_id` asignado a otro, verificar que retorna HTTP 403 — FALLA porque no verifica autoría.

**Expected Counterexamples**:
- Los handlers retornan HTTP 200 / procesan el request sin verificar token
- El campo `token` en la respuesta de `activate` contiene `jwt_simulado_` en lugar de tres partes separadas por puntos (estructura JWT real)

### Fix Checking

**Goal**: Verificar que para todos los inputs donde `isBugCondition` retorna true, la función corregida produce el comportamiento esperado.

**Pseudocode:**
```
FOR ALL request WHERE isBugCondition(request, endpoint) DO
  result := fixedHandler(request, env_with_JWT_SECRET)
  ASSERT expectedBehavior(result)
END FOR

FUNCTION expectedBehavior(result)
  IF endpoint IN ['activate', 'login'] THEN
    RETURN result.status === 200
           AND result.body.token IS_VALID_JWT
           AND hasThreeParts(result.body.token)
           AND signatureVerifiesWithSecret(result.body.token, JWT_SECRET)
  ELSE
    RETURN result.status === 401  // sin token
        OR result.status === 403  // token válido pero sin autoría
  END IF
END FUNCTION
```

### Preservation Checking

**Goal**: Verificar que para todos los inputs donde `isBugCondition` retorna false (chofer autenticado correctamente haciendo operaciones legítimas), la función corregida produce el mismo resultado que la función original.

**Pseudocode:**
```
FOR ALL request WHERE NOT isBugCondition(request, endpoint) DO
  tokenValido = generarTokenValido(chofer_asignado_al_trip, JWT_SECRET)
  requestConToken = añadir_header(request, 'Authorization', 'Bearer ' + tokenValido)
  
  resultOriginal  := originalHandler(request, env)        // sin token check
  resultCorregido := fixedHandler(requestConToken, env)    // con token check
  
  ASSERT resultOriginal.status    === resultCorregido.status
  ASSERT resultOriginal.body_keys === resultCorregido.body_keys
  ASSERT mismasEscriturasBD(resultOriginal, resultCorregido)
END FOR
```

**Testing Approach**: Property-based testing es especialmente útil aquí para:
- Generar muchas combinaciones de payloads GPS válidos y verificar que los filtros de calidad siguen funcionando igual
- Generar muchos estados de viaje y verificar que el ciclo de vida (liberación del camión, cierre de `trip_metrics`) se comporta igual con o sin el fix

**Test Cases**:

1. **GPS filters preservation**: Con token válido del chofer asignado, enviar coordenadas en todos los rangos (ruido < 50m, velocidad > 130 km/h, salto > 50 km, coordenadas válidas) y verificar que los filtros siguen aplicando igual que antes del fix.
2. **Evento ENTREGA preservation**: Con token válido, enviar evento ENTREGA con `foto_url` y verificar que actualiza `ordenes_pendientes` a ENTREGADO, inserta en `bitacora_viajes` y llama `insertEtaMetric`.
3. **Login response preservation**: Con credenciales correctas, verificar que la respuesta sigue conteniendo `chofer.id`, `chofer.nombre`, `chofer.patente`, `chofer.estado`, `chofer.config.ping_interval` — además del nuevo campo `token`.
4. **Tenant isolation preservation**: Con token válido de tenant A, verificar que las queries siguen filtrando por `tenant_id` y no exponen datos del tenant B.

### Unit Tests

- `signDriverToken`: genera token con tres partes separadas por puntos, payload decodificable incluye `chofer_id`, `rut`, `tenant_id`, `exp`; la firma verifica con el mismo secreto; no verifica con secreto diferente
- `verifyDriverToken`: retorna `{ ok: true, payload }` para token válido; retorna `{ ok: false, response: 401 }` para token ausente; retorna 401 para token expirado; retorna 401 para token con firma corrupta; retorna 401 para token fake `jwt_simulado_*`
- `activateChofer` (fixed): respuesta incluye campo `token`, el token es un JWT válido firmado con `JWT_SECRET`
- `loginChofer` (fixed): respuesta incluye campo `token`, los otros campos de la respuesta no cambian
- `getChoferRutas` (fixed): sin Authorization header → 401; con token de chofer diferente al rut solicitado → 403; con token correcto → 200 con datos
- `handleGPSPing` (fixed): sin token → 401; con token de tenant diferente → 403; con token correcto pero trip no asignado al chofer → 403
- `handleChoferEvento` (fixed): sin token → 401; con token de chofer no asignado al trip → 403
- `getLiveFleet`: no forma parte de los tests de este bugfix — ver spec `autenticacion-torre-control`

### Property-Based Tests

- **Propiedad firma**: Para cualquier payload `{ chofer_id, rut, tenant_id }` y cualquier secreto de 32+ bytes, `signDriverToken` seguido de `verifyDriverToken` siempre devuelve el mismo payload (round-trip correctness)
- **Propiedad rechazo invariante**: Para cualquier token donde se modifique cualquier byte de la firma, `verifyDriverToken` siempre retorna `{ ok: false }`
- **Propiedad expiración**: Para cualquier token generado con `exp` en el pasado, `verifyDriverToken` siempre retorna `{ ok: false }` con mensaje de expirado
- **Propiedad preservación GPS**: Para cualquier secuencia de pings válidos (lat/lng en rango, sin ruido, sin velocidad imposible) de un chofer autenticado, el resultado de `handleGPSPing` fixed debe ser idéntico al resultado de `handleGPSPing` original (mismo HTTP status, mismos km calculados)

### Integration Tests

- Flujo completo activate → login → rutas: activar cuenta, hacer login, usar el token de login para obtener rutas — debe devolver datos sin error
- Flujo GPS completo: hacer login, usar token para enviar 5 pings consecutivos, verificar que km se acumulan correctamente en `flota_vehiculos` y `trip_metrics`
- Flujo evento completo: hacer login, registrar LLEGADA, luego ENTREGA con foto, verificar que `ordenes_pendientes` tiene `estado_operacional = ENTREGADO` y `evidencia_url` seteada
- Test de rechazo de token expirado: generar token con `exp` pasado, verificar que todos los endpoints retornan 401
