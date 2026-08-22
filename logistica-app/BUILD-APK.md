# APK de Logistica App

La app chofer ya puede compilarse con `EAS Build`.

## Perfiles

- `preview-staging`: genera un `APK` instalable apuntando a staging.
- `preview-production`: genera un `APK` instalable apuntando a producción.
- `production`: genera un `AAB` para Play Store.

## Requisitos

1. Tener Node.js y dependencias instaladas:
   ```bash
   npm install
   ```
2. Tener cuenta Expo y sesión iniciada:
   ```bash
   npx eas login
   ```
3. Pararse en `logistica-app`.

## Comandos

### APK staging

```bash
npm run apk:staging
```

### APK producción

```bash
npm run apk:prod
```

### AAB Play Store

```bash
npm run aab:prod
```

## Resultado

Cuando termina el build, Expo entrega una URL para descargar el archivo.
Esa URL se puede abrir en el celular o compartir por WhatsApp para instalar el APK interno.

## Datos demo chofer

Para la app chofer el login usa:

- `tenant_id`
- `rut`
- `pin`

El `tenant_id` demo actual es `empresa_base`.

## Nota importante

El APK queda apuntando al Worker definido en `eas.json` via `EXPO_PUBLIC_API_URL`.
Si quieres una build demo distinta, crea otro perfil con otra URL.
