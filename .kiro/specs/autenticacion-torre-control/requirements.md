# Requirements Document

## Introduction

La Torre de Control (`/control-tower`) y sus APIs asociadas están hoy completamente sin protección. Cualquier persona con la URL puede ver órdenes activas, direcciones de clientes, viajes en curso, valores de OT, posiciones GPS de toda la flota y métricas financieras del negocio — sin necesidad de ninguna credencial. Esto no requiere un ataque sofisticado: alcanza con conocer la URL del worker.

El spec `autenticacion-chofer` excluyó explícitamente `getLiveFleet` (`GET /api/gps/live`) de su alcance porque ese endpoint pertenece al modelo de autorización de Torre de Control, no al de app móvil. Este spec resuelve ese punto pendiente junto con todos los demás endpoints del panel operativo.

El modelo de identidad elegido es **credencial compartida de equipo** (un único par usuario/contraseña para todo el equipo de logística), consistente con lo que existe hoy. No se implementa login individual por operador — quedaría sobre-ingeniería para el tamaño actual del equipo y puede agregarse en un spec futuro si se necesita auditoría por persona.

La autenticación usa un flujo de dos pasos:
1. `POST /api/operator/login` valida usuario/contraseña y emite un token de sesión firmado con HMAC-SHA256 usando `DASHBOARD_SECRET` (binding nuevo, separado de `JWT_SECRET` de choferes). Expiración: 8 horas (cubre un turno operativo completo).
2. Todos los endpoints de Torre de Control verifican ese token en cada request. El token circula como Bearer en el header `Authorization`; el password del equipo solo viaja en el paso 1.

`DASHBOARD_SECRET` y `JWT_SECRET` son bindings distintos. Un token de chofer no puede usarse para acceder a la Torre de Control, y un token de operador no puede usarse en los endpoints de app móvil.

---

## Glossary

- **Torre_de_Control**: El conjunto de endpoints que exponen datos operativos del negocio — panel HTML, APIs de viajes, dashboards de monitoreo, posición GPS de flota, KPIs financieros.
- **Operador**: Miembro del equipo de logística que accede a la Torre de Control desde un navegador. No es un chofer.
- **Credencial_de_Equipo**: Par único `MONITORING_USERNAME` / `MONITORING_PASSWORD` compartido por todos los operadores. Se verifica en el login; no viaja en requests posteriores.
- **Token_de_Operador**: JWT HS256 firmado con `DASHBOARD_SECRET`. Payload: `{ role: 'operator', tenant_id, exp }`. Expira a las 8 horas. No contiene `rut` ni `chofer_id`.
- **DASHBOARD_SECRET**: Binding de Cloudflare Workers, separado de `JWT_SECRET`. Mínimo 32 bytes. Usado exclusivamente para firmar y verificar Token_de_Operador.
- **JWT_SECRET**: Binding existente, exclusivo para tokens de chofer. No se usa en ningún componente de Torre de Control.
- **verifyOperatorToken**: Función nueva en `src/helpers/operator-auth.js` que verifica la firma, estructura y expiración de un Token_de_Operador. Distinta e intercambiable con `verifyDriverToken`.
- **signOperatorToken**: Función nueva en `src/helpers/operator-auth.js` que emite un Token_de_Operador. Usa el mismo patrón HMAC de `driver-auth.js` pero con payload propio.
- **Bug_Condition**: Cualquier request a un endpoint de Torre de Control que llegue al handler y devuelva datos sin haber verificado un Token_de_Operador válido.

---

## Requirements

### Requirement 1: Login de operador y emisión de token de sesión

**User Story:** Como operador de Torre de Control, quiero iniciar sesión con el usuario y contraseña del equipo para obtener un token de sesión, de modo que el password no viaje en cada request al panel.

#### Acceptance Criteria

1. THE sistema SHALL exponer `POST /api/operator/login` que acepta `{ username, password }` en el body JSON.

2. WHEN `POST /api/operator/login` recibe `username` y `password` que coinciden con `MONITORING_USERNAME` y `MONITORING_PASSWORD` THEN el sistema SHALL responder HTTP 200 con `{ token: "<Token_de_Operador>" }`.

3. WHEN `POST /api/operator/login` recibe credenciales inválidas THEN el sistema SHALL responder HTTP 401 con `{ error: "Credenciales inválidas", code: "credenciales_invalidas" }` sin revelar cuál campo es incorrecto.

4. THE Token_de_Operador SHALL ser un JWT HS256 firmado con `DASHBOARD_SECRET`, con payload `{ role: 'operator', tenant_id, exp }` donde `exp` es 8 horas desde la emisión.

5. THE sistema SHALL verificar las credenciales usando comparación de tiempo constante (`crypto.subtle.verify` con HMAC) para prevenir timing attacks — no con `===` directo sobre strings.

6. WHEN `MONITORING_USERNAME` o `MONITORING_PASSWORD` no están configurados en el entorno THEN el sistema SHALL rechazar todo intento de login con HTTP 503 `{ error: "Servicio no configurado" }` — nunca usar valores por defecto hardcodeados.

7. WHEN `DASHBOARD_SECRET` no está configurado o tiene menos de 32 bytes THEN `signOperatorToken` SHALL lanzar un error en tiempo de ejecución que sea visible en los logs del worker, igual que el comportamiento de `signDriverToken` con `JWT_SECRET`.

8. THE endpoint `POST /api/operator/login` SHALL ser accesible sin autenticación previa (es el emisor de tokens, no puede exigir token para operar).

---

### Requirement 2: Protección de la Torre de Control HTML

**User Story:** Como administrador del sistema, quiero que `/control-tower` requiera un Token_de_Operador válido, para que solo el equipo de logística autenticado pueda ver el panel operativo.

#### Acceptance Criteria

1. WHEN `GET /control-tower` recibe un request sin header `Authorization` THEN el sistema SHALL responder HTTP 401 con header `WWW-Authenticate: Bearer realm="Torre de Control"` en lugar de renderizar el HTML del panel.

2. WHEN `GET /control-tower` recibe `Authorization: Bearer <token>` con un Token_de_Operador válido (firma correcta, no expirado, `role === 'operator'`) THEN el sistema SHALL renderizar el HTML del panel exactamente como hoy — sin cambios en la UI ni en los datos devueltos.

3. WHEN `GET /control-tower` recibe un token expirado THEN el sistema SHALL responder HTTP 401 con `{ code: "token_expirado" }` para que el navegador pueda redirigir al login.

4. WHEN `GET /control-tower` recibe un token con firma inválida o formato incorrecto THEN el sistema SHALL responder HTTP 401 con `{ code: "token_invalido" }`.

5. THE sistema SHALL verificar que el `role` del token sea `'operator'` antes de conceder acceso. Un Token_de_Operador con `role` diferente SHALL ser rechazado con HTTP 403.

6. THE verificación del token SHALL ocurrir como primera operación en el handler, antes de cualquier consulta a la base de datos.

---

### Requirement 3: Protección de las APIs de Torre de Control

**User Story:** Como administrador del sistema, quiero que todas las APIs que sirven datos al panel de Torre de Control requieran Token_de_Operador válido, para que los datos operativos no sean accesibles sin autenticación.

#### Acceptance Criteria

Los siguientes endpoints SHALL requerir Token_de_Operador válido con los mismos criterios del Requirement 2 (401 sin token, 401 token expirado, 401 token inválido, 403 role incorrecto, verificación antes de queries a DB):

1. `GET /api/control-tower-viajes` — datos de viajes activos con detalle de paradas.

2. `GET /api/dashboard/executive` — KPIs financieros y OTIF.

3. `GET /api/dashboard/data` — datos de monitoreo técnico.

4. `GET /api/dashboard/operational` — KPIs operacionales (kg, rutas, camionetas).

5. `GET /api/eta-accuracy/stats` — estadísticas de precisión ETA (contiene datos de choferes y clientes).

6. WHEN cualquiera de estos endpoints recibe un Token_de_Chofer (token válido pero emitido por `signDriverToken` con `JWT_SECRET`) en el header `Authorization` THEN el sistema SHALL rechazar con HTTP 403, porque un token de chofer no es un token de operador aunque su firma sea técnicamente válida con su propio secreto.

---

### Requirement 4: Protección de los dashboards de monitoreo técnico

**User Story:** Como administrador del sistema, quiero que los dashboards de monitoreo técnico (`/dashboard/monitoring`, `/dashboard/executive`, `/dashboard/operaciones`) requieran autenticación, para que las métricas de infraestructura no sean públicas.

#### Acceptance Criteria

1. `GET /dashboard/monitoring` SHALL requerir Token_de_Operador válido con los mismos criterios del Requirement 2.

2. `GET /dashboard/executive` SHALL requerir Token_de_Operador válido.

3. `GET /dashboard/operaciones` SHALL requerir Token_de_Operador válido.

4. WHEN cualquiera de estos endpoints recibe un request sin token THEN el sistema SHALL responder HTTP 401 con header `WWW-Authenticate: Bearer realm="Torre de Control"`.

5. THE endpoint `GET /health` SHALL permanecer público y sin autenticación — es usado por herramientas de monitoreo externas y load balancers.

6. THE endpoint `GET /health/monitoring` SHALL permanecer público — es informacional y no expone datos operativos ni de negocio.

---

### Requirement 5: Protección de getLiveFleet

**User Story:** Como administrador del sistema, quiero que `GET /api/gps/live` requiera autenticación de operador, para que la posición en tiempo real de toda la flota no sea pública.

#### Acceptance Criteria

1. WHEN `GET /api/gps/live` recibe un request sin header `Authorization` THEN el sistema SHALL responder HTTP 401.

2. WHEN `GET /api/gps/live` recibe un Token_de_Operador válido THEN el sistema SHALL devolver la posición de la flota filtrada por `tenant_id`, exactamente como hoy.

3. WHEN `GET /api/gps/live` recibe un Token_de_Chofer (token de `verifyDriverToken`) THEN el sistema SHALL rechazar con HTTP 403 — un chofer autenticado en la app móvil no tiene autorización para ver la posición de toda la flota.

4. THE verificación SHALL ocurrir antes del query a `flota_vehiculos`.

5. THE filtro por `tenant_id` SHALL seguir siendo obligatorio después de la autenticación — la autenticación no reemplaza el aislamiento multi-tenant.

---

### Requirement 6: Comportamiento de la página de login

**User Story:** Como operador, quiero una página de login simple en el navegador para obtener mi token de sesión sin necesidad de herramientas externas.

#### Acceptance Criteria

1. THE sistema SHALL exponer `GET /login` que devuelve una página HTML con formulario de usuario y contraseña.

2. WHEN el operador envía el formulario THEN el cliente JavaScript SHALL hacer `POST /api/operator/login` con las credenciales, recibir el token, guardarlo en `sessionStorage` del navegador y redirigir a `/control-tower`.

3. WHEN cualquier endpoint protegido de Torre de Control devuelve HTTP 401 con `code: "token_expirado"` THEN el JavaScript del cliente en la Torre de Control SHALL redirigir automáticamente a `/login` para re-autenticar.

4. THE página de login SHALL funcionar sin dependencias externas (sin CDNs, sin frameworks) — HTML y JavaScript inline.

5. THE token SHALL guardarse en `sessionStorage` (no `localStorage`) para que expire automáticamente al cerrar la pestaña, reduciendo la ventana de exposición si el operador deja el equipo sin cerrar sesión.

---

### Requirement 7: Separación de secretos y tokens

**User Story:** Como arquitecto del sistema, quiero que los tokens de operador y los tokens de chofer usen secrets distintos y no sean intercambiables, para que una credencial comprometida de un tipo no afecte al otro.

#### Acceptance Criteria

1. THE sistema SHALL usar `DASHBOARD_SECRET` (binding de Cloudflare Workers) exclusivamente para firmar y verificar Token_de_Operador.

2. THE sistema SHALL usar `JWT_SECRET` (binding existente) exclusivamente para firmar y verificar Token_de_Chofer.

3. `signOperatorToken` SHALL importarse desde `src/helpers/operator-auth.js` — nunca desde `src/helpers/driver-auth.js`.

4. `verifyOperatorToken` SHALL importarse desde `src/helpers/operator-auth.js` — nunca desde `src/helpers/driver-auth.js`.

5. WHEN se intenta verificar un Token_de_Chofer con `verifyOperatorToken` (o viceversa) el resultado SHALL ser `{ ok: false }` porque los secrets son distintos y la firma no valida.

6. `operator-auth.js` SHALL NOT importar ninguna función de `driver-auth.js`. Si existe lógica HMAC genérica que ambos necesitan, SHALL extraerse a un helper común (ej. `src/helpers/hmac.js`) y ambos lo importan desde ahí — pero los helpers de autenticación de alto nivel permanecen separados.

7. `DASHBOARD_SECRET` SHALL tener un mínimo de 32 bytes, verificado en tiempo de ejecución igual que `JWT_SECRET` en `driver-auth.js`.

---

### Requirement 8: Rate limiting en el endpoint de login

**User Story:** Como administrador del sistema, quiero que `POST /api/operator/login` limite los intentos fallidos por IP, para que un atacante no pueda probar contraseñas a velocidad ilimitada contra la única puerta de todo el sistema de Torre de Control.

#### Acceptance Criteria

1. THE sistema SHALL aplicar rate limiting a `POST /api/operator/login` con un límite de **10 requests por 15 minutos por dirección IP**.

2. WHEN una IP supera 10 intentos de login en una ventana de 15 minutos THEN el sistema SHALL responder HTTP 429 con header `Retry-After` indicando los segundos hasta que se resetea la ventana.

3. THE rate limit SHALL aplicarse antes de verificar las credenciales — incluso un intento con credenciales correctas cuenta contra el límite una vez que la IP lo ha excedido.

4. THE implementación SHALL reutilizar `checkRateLimit` de `src/monitoring/rate-limiter.js` con los parámetros `(ip, '/api/operator/login', 10, 900000)` (900 000 ms = 15 minutos).

5. THE sistema SHALL extraer la IP del request usando `CF-Connecting-IP` como fuente primaria (confiable dentro de Cloudflare Workers), con fallback a `X-Forwarded-For` y finalmente `'unknown'`.

6. **Limitación documentada:** El rate limiter de `rate-limiter.js` es en memoria por-isolate. En un deployment con múltiples isolates activos simultáneamente, el límite efectivo puede ser hasta `N × 10` intentos donde N es el número de isolates. Esto no invalida el requirement — eleva el umbral de ataque de "script automatizado sin coordinación" a "ataque distribuido coordinado", que no es el modelo de amenaza realista para este sistema en su escala actual. El requirement no garantiza bloqueo absoluto sino mitigación significativa con la infraestructura existente. Si en el futuro se requiere un contador global compartido, se evaluará Cloudflare Durable Objects como mejora separada.

7. WHEN el rate limit no está activo para una IP (primeros intentos en la ventana) THEN el comportamiento del endpoint SHALL ser idéntico al descrito en Requirement 1 — el rate limiting no modifica la lógica de login en el camino feliz.

8. THE respuesta HTTP 429 SHALL incluir `{ error: "Demasiados intentos", code: "rate_limit_excedido", retry_after_seconds: N }` para que el cliente JavaScript de la página de login pueda mostrar un mensaje útil al operador.

---

### Requirement 9: Comportamiento preservado (Regression Prevention)

**User Story:** Como operador, quiero que agregar autenticación no cambie ningún dato ni funcionalidad de la Torre de Control para usuarios ya autenticados.

#### Acceptance Criteria

1. WHEN un operador con Token_de_Operador válido accede a `/control-tower` THEN el sistema SHALL CONTINUE TO devolver exactamente el mismo HTML con todos los viajes, órdenes, choferes y datos que devuelve hoy.

2. WHEN un operador con Token_de_Operador válido consulta `/api/control-tower-viajes` THEN el sistema SHALL CONTINUE TO devolver los viajes activos con detalle de paradas en el mismo formato JSON que hoy.

3. WHEN un chofer autenticado envía pings GPS a `POST /api/gps/ping` THEN el sistema SHALL CONTINUE TO procesar el ping normalmente — este endpoint usa `verifyDriverToken` y no debe ser afectado por este spec.

4. WHEN cualquier endpoint de app móvil de chofer (`/api/choferes/login`, `/api/chofer/evento`, `/api/app-chofer-rutas`, etc.) recibe un request THEN el sistema SHALL CONTINUE TO funcionar exactamente como después del bugfix de autenticacion-chofer — sin ningún cambio.

5. THE aislamiento multi-tenant (`tenant_id` obligatorio en todas las queries) SHALL CONTINUE TO aplicarse en todos los endpoints de Torre de Control después de agregar autenticación.

6. `GET /health` y `GET /health/monitoring` SHALL CONTINUE TO ser públicos y responder sin autenticación.
