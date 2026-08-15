# R8.3 — Checklist móvil (dispositivo real)

Completar en Android (iOS si hay dispositivo) contra el Worker objetivo  
(staging primero, luego prod tras canary).

Marcar cada ítem al verificarlo.

## Precondiciones

- [ ] App `logistica-app` build de desarrollo instalada
- [ ] API base apunta al Worker bajo prueba
- [ ] Chofer de prueba con PIN válido en el tenant

## Casos

| # | Caso | Pasos | Esperado | OK |
|---|------|-------|----------|----|
| 1 | Login | Activar/login con RUT+PIN | Entra a Home con viajes | [ ] |
| 2 | GPS on | Tras login conceder ubicación “todo el tiempo” | Notificación foreground “Logística Activa”; Torre ve pings si hay viaje activo | [ ] |
| 3 | Rutas | Abrir viaje / paradas | Lista coherente con Torre | [ ] |
| 4 | Logout detiene GPS | Logout desde app | Desaparece notificación FG; `stopLocationUpdatesAsync`; Torre deja de recibir pings nuevos | [ ] |
| 5 | Cola offline no cruza usuarios | Offline: encolar acción; logout; login otro chofer | Cola del primero no se envía como el segundo (purge/ownerRut) | [ ] |
| 6 | Evidencia auth | Intentar upload sin sesión / con sesión | Sin sesión falla; con sesión sube a evidencias | [ ] |
| 7 | 401 cierra sesión | Forzar token inválido o expirado en request autenticado | App hace logout / vuelve a Login | [ ] |

## Notas

- R8.3 **no bloquea** canary del Worker si R8.2 está verde.
- R8.3 **sí bloquea** retirar Cloudflare Access (R8.6) salvo aceptación explícita de riesgo.

## Resultado

- Fecha: _______________
- Dispositivo / OS: _______________
- Worker URL: _______________
- Firma / responsable: _______________
- ¿Access puede retirarse? Sí / No (circulo)
