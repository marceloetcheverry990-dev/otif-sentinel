# Bugfix Requirements Document

## Introduction

El sistema de autenticación de la app móvil del chofer tiene dos fallas críticas de seguridad en sus flujos de login. El flujo de activación (`POST /api/choferes/activate`) genera un token falso (`jwt_simulado_${Date.now()}`) que nunca es firmado criptográficamente. El flujo de login diario (`POST /api/choferes/login`) — el más usado en operación normal, ejecutado cada vez que el chofer abre la app — no emite ningún token en absoluto. En ninguno de los dos casos el servidor vuelve a verificar credencial alguna en requests posteriores. Como consecuencia, todos los endpoints protegidos del chofer —rutas, eventos operativos, GPS, flota en vivo— se reducen a aceptar `tenant_id` + `rut` (o solo `tenant_id`) como única "credencial", siendo ambos datos públicos o predecibles. Esto expone direcciones privadas de clientes, permite inyectar posiciones GPS falsas y revela la posición en tiempo real de toda la flota sin autenticación real.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN el chofer completa el flujo de activación (`POST /api/choferes/activate`) THEN el sistema devuelve `token: "jwt_simulado_<timestamp>"` como credencial, sin firmar criptográficamente ningún secreto.

1.2 WHEN el chofer ya activado inicia sesión en el flujo de login diario (`POST /api/choferes/login`) con `tenant_id` + `rut` + `pin` válidos THEN el sistema devuelve los datos del chofer (`id`, `nombre`, `patente`, `estado`, `config`) sin emitir ningún token de sesión — ni real ni simulado. La app queda sin credencial de sesión después del login normal, que es el flujo ejecutado en cada apertura de la aplicación.

1.3 WHEN la app móvil envía el token generado por `activate` en cualquier request posterior THEN el sistema nunca verifica ni valida ese token en ningún middleware ni endpoint.

1.4 WHEN un atacante realiza `GET /api/app-chofer-rutas?tenant_id=empresa_demo&rut=<rut_publico>` con el RUT de cualquier chofer THEN el sistema devuelve la ruta completa del chofer incluyendo paradas, nombres y direcciones de clientes, sin exigir ningún token ni credencial adicional.

1.5 WHEN un atacante realiza `POST /api/gps/ping` con un `trip_id` adivinado (formato secuencial `VIAJE-001`, `VIAJE-002`) y un `tenant_id` conocido THEN el sistema acepta coordenadas GPS falsas, corrompiendo los kilómetros calculados en `trip_metrics` y mostrando posiciones incorrectas en la Torre de Control.

1.6 WHEN un atacante realiza `GET /api/gps/live?tenant_id=empresa_demo` THEN el sistema expone la posición en tiempo real de toda la flota del tenant sin requerir ningún tipo de autenticación.

1.7 WHEN un atacante envía `POST /api/chofer/evento` con `tenant_id` + `trip_id` + `stop_id` válidos THEN el sistema registra eventos operativos (LLEGADA, ENTREGA, SALIDA, PROBLEMA) sin verificar que el solicitante sea el chofer asignado al viaje.

1.8 WHEN un atacante envía `POST /api/app-chofer-sync` con `tenant_id` + `rut` + `stopId` THEN el sistema modifica estados de órdenes sin verificar que el `rut` corresponda al chofer asignado al viaje.

---

### Expected Behavior (Correct)

2.1 WHEN el chofer completa el flujo de activación (`POST /api/choferes/activate`) THEN el sistema SHALL generar y devolver un token JWT real, firmado criptográficamente con un secreto del servidor (`JWT_SECRET`), con payload que incluya `chofer_id`, `rut`, `tenant_id` y tiempo de expiración.

2.2 WHEN el chofer ya activado inicia sesión en el flujo de login diario (`POST /api/choferes/login`) con `tenant_id` + `rut` + `pin` válidos THEN el sistema SHALL generar y devolver un token JWT real con el mismo formato que el generado en `activate` — firmado con `JWT_SECRET`, con payload que incluya `chofer_id`, `rut`, `tenant_id` y tiempo de expiración — junto a los datos del chofer.

2.3 WHEN la app móvil envía el token en el header `Authorization: Bearer <token>` THEN el sistema SHALL verificar la firma del token antes de procesar cualquier request a los endpoints protegidos del chofer, rechazando con HTTP 401 cualquier token inválido, expirado o ausente.

2.4 WHEN se recibe `GET /api/app-chofer-rutas` con un Bearer token válido THEN el sistema SHALL verificar que el `rut` del token coincide con el `rut` solicitado en el query string, rechazando con HTTP 403 si no coinciden.

2.5 WHEN se recibe `POST /api/gps/ping` con un Bearer token válido THEN el sistema SHALL verificar que el `tenant_id` del token coincide con el `tenant_id` del payload, y que el `trip_id` pertenece al vehículo asignado al chofer autenticado, rechazando con HTTP 403 si no se cumple alguna condición.

2.6 WHEN se recibe `GET /api/gps/live` THEN el sistema SHALL requerir un token de sesión válido (perteneciente al tenant correspondiente) para exponer la posición de la flota, rechazando con HTTP 401 si no hay token.

2.7 WHEN se recibe `POST /api/chofer/evento` con un Bearer token válido THEN el sistema SHALL verificar que el chofer autenticado es el asignado al viaje (`trip_id`) antes de registrar el evento, rechazando con HTTP 403 si no es así.

2.8 WHEN se recibe `POST /api/app-chofer-sync` con un Bearer token válido THEN el sistema SHALL verificar que el `rut` del token coincide con el `rut` del payload, rechazando con HTTP 403 si no coinciden.

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN el flujo de login (`POST /api/choferes/login`) recibe `tenant_id` + `rut` + `pin` válidos THEN el sistema SHALL CONTINUE TO validar las credenciales contra la base de datos y devolver los datos del chofer autenticado, extendiendo la respuesta para incluir el nuevo token JWT real.

3.2 WHEN el flujo de check-rut (`POST /api/choferes/check-rut`) recibe `tenant_id` + `rut` THEN el sistema SHALL CONTINUE TO verificar si el RUT existe en el tenant y si la cuenta ya está activada, devolviendo `canActivate: true` o el error correspondiente.

3.3 WHEN un chofer autenticado accede a `GET /api/app-chofer-rutas` con su propio RUT THEN el sistema SHALL CONTINUE TO devolver la ruta completa con paradas, órdenes y datos del viaje asignado.

3.4 WHEN el sistema recibe un GPS ping válido de un chofer autenticado con coordenadas dentro de los rangos permitidos THEN el sistema SHALL CONTINUE TO aplicar los filtros de calidad GPS (ruido, velocidad imposible, salto), actualizar `flota_vehiculos` y `trip_metrics` correctamente.

3.5 WHEN un chofer autenticado registra un evento de tipo ENTREGA con `foto_url` THEN el sistema SHALL CONTINUE TO actualizar el estado de la orden a ENTREGADO, insertar en bitácora y capturar métricas ETA en background.

3.6 WHEN un chofer autenticado registra un evento de tipo LLEGADA THEN el sistema SHALL CONTINUE TO congelar el reloj SLA actualizando `hora_llegada_chofer` con inmutabilidad (solo si aún es null).

3.7 WHEN el sistema recibe eventos operativos de un chofer autenticado (SALIDA) THEN el sistema SHALL CONTINUE TO recalcular ETAs en cascada para las paradas pendientes vía `ctx.waitUntil`.

3.8 WHEN el aislamiento multi-tenant es evaluado en cualquier endpoint THEN el sistema SHALL CONTINUE TO filtrar todas las consultas a base de datos por `tenant_id`, nunca exponiendo datos de otros tenants.

---

## Hallazgos durante implementación (Wave 3)

### Hallazgo 1 — La app móvil no mandaba Authorization header en sus llamadas a endpoints protegidos

**Descubierto durante:** Wave 3, al revisar `HomeScreen.tsx` después de aplicar `verifyDriverToken` en el backend.

**Descripción:** El spec original se enfocó exclusivamente en corregir el backend. Al revisar el código cliente de `logistica-app/` durante la implementación, se encontró que `HomeScreen.tsx` llamaba a dos de los endpoints recién protegidos sin incluir el header `Authorization: Bearer <token>`. Esto hubiera causado HTTP 401 en producción inmediatamente después del deploy del backend, incluso con un chofer con sesión activa y token válido en el dispositivo.

**Alcance real del problema — auditoría de todas las llamadas fetch en la app:**

| Archivo | Endpoint | Necesitaba fix |
|---|---|---|
| `HomeScreen.tsx` — `fetchViajes` | `GET /api/app-chofer-rutas` | ✅ Corregido — agregado `Authorization: Bearer ${token}` |
| `HomeScreen.tsx` — `registrarEvento` | `POST /api/chofer/evento` | ✅ Corregido — agregado `Authorization: Bearer ${token}` |
| `syncStore.ts` — `processQueue` | `POST /api/app-chofer-sync` | Ya tenía `Authorization: Bearer ${token}` — sin cambio |
| `syncStore.ts` — `processQueue` (fallback evento) | `POST /api/chofer/evento` | Ya tenía `Authorization: Bearer ${token}` — sin cambio |
| `authStore.ts` — `login`, `activate`, `checkRUT` | `/api/choferes/login`, `/activate`, `/check-rut` | No requieren token — son emisores de token o pre-login |
| `chatStore.ts` — `fetchMessages`, `sendMessage` | `/api/chat`, `/api/upload-evidence` | No requieren token de chofer |

**Corrección aplicada:** `token` agregado al destructuring de `useAuthStore()` en `HomeScreen.tsx`, y header `Authorization` añadido en las dos llamadas fetch identificadas.

**También corregido en backend (mismo hallazgo):** `GET /api/app-chofer-rutas` devolvía 403 `rut_mismatch` cuando el parámetro `rut` era `null` o estaba ausente, en lugar de un 400 explícito. Se separaron los dos chequeos: `rut` ausente → 400 `rut_ausente` (antes del check JWT); `rut` presente pero diferente al del token → 403 `rut_mismatch`.

**Archivos modificados por este hallazgo:**
- `logistica-app/src/screens/HomeScreen.tsx`
- `lead-rescue-worker/src/api/app-chofer-rutas.js`
