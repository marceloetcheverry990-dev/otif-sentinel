# Requirements Document

## Introduction

La funcionalidad **Ruta Espontánea / Ruta Rápida Manual** permite a los operadores de la Torre de Control crear y despachar rutas de entrega urgentes con datos mínimos, sin pasar por el flujo normal de sincronización de Excel o WMS. El caso de uso central son entregas de improviso: muestras de producto, clientes nuevos que aún no existen en el sistema, o despachos urgentes donde solo se conoce el nombre del destinatario y la dirección. La OT formal y el valor comercial pueden completarse después, mientras el chofer ya está en ruta.

El sistema genera identificadores temporales con prefijo `SPOT-`, geocodifica las direcciones con Mapbox, optimiza el orden de paradas y despacha la ruta al chofer por Telegram — todo desde el mismo flujo de la Torre de Control existente.

---

## Glossary

- **Ruta_Espontánea**: Una ruta creada manualmente por el operador con datos mínimos, sin importación previa desde Excel o WMS.
- **OT_Espontánea**: Orden de trabajo creada dentro de una Ruta Espontánea, identificada con el prefijo `SPOT-` seguido de un UUID corto.
- **Parada**: Una entrega individual dentro de una Ruta Espontánea, definida por nombre de cliente, dirección y descripción opcional del bulto.
- **PENDIENTE_CARGA**: Estado operacional que indica que la ruta fue creada pero el camión aún no ha sido cargado y no puede despacharse.
- **EN_RUTA**: Estado operacional que indica que el chofer ya recibió la ruta y está realizando entregas.
- **Torre_de_Control**: Interfaz web en `/control-tower` donde los operadores monitorean y gestionan todas las rutas y órdenes.
- **Chofer**: Conductor registrado en la tabla `choferes` con estado `DISPONIBLE`.
- **Geocodificador**: Servicio de Mapbox utilizado para convertir una dirección textual en coordenadas geográficas (latitud/longitud).
- **Optimizador**: Módulo existente (`optimizer.js`) que calcula el orden óptimo de paradas usando el algoritmo VRP y la API de Mapbox Directions.
- **SLA**: Hora límite de entrega (Service Level Agreement). En Rutas Espontáneas es opcional.
- **Operador**: Usuario de la Torre de Control que crea y gestiona rutas.
- **Sistema**: El worker de Cloudflare que implementa OTIF Sentinel.
- **Formulario**: El modal de creación de Ruta Espontánea en la Torre de Control.
- **Mensaje_Telegram**: Notificación enviada al chofer vía bot de Telegram.

---

## Requirements

### Requirement 1

**User Story:** Como operador de la Torre de Control, quiero un botón visible y accesible para iniciar una Ruta Espontánea, para poder despachar entregas urgentes sin interrumpir el flujo normal de trabajo.

#### Acceptance Criteria

1. THE Torre_de_Control SHALL mostrar un botón "Nueva Ruta Rápida" en la interfaz principal de `/control-tower`.
2. WHEN el operador hace clic en "Nueva Ruta Rápida", THE Torre_de_Control SHALL abrir un formulario modal de creación de Ruta Espontánea sin abandonar la página de la Torre de Control.
3. THE Torre_de_Control SHALL mostrar el botón "Nueva Ruta Rápida" en todo momento, independientemente de si existen rutas activas.

---

### Requirement 2

**User Story:** Como operador, quiero ingresar múltiples paradas con solo nombre del cliente y dirección, para crear y despachar una ruta urgente en el menor tiempo posible.

#### Acceptance Criteria

1. WHEN el Formulario de Ruta Espontánea está abierto, THE Formulario SHALL permitir agregar al menos una parada con los campos: nombre del cliente (obligatorio), dirección completa (obligatoria) y descripción del bulto (opcional).
2. THE Formulario SHALL permitir agregar dinámicamente entre 1 y 24 paradas por ruta.
3. THE Formulario SHALL permitir eliminar cualquier parada individual antes de confirmar la creación.
4. THE Formulario SHALL presentar un selector de chofer mostrando únicamente los choferes con estado `DISPONIBLE` del mismo `tenant_id`.
5. THE Formulario SHALL incluir un campo binario "¿El camión ya está cargado?" con las opciones Sí y No.
6. THE Formulario SHALL incluir un campo opcional para hora límite de entrega (SLA) en formato HH:MM para el día en curso.
7. IF el operador intenta confirmar la creación sin al menos una parada con nombre de cliente y dirección, THEN THE Formulario SHALL mostrar un mensaje de error de validación e impedir el envío.
8. IF el operador intenta confirmar la creación sin haber seleccionado un chofer, THEN THE Formulario SHALL mostrar un mensaje de error de validación e impedir el envío.

---

### Requirement 3

**User Story:** Como operador, quiero que el sistema genere identificadores de orden automáticamente, para no tener que esperar la OT formal del sistema de gestión comercial.

#### Acceptance Criteria

1. WHEN el operador confirma la creación de una Ruta Espontánea, THE Sistema SHALL generar un `ot_id` único por parada con el formato `SPOT-{ALFANUMERICO}`, donde `ALFANUMERICO` es una cadena de al menos 8 caracteres.
2. THE Sistema SHALL garantizar que cada `ot_id` con prefijo `SPOT-` sea único dentro del mismo `tenant_id`.
3. THE Sistema SHALL insertar cada OT_Espontánea en la tabla `ordenes_pendientes` con todos los campos disponibles en el momento de la creación, incluyendo `tenant_id`, `chofer_asignado_id`, `trip_id` y `stop_sequence`.

---

### Requirement 4

**User Story:** Como operador, quiero que el sistema obtenga automáticamente las coordenadas de las direcciones ingresadas, para no tener que buscarlas manualmente ni pre-registrar el cliente.

#### Acceptance Criteria

1. WHEN se procesa una Ruta Espontánea, THE Geocodificador SHALL llamar a la API de Mapbox Geocoding para cada dirección ingresada.
2. WHEN la API de Mapbox retorna coordenadas válidas, THE Geocodificador SHALL almacenar la latitud y longitud resultantes en el registro de la OT correspondiente.
3. IF la API de Mapbox no puede geocodificar una dirección, THEN THE Sistema SHALL marcar esa parada con un estado de error de geocodificación y notificar al operador con el detalle de qué dirección falló, sin cancelar el resto de la ruta.
4. THE Geocodificador SHALL utilizar el token `MAPBOX_TOKEN` ya configurado en el entorno del worker, sin requerir configuración adicional.

---

### Requirement 5

**User Story:** Como operador, quiero que el sistema ordene automáticamente las paradas de forma eficiente, para que el chofer recorra la menor distancia posible.

#### Acceptance Criteria

1. WHEN todas las paradas de una Ruta Espontánea han sido geocodificadas, THE Optimizador SHALL calcular el orden óptimo de visita usando la API de Mapbox Directions.
2. THE Optimizador SHALL asignar un valor secuencial `stop_sequence` a cada parada comenzando desde 1, según el orden calculado.
3. WHEN el SLA fue especificado por el operador, THE Optimizador SHALL considerar la hora límite como factor de urgencia al ordenar las paradas.
4. IF la API de Mapbox Directions no está disponible, THEN THE Optimizador SHALL calcular el orden usando distancia geodésica (fórmula haversine) como método de respaldo.

---

### Requirement 6

**User Story:** Como operador, quiero controlar si el camión ya está cargado antes de enviar la ruta al chofer, para evitar que el chofer reciba instrucciones antes de que el vehículo esté listo.

#### Acceptance Criteria

1. WHEN el operador confirma la Ruta Espontánea con "¿El camión ya está cargado?" = Sí, THE Sistema SHALL asignar el estado `EN_RUTA` a todas las OTs de la ruta y enviar la ruta al chofer por Telegram de forma inmediata.
2. WHEN el operador confirma la Ruta Espontánea con "¿El camión ya está cargado?" = No, THE Sistema SHALL asignar el estado `PENDIENTE_CARGA` a todas las OTs de la ruta y omitir el envío por Telegram.
3. WHILE una Ruta Espontánea tiene OTs en estado `PENDIENTE_CARGA`, THE Torre_de_Control SHALL mostrar el botón "Confirmar carga y despachar" sobre esa ruta.
4. WHEN el operador hace clic en "Confirmar carga y despachar", THE Sistema SHALL actualizar el estado de todas las OTs de la ruta de `PENDIENTE_CARGA` a `EN_RUTA` y enviar la ruta al chofer por Telegram.
5. THE Sistema SHALL asignar el `trip_id` y el `chofer_asignado_id` a todas las OTs de la ruta en el momento de la creación, independientemente del estado de carga.

---

### Requirement 7

**User Story:** Como chofer, quiero recibir las paradas de una Ruta Espontánea por Telegram igual que las rutas normales, para no tener que aprender una nueva interfaz.

#### Acceptance Criteria

1. WHEN se despacha una Ruta Espontánea con estado `EN_RUTA`, THE Sistema SHALL enviar al chofer por Telegram el mismo formato de mensaje de ruta que para rutas normales, con listado de paradas y botones interactivos.
2. THE Mensaje_Telegram SHALL incluir para cada parada: nombre del cliente, dirección y número de secuencia (`stop_sequence`).
3. THE Sistema SHALL utilizar el `chofer_asignado_id` de la ruta como `chat_id` de Telegram, igual que en el flujo de rutas normales.
4. WHEN el chofer reporta ENTREGADO o RECHAZADO desde Telegram, THE Sistema SHALL actualizar el estado de la OT_Espontánea correspondiente con la misma lógica de transición de estados que para OTs normales.

---

### Requirement 8

**User Story:** Como operador, quiero ver las Rutas Espontáneas en la Torre de Control junto con las rutas normales, para tener una visión unificada de todas las operaciones del día.

#### Acceptance Criteria

1. THE Torre_de_Control SHALL mostrar las OTs con prefijo `SPOT-` en la misma vista de viajes y órdenes que las OTs normales.
2. THE Torre_de_Control SHALL mostrar un indicador visual (badge o etiqueta "SPOT") en cada OT_Espontánea para distinguirlas de las OTs formales.
3. WHEN el estado de una OT_Espontánea cambia, THE Torre_de_Control SHALL reflejar el cambio en la vista con el mismo mecanismo de actualización que las OTs normales.
4. THE Torre_de_Control SHALL mostrar el botón "Confirmar carga y despachar" únicamente para los viajes que contengan OTs en estado `PENDIENTE_CARGA`.

---

### Requirement 9

**User Story:** Como operador, quiero poder completar el valor de la entrega y reemplazar el OT ID temporal por el formal en cualquier momento posterior, para mantener la trazabilidad financiera sin bloquear el despacho.

#### Acceptance Criteria

1. THE Torre_de_Control SHALL mostrar campos editables de "Valor de entrega" y "OT ID formal" en el detalle de cada OT_Espontánea.
2. WHEN el operador ingresa un OT ID formal para reemplazar el ID temporal, THE Sistema SHALL actualizar el `ot_id` en la base de datos y registrar el `ot_id` original en el campo `metadata` de la orden.
3. WHEN el operador ingresa el valor de una entrega, THE Sistema SHALL actualizar el campo de valor comercial de esa OT en la base de datos.
4. THE Sistema SHALL permitir la actualización de datos formales independientemente del estado operacional de la OT.
5. IF el operador intenta asignar un OT ID formal que ya existe para el mismo `tenant_id`, THEN THE Sistema SHALL rechazar la operación con un código HTTP 409 y un mensaje de error de conflicto.

---

### Requirement 10

**User Story:** Como administrador del sistema, quiero que las Rutas Espontáneas respeten el aislamiento multi-tenant, para garantizar que los datos de un cliente no sean visibles ni accesibles para otro.

#### Acceptance Criteria

1. THE Sistema SHALL incluir el `tenant_id` en todos los registros creados por la funcionalidad de Ruta Espontánea, incluyendo registros en `ordenes_pendientes` y en `transaction_logs`.
2. IF una solicitud de creación de Ruta Espontánea no incluye un `tenant_id` válido, THEN THE Sistema SHALL rechazarla con un código de estado HTTP 403.
3. THE Sistema SHALL validar que el chofer seleccionado pertenezca al mismo `tenant_id` antes de asignarlo a la ruta.
4. THE Sistema SHALL filtrar todos los accesos a datos de OTs Espontáneas por `tenant_id`, igual que el resto de los endpoints del sistema.
