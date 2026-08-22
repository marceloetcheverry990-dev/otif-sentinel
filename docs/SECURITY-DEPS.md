# Dependencias y excepciones de seguridad (R7)

## Worker (`lead-rescue-worker`)

- **Producción (`npm audit --omit=dev`)**: 0 vulnerabilidades.
- **`xlsx` eliminado**: ACEPTA ahora solo acepta CSV (`Folio`, `Monto_Total`, `Uri`). Motivo: SheetJS community no tiene parche para prototype pollution / ReDoS.
- Restantes en **devDependencies** (vitest/wrangler/miniflare/undici/esbuild): tooling local y CI; no se empaquetan en el Worker desplegado.

## App móvil (`logistica-app`)

- Override de `ws` a `^8.18.3`.
- Axios actualizado vía `npm audit fix` (sin breaking changes).
- Quedan **moderadas** en la cadena Expo SDK 54 (`postcss`, `uuid` vía `@expo/*`) que requieren upgrade mayor a Expo 57; documentadas y no bloquean el audit `critical` de CI.

## CI

`.github/workflows/ci.yml` corre:

1. Audit de producción del Worker (high+)
2. Suite `test:security` del Worker
3. Typecheck de la app móvil
4. Gitleaks
