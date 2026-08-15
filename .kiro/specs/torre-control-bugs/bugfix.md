# Bugfix Requirements Document

## Introduction

Este documento describe tres bugs identificados en la Torre de Control del sistema logístico (Cloudflare Worker). Los bugs afectan la visibilidad de paradas en tiempo real, la disponibilidad de choferes en el modal de Ruta Rápida, y la estabilidad del widget de IA cuando no hay riesgos SLA activos.

---

## Bug 1: Paradas desaparecen de la Torre de Control después de ~5 segundos

### Bug Analysis

#### Current Behavior (Defect)

1.1 CUANDO una parada tiene estado `PENDIENTE_RUTEO` o `CAMION_ASIGNADO` Y el live polling de viajes (ejecutado cada 5 segundos) actualiza el panel ENTONCES el sistema re-renderiza el panel y las paradas con esos estados desaparecen de la lista.

1.2 CUANDO `actualizarViajesSilencioso` recibe los viajes desde `/api/control-tower-viajes` ENTONCES el sistema reemplaza el contenido de `#panel-flota` con el resultado de `window.renderPanelFlota(data.viajes)` sin incluir las paradas cuyo `trip_id` no forma parte de ningún viaje activo.

#### Expected Behavior (Correct)

2.1 CUANDO una parada tiene estado `PENDIENTE_RUTEO` o `CAMION_ASIGNADO` ENTONCES el sistema SHALL mantenerla visible en el panel de la Torre de Control hasta que su estado cambie a uno terminal (`ENTREGADO`, `RECHAZADO`, `CANCELADO_PLANILLA`, `RETORNO_BODEGA`).

2.2 CUANDO `actualizarViajesSilencioso` actualiza el panel ENTONCES el sistema SHALL preservar la visibilidad de las paradas con estados activos y no eliminarlas del DOM entre ciclos de polling.

#### Unchanged Behavior (Regression Prevention)

3.1 CUANDO una parada tiene estado `ENTREGADO` o `RECHAZADO` ENTONCES el sistema SHALL CONTINUE TO ocultarla o excluirla del panel activo una vez completado el viaje.

3.2 CUANDO el polling actualiza el panel con viajes activos que tienen paradas `EN_RUTA` ENTONCES el sistema SHALL CONTINUE TO re-renderizar esas paradas correctamente con su estado actualizado.

3.3 CUANDO el usuario tiene un viaje expandido (activo) en el panel ENTONCES el sistema SHALL CONTINUE TO restaurar el estado expandido (`appState.activeTripId`) después de cada ciclo de polling.

---

## Bug 2: Modal de Ruta Rápida no muestra todos los choferes disponibles

### Bug Analysis

#### Current Behavior (Defect)

1.3 CUANDO el usuario abre el modal de Ruta Rápida mediante `abrirRutaRapida()` ENTONCES el sistema llena el `<select id="rrChofer">` usando `window._listaChoferes`, que fue inyectado al cargar la página inicial desde el servidor.

1.4 CUANDO `window._listaChoferes` fue cargado en el momento del render inicial de la página Y desde entonces nuevos choferes han sido dados de alta o cambiado de estado ENTONCES el sistema muestra una lista desactualizada que no refleja los choferes actualmente disponibles.

1.5 CUANDO la query SQL en `renderControlTower` filtra choferes con `estado IN ('DISPONIBLE', 'OCUPADO')` Y en el modal se presentan todos los de esa lista sin distinción adicional ENTONCES los choferes con estado `OCUPADO` aparecen en la lista con el label `[EN RUTA]`, pero choferes recién incorporados o liberados después del carga inicial no aparecen.

#### Expected Behavior (Correct)

2.3 CUANDO el usuario abre el modal de Ruta Rápida ENTONCES el sistema SHALL consultar la lista de choferes en tiempo real al momento de apertura del modal, reflejando el estado actual de disponibilidad.

2.4 CUANDO la lista de choferes se carga en el modal ENTONCES el sistema SHALL mostrar todos los choferes con estado `DISPONIBLE` u `OCUPADO` según el estado actual en la base de datos, no según el snapshot del render inicial.

#### Unchanged Behavior (Regression Prevention)

3.4 CUANDO el usuario selecciona un chofer del modal y envía la ruta ENTONCES el sistema SHALL CONTINUE TO crear la ruta correctamente con el `chofer_id` seleccionado.

3.5 CUANDO un chofer tiene estado `OCUPADO` ENTONCES el sistema SHALL CONTINUE TO mostrarlo con el label `[EN RUTA]` para advertir al operador.

3.6 CUANDO el modal se abre y la llamada de red para obtener choferes falla ENTONCES el sistema SHALL CONTINUE TO mostrar al menos la lista cacheada (`window._listaChoferes`) como fallback para no bloquear al operador.

---

## Bug 3: TypeError: null addEventListener en ai-copilot-widget

### Bug Analysis

#### Current Behavior (Defect)

1.6 CUANDO no hay riesgos SLA activos (`riesgosSla.length === 0`) ENTONCES el sistema omite la inyección del HTML del widget `#ai-copilot-widget` en el DOM del servidor (el bloque condicional `${riesgosSla.length > 0 ? ... : ''}` devuelve cadena vacía).

1.7 CUANDO el bloque `DOMContentLoaded` se ejecuta en el cliente Y el elemento `#ai-copilot-widget` no existe en el DOM ENTONCES el sistema lanza `TypeError: Cannot read properties of null (reading 'addEventListener')` al intentar ejecutar `document.getElementById('ai-copilot-widget').classList.toggle(...)` o `document.getElementById('ai-widget-toggle').addEventListener(...)`.

#### Expected Behavior (Correct)

2.5 CUANDO no hay riesgos SLA activos Y el bloque de inicialización del widget se ejecuta ENTONCES el sistema SHALL verificar la existencia del elemento `#ai-copilot-widget` antes de intentar acceder a sus propiedades, sin lanzar ningún error.

2.6 CUANDO `document.getElementById('ai-copilot-widget')` retorna `null` ENTONCES el sistema SHALL omitir silenciosamente el registro de event listeners del widget sin interrumpir la inicialización del resto de la interfaz.

#### Unchanged Behavior (Regression Prevention)

3.7 CUANDO hay al menos un riesgo SLA activo Y el widget `#ai-copilot-widget` está presente en el DOM ENTONCES el sistema SHALL CONTINUE TO registrar el listener de colapso/expansión en `#ai-widget-toggle` y el listener del botón `#btn-ai-action` correctamente.

3.8 CUANDO el usuario hace click en el header del widget con riesgos activos ENTONCES el sistema SHALL CONTINUE TO alternar la clase `collapsed` y cambiar el ícono de toggle correctamente.

3.9 CUANDO se inicializa la Torre de Control sin riesgos SLA ENTONCES el sistema SHALL CONTINUE TO cargar el mapa, el panel de flota, las tabs y todos los demás componentes sin verse afectados por el error del widget.
