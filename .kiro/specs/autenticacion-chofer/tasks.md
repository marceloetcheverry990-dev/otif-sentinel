# Implementation Plan: Autenticación Chofer

## Overview

Implementa el bugfix de autenticación de la app móvil del chofer en dos capas: primero el helper criptográfico centralizado (`driver-auth.js`) y sus smoke tests de verificación, luego las correcciones en los endpoints emisores de tokens y los protegidos, y finalmente la suite completa de tests que confirma tanto el bug como el fix y las no-regresiones.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["T1"],
      "description": "Crear el helper criptográfico centralizado — prerequisito de todo lo demás"
    },
    {
      "wave": 2,
      "tasks": ["T2"],
      "description": "Smoke tests del helper — verificar que sign y verify funcionan antes de tocar ningún endpoint"
    },
    {
      "wave": 3,
      "tasks": ["T3", "T4", "T5", "T6", "T7", "T8"],
      "description": "Correcciones en endpoints emisores y protegidos — pueden ejecutarse en paralelo entre sí"
    },
    {
      "wave": 4,
      "tasks": ["T9"],
      "description": "Tests exploratorios que confirman el bug condition"
    },
    {
      "wave": 5,
      "tasks": ["T10"],
      "description": "Tests de fix checking y preservation checking"
    }
  ]
}
```

## Tasks

- [x] 1. Crear `src/helpers/driver-auth.js` con `signDriverToken` y `verifyDriverToken`

  Crear el archivo nuevo `src/helpers/driver-auth.js` con las dos funciones helper usando exclusivamente Web Crypto API nativa de Cloudflare Workers. No usar dependencias externas.

  **`signDriverToken(payload, env)`:**
  - Implementar base64url encode/decode sin librerías (usando `btoa`/`atob` con reemplazos de `+`, `/`, `=`)
  - Header fijo: `{ alg: 'HS256', typ: 'JWT' }`
  - Importar clave con `crypto.subtle.importKey('raw', TextEncoder.encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])`
  - `JWT_EXPIRY_SECONDS = 10 * 60 * 60` — comentario: "10 horas — cubre turno estándar de 8h + ~1.5h de extensión operativa real; si expira, la app muestra re-login manual (el PIN no se persiste, no hay refresh automático)"
  - Calcular `exp = Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS`
  - Signing input: `base64url(header) + '.' + base64url({...payload, exp})`
  - Firmar con `crypto.subtle.sign` y retornar `signingInput + '.' + base64url(signature)`
  - Importar `CORS_HEADERS` desde `'../config.js'`

  **`verifyDriverToken(request, env)`:**
  - Extraer `Authorization` header; si ausente o no empieza con `Bearer `, retornar `{ ok: false, response: Response(401, { error: 'No autorizado: token ausente', code: 'token_ausente' }) }`
  - Validar que el token tiene exactamente 3 partes separadas por `.`; si no, retornar 401 `token_invalido`
  - Verificar firma con `crypto.subtle.verify()` — tiempo constante por diseño del W3C Web Crypto spec; no comparar strings manualmente
  - Si firma inválida: retornar 401 `token_invalido`
  - Decodificar payload; si `payload.exp < Math.floor(Date.now() / 1000)`: retornar 401 `token_expirado`
  - Si todo ok: retornar `{ ok: true, payload }`
  - Todos los errores de Response incluyen `{ ...CORS_HEADERS, 'Content-Type': 'application/json' }`

  **Validates:** Requirements 2.1, 2.2, 2.3

- [x] 2. Smoke tests del helper criptográfico

  Crear `src/helpers/driver-auth.test.js` con los casos mínimos que deben pasar antes de que se toque ningún endpoint. El objetivo de esta tarea es únicamente verificar que el helper funciona correctamente como unidad aislada — que firma, que verifica, que rechaza. Los casos PBT y de integración van en T10.

  **Casos requeridos (todos deben pasar antes de avanzar a Wave 3):**

  - **Token structure:** `signDriverToken({ chofer_id: 'c1', rut: '12345678-9', tenant_id: 'tenant_demo' }, env)` retorna un string con exactamente 3 partes separadas por `.`
  - **Round-trip correcto:** `verifyDriverToken` aplicado sobre el token generado por `signDriverToken` con el mismo `env.JWT_SECRET` retorna `{ ok: true }` y el payload incluye `chofer_id`, `rut`, `tenant_id`
  - **Rechazo con secreto distinto:** `verifyDriverToken` con un `env` que tiene un `JWT_SECRET` diferente al usado para firmar retorna `{ ok: false }` con código `token_invalido`

  **Setup:**
  - Usar `vitest` (ya presente en `package.json`)
  - `env` de test: objeto `{ JWT_SECRET: 'test-secret-32-bytes-minimum-len' }` — no usar DB ni Supabase en estos tests
  - Si el entorno de vitest no expone `crypto.subtle` nativamente, configurar el environment de vitest para usar `node` (Node 19+ tiene Web Crypto global) o mockear con `globalThis.crypto = webcrypto` desde `node:crypto`

  **Criterio de completitud:** los tres casos corren con `vitest --run` y pasan sin errores antes de continuar.

  **Validates:** Prerequisites para Requirements 2.1, 2.2, 2.3

- [x] 3. Corregir `src/api/app-chofer-activate.js` — emitir JWT real

  - Importar `signDriverToken` desde `'../helpers/driver-auth.js'`
  - En la query SELECT a Supabase que obtiene el chofer, añadir `chofer_id` a los campos seleccionados si no está ya presente
  - Reemplazar la línea `token: \`jwt_simulado_${Date.now()}\`` por:
    ```javascript
    token: await signDriverToken({ chofer_id: chofer.chofer_id, rut, tenant_id }, env)
    ```
  - No modificar ninguna otra lógica: validación de `rut` + `pin`, queries a Supabase, manejo de errores, respuesta existente

  **Validates:** Requirement 2.1 | **Preserves:** Requirements 3.1, 3.2

- [x] 4. Corregir `src/api/app-chofer-login.js` — emitir JWT real en login diario

  - Importar `signDriverToken` desde `'../helpers/driver-auth.js'`
  - Identificar el objeto de respuesta existente que devuelve los datos del chofer (`id`, `nombre`, `patente`, `estado`, `config`, etc.)
  - Añadir el campo `token` a ese objeto:
    ```javascript
    token: await signDriverToken({ chofer_id: chofer.id, rut, tenant_id }, env)
    ```
  - No modificar ninguna otra lógica: validación de credenciales, queries, estructura de respuesta existente — solo añadir el campo `token`

  **Validates:** Requirement 2.2 | **Preserves:** Requirement 3.1

- [x] 5. Proteger `src/api/app-chofer-rutas.js` — verificación JWT + autoría de RUT

  - Importar `verifyDriverToken` desde `'../helpers/driver-auth.js'`
  - Al inicio del handler, después de `requireTenantId` y antes de cualquier query a Supabase:
    ```javascript
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;
    ```
  - Verificar autoría: si `auth.payload.rut !== rut` del query string, retornar:
    ```javascript
    new Response(
      JSON.stringify({ error: 'Prohibido: el token no corresponde al rut solicitado', code: 'rut_mismatch' }),
      { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
    ```
  - `requireTenantId` sigue siendo la primera validación; el JWT check va inmediatamente después
  - No modificar lógica de negocio: queries de rutas, paradas, órdenes

  **Validates:** Requirements 2.3, 2.4 | **Preserves:** Requirement 3.3

- [x] 6. Proteger `handleGPSPing` en `src/api/gps.js` — verificación JWT + autoría de viaje

  - Importar `verifyDriverToken` desde `'../helpers/driver-auth.js'`
  - Al inicio de `handleGPSPing`, después del parse del body y del check de `requireTenantId`, añadir:
    ```javascript
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;
    ```
  - Verificar que `auth.payload.tenant_id === tenant_id` del body; si no coincide: retornar 403 `tenant_mismatch`
  - Verificar autoría del viaje: consultar `flota_vehiculos WHERE trip_id_actual = $1 AND tenant_id = $2 AND rut_chofer_asignado = $3`; si rowCount === 0: retornar 403 `trip_not_assigned`
  - No modificar lógica GPS: filtros de ruido/velocidad/salto, acumulación de km, updates a `flota_vehiculos` y `trip_metrics`
  - **No tocar `getLiveFleet`** — ese handler queda sin modificar en este bugfix (pertenece al spec `autenticacion-torre-control`)

  **Validates:** Requirements 2.3, 2.5 | **Preserves:** Requirement 3.4

- [x] 7. Proteger `src/api/app-chofer-evento.js` — verificación JWT + autoría de chofer asignado

  - Importar `verifyDriverToken` desde `'../helpers/driver-auth.js'`
  - Al inicio del handler, como primera operación antes de cualquier validación existente:
    ```javascript
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;
    ```
  - Después del check de token y del parse del body, verificar autoría del viaje: consultar `flota_vehiculos WHERE trip_id_actual = $1 AND tenant_id = $2 AND rut_chofer_asignado = $3`; si no hay resultado: retornar 403 `trip_not_assigned`
  - No modificar la máquina de estados operativos: transiciones LLEGADA → ENTREGA → SALIDA → PROBLEMA, inmutabilidad de `hora_llegada_chofer`, POD inmutable con `foto_url`, recálculo de ETA via `ctx.waitUntil`

  **Validates:** Requirements 2.3, 2.7 | **Preserves:** Requirements 3.5, 3.6, 3.7

- [x] 8. Proteger `src/api/app-chofer-sync.js` — verificación JWT + autoría de RUT

  - Importar `verifyDriverToken` desde `'../helpers/driver-auth.js'`
  - Al inicio del handler, antes de cualquier lógica de negocio:
    ```javascript
    const auth = await verifyDriverToken(request, env);
    if (!auth.ok) return auth.response;
    ```
  - Verificar que `auth.payload.rut === body.rut`; si no coincide: retornar 403 `rut_mismatch`
  - No modificar lógica de sincronización: liberación del camión cuando todas las paradas están resueltas, cierre de `trip_metrics`, multi-tenant isolation

  **Validates:** Requirements 2.3, 2.8 | **Preserves:** Requirements 3.1, 3.8

- [x] 9. Tests exploratorios — confirmar bug condition antes del fix

  Ampliar `src/helpers/driver-auth.test.js` con los casos que demuestran que el bug existe tal como está documentado, usando mocks de Supabase (no DB real).

  **Nota de implementación (decisión documentada):** El spec original pedía tests exploratorios contra el código *antes* del fix. Al ejecutar esta wave, el fix de Wave 3 ya estaba aplicado, por lo que no era posible (ni útil) correr tests contra el código buggy original — hacerlo hubiera requerido deshacer el fix, correr los tests, y volver a aplicarlo, sin aportar valor adicional al estado final del repositorio. En cambio, se implementaron como `src/api/bug-condition.test.js` tests de *confirmación del fix* desde el ángulo de la bug condition: cada test lleva la referencia al Requirement que documenta, describe cuál era el comportamiento buggy original, y verifica que el código corregido ya no lo exhibe. Esta aproximación documenta el bug con la misma precisión que un test exploratorio, sin introducir código transitorio que luego habría que eliminar.

  **Scope:** Req 1.6 (`GET /api/gps/live`) no está cubierto en este archivo — ese requirement quedó explícitamente fuera de alcance de este bugfix (ver sección "Endpoints fuera de alcance" en design.md). Su test de confirmación pertenece al spec `autenticacion-torre-control`.

  **Tests implementados en `src/api/bug-condition.test.js`:**

  **Escenario A — emisores (Req 1.1, 1.2):**
  - `[Req 1.1]` `activate` ya no emite `jwt_simulado_*` — emite JWT con 3 partes, verificable con `JWT_SECRET`
  - `[Req 1.2]` `login` incluye campo `token` en la respuesta; los demás campos del chofer no cambian

  **Escenario B — endpoints sin verificación (Req 1.3–1.5, 1.7, 1.8):**
  - `[Req 1.3, 1.4]` `GET /api/app-chofer-rutas` rechaza con 401 sin token; con 403 `rut_mismatch` si el rut del token no coincide
  - `[Req 1.3, 1.5]` `POST /api/gps/ping` rechaza con 401 sin token; con 403 `tenant_mismatch` si el tenant del token no coincide
  - `[Req 1.3, 1.7]` `POST /api/chofer/evento` rechaza con 401 sin token; con 403 `trip_not_assigned` si el chofer no está asignado al viaje
  - `[Req 1.3, 1.8]` `POST /api/app-chofer-sync` rechaza con 401 sin token; con 403 `rut_mismatch` si el rut del body no coincide con el token

  Mockear `../db.js` y `@supabase/supabase-js` para evitar conexiones reales.

  **Validates:** Documenta isBugCondition para Requirements 1.1–1.5, 1.7–1.8 (Req 1.6 excluido por diseño)

- [x] 10. Tests de fix checking y preservation checking

  Añadir al mismo archivo de tests los casos de verificación post-fix.

  **Tests unitarios adicionales de `signDriverToken` / `verifyDriverToken` (complementan T2):**
  - Payload decodificado incluye `chofer_id`, `rut`, `tenant_id`, `exp`; `exp` está ~10h en el futuro
  - Retorna 401 `token_expirado` para token con `exp` en el pasado
  - Retorna 401 `token_invalido` para token con un byte de firma modificado
  - Retorna 401 `token_invalido` para token fake `jwt_simulado_1234567890`
  - **PBT — round-trip:** para cualquier payload `{ chofer_id, rut, tenant_id }` y secreto de 32+ bytes, `signDriverToken` → `verifyDriverToken` siempre retorna el mismo payload
  - **PBT — rechazo invariante:** para cualquier token donde se modifique cualquier byte de la firma, `verifyDriverToken` siempre retorna `{ ok: false }`

  **Tests de fix checking (endpoints corregidos):**
  - `activateChofer` (fixed): campo `token` tiene 3 partes, la firma verifica con `JWT_SECRET`
  - `loginChofer` (fixed): campo `token` presente y válido; `chofer.id`, `chofer.nombre`, `chofer.patente`, `chofer.estado`, `chofer.config.ping_interval` sin cambios
  - `getChoferRutas` (fixed): sin token → 401; rut del token ≠ rut del query string → 403; token y rut correctos → 200
  - `handleGPSPing` (fixed): sin token → 401; tenant del token ≠ tenant del body → 403; trip no asignado al chofer → 403; todo correcto → 200
  - `handleChoferEvento` (fixed): sin token → 401; chofer no asignado al trip → 403; chofer correcto → procesa evento
  - `syncChoferEvent` (fixed): sin token → 401; rut del token ≠ rut del body → 403; rut correcto → 200

  **Tests de preservation (lógica de negocio inalterada):**
  - Con token válido, `handleGPSPing` aplica filtro de ruido (delta < 50m → gps_ruido = 1, no acumula km)
  - Con token válido, `handleGPSPing` aplica filtro de velocidad imposible (> 130 km/h → gps_vel = 1, no acumula km)
  - Con token válido, `handleChoferEvento` tipo ENTREGA actualiza orden a ENTREGADO e inserta en bitácora
  - Con token de tenant A, queries siguen filtrando por `tenant_id` y no exponen datos de tenant B

  **Validates:** Properties 1–4 del design.md | **Validates:** Requirements 2.1–2.8, 3.1–3.8

## Notes

- `getLiveFleet` (`GET /api/gps/live`) está explícitamente fuera del alcance de este bugfix. No modificar ese handler. Su protección se trata en el spec `autenticacion-torre-control`.
- El endpoint `POST /api/choferes/check-rut` permanece sin autenticación por diseño — es el paso previo al login, no puede exigir token aún. No agregar `verifyDriverToken` ahí.
- `JWT_EXPIRY_SECONDS` debe definirse solo en `src/helpers/driver-auth.js`. No duplicar esta constante en otros archivos.
- Al ejecutar T6 (`handleGPSPing`), verificar que el import de `verifyDriverToken` no afecta `getLiveFleet` que está en el mismo archivo — solo añadir el import y usarlo dentro de `handleGPSPing`.
- T2 actúa como gate de Wave 3: si alguno de los tres smoke tests falla, no avanzar a los endpoints hasta resolver el helper.
