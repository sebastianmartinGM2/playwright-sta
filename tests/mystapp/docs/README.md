# Mystapp – flujo de login + stress (Playwright)

Este folder implementa un flujo reusable de **login** para una app a definir ("mystapp"), y un test de **stress básico** que hace login concurrente de N usuarios.

La idea es que el login sea un “building block” para tests futuros (por ejemplo: navegar a dashboard, comprar, etc.).

## Qué hay acá

- `helpers.ts`
  - `mystappLogin(page, user)` → hace login y devuelve métricas.
  - `requireMystappUsers(count)` → arma la lista de usuarios desde env vars.
  - overrides de selectores y umbrales.
- `auth.setup.ts`
  - Loguea N usuarios y genera `storageState` por usuario.
- `login.stress.spec.ts`
  - Corre N logins concurrentes y opcionalmente falla si se exceden umbrales.

## Requisitos

- Node 18+
- Playwright instalado (ver README raíz)

## Configuración (env vars)

Tip (recomendado): creá un archivo `.env` en la raíz del repo (está en `.gitignore`).
El runner lo carga automáticamente, así podés correr los tests “en masa” sin pasar credenciales por parámetros.

Alternativa (más simple todavía): usá `.mystapp.local.json` (también está en `.gitignore`).
Esto evita depender de env vars.

```bash
cp .mystapp.local.example.json .mystapp.local.json
```

Ejemplo:

```bash
cp .env.example .env
```

### URL (obligatorio)

- `MYSTAPP_BASE_URL` (obligatorio)
  - Ej (QA): `https://qa.mystaapp.com`

Nota: si no seteás `MYSTAPP_BASE_URL`, el proyecto `mystapp-*` usa QA por default desde `playwright.config.ts`.

Nota 2: si seteás `baseURL` en `.mystapp.local.json`, también lo toma como default.

### Usuarios (elegí 1 de estas opciones)

**Opción A (lista explícita):**

- `MYSTAPP_USERS` = lista de usernames separados por coma
- `MYSTAPP_PASSWORD` = password compartida

Ej:

```bash
export MYSTAPP_BASE_URL="https://qa.mystaapp.com"
export MYSTAPP_USERS_COUNT="1"
export MYSTAPP_USERS="804"
export MYSTAPP_PASSWORD="<tu_clave>"
```

**Opción A0 (un solo usuario):**

- `MYSTAPP_USER` = username único
- `MYSTAPP_PASSWORD` = password

Opcional:

- `MYSTAPP_REUSE_SINGLE_USER=1` → permite pedir N usuarios y reutilizar el mismo username/password en múltiples sesiones paralelas (útil si solo tenés 1 usuario).

Ej:

```bash
export MYSTAPP_USER="804"
export MYSTAPP_PASSWORD="<tu_clave>"
export MYSTAPP_REUSE_SINGLE_USER=1
```

**Opción Local (sin env vars):**

En `.mystapp.local.json`:

```json
{
  "baseURL": "https://qa.mystaapp.com",
  "user": "804",
  "password": "<tu_clave>"
}
```

**Opción B (generación por prefijo):**

- `MYSTAPP_USER_PREFIX`
- `MYSTAPP_PASSWORD`

Genera: `PREFIX01..PREFIX10` por default.

Ej:

```bash
export MYSTAPP_BASE_URL="https://qa.mystaapp.com"
export MYSTAPP_USERS_COUNT="10"
export MYSTAPP_USER_PREFIX="user"
export MYSTAPP_PASSWORD="<tu_clave>"
```

### Rutas y selectores (si el default no matchea)

Por defecto el helper navega a `/login` y busca campos/botón por label/placeholder/role.

Podés overridear:

- `MYSTAPP_LOGIN_PATH` (default: `/login`)
- `MYSTAPP_USERNAME_SELECTOR` (CSS selector)
- `MYSTAPP_PASSWORD_SELECTOR` (CSS selector)
- `MYSTAPP_SUBMIT_SELECTOR` (CSS selector)

Ej:

```bash
export MYSTAPP_LOGIN_PATH="/auth/login"
export MYSTAPP_USERNAME_SELECTOR="input[name='email']"
export MYSTAPP_PASSWORD_SELECTOR="input[name='password']"
export MYSTAPP_SUBMIT_SELECTOR="button[type='submit']"
```

### Concurrencia / cantidad

- `MYSTAPP_USERS_COUNT` (default: `10`)
- `MYSTAPP_LOGIN_CONCURRENCY`
  - en `auth.setup.ts` default `5`
  - en `login.stress.spec.ts` default `10`

### Métricas de “tiempo de respuesta” (API)

Si querés medir tiempo del request HTTP real de login:

- `MYSTAPP_LOGIN_API_URL_REGEX`
  - Es un string que se compila a `RegExp`.
  - Ej: `/api/auth/login|/oauth/token`

Nota: es **opcional**. Si no hay match, el test igual corre y simplemente no reporta `apiMs`.

### Umbrales (SLO) para fallar el stress test

Estas variables hacen que el stress test falle si los tiempos se pasan:

- `MYSTAPP_MAX_LOGIN_MS` (máximo observado)
- `MYSTAPP_MAX_P95_LOGIN_MS`
- `MYSTAPP_MAX_P99_LOGIN_MS`

Ej:

```bash
export MYSTAPP_MAX_P95_LOGIN_MS=2000
export MYSTAPP_MAX_P99_LOGIN_MS=4000
export MYSTAPP_MAX_LOGIN_MS=6000
```

## Cómo correr

### 1) Generar storageState por usuario (setup)

Esto crea los archivos:

- `.auth/mystapp/user-01.json`
- `.auth/mystapp/user-02.json`
- ...

Comando:

```bash
npm run test:mystapp:setup
```

Qué se espera que pase:

- Debe loguear `MYSTAPP_USERS_COUNT` usuarios.
- Deben generarse N archivos de storageState.

Qué NO debería pasar:

- Quedarse en la pantalla de login después de submit.
- Falla por no encontrar campos/botón (si pasa, definí selectores con env vars).

### 2) Stress login (solo login)

```bash
npm run test:mystapp -- --grep @stress
```

Qué se espera que pase:

- Ejecuta N logins (con contexts aislados).
- Reporta percentiles p50/p90/p95/p99 y max en las annotations del test.
- Si seteaste umbrales, el test falla cuando se exceden.

### 3) Invoices (login + click en ícono + búsqueda por fechas)

Este test hace:

- login
- en el Home/Dashboard hace click en el **ícono/tile de Invoices**
- busca por rango de fechas (default: `02/01/2025` → `02/09/2026`)
- adjunta un screenshot al reporte

Para “verlo” corriendo (browser visible):

```bash
PW_SLOW_MO=250 npm run test:mystapp -- --grep @invoices --headed
```

Opcional (overrides útiles):

- `MYSTAPP_INVOICES_FROM_DATE` (default: `02/01/2025`)
- `MYSTAPP_INVOICES_TO_DATE` (default: `02/09/2026`)
- `MYSTAPP_DATE_FORMAT` (default: `DD/MM/YYYY`, alternativa: `MM/DD/YYYY`)
- `MYSTAPP_INVOICES_TILE_SELECTOR` (si el tile no es `a[href*="/invoices"]`)
- `MYSTAPP_INVOICES_FROM_SELECTOR`
- `MYSTAPP_INVOICES_TO_SELECTOR`
- `MYSTAPP_INVOICES_RANGE_SELECTOR` (si es un solo input tipo “rango”)
- `MYSTAPP_INVOICES_SEARCH_SELECTOR`
- `MYSTAPP_INVOICES_RESULTS_SELECTOR`

## Troubleshooting

- Si no encuentra los campos de login: seteá `MYSTAPP_*_SELECTOR`.
- Si la app no navega fuera de `/login` después de submit:
  - puede ser un SPA que no cambia URL → en ese caso conviene ajustar el “success heuristic” en `mystappLogin` para validar un elemento de logged-in.
- Si hay rate limiting: bajá `MYSTAPP_LOGIN_CONCURRENCY`.

## Próximo paso sugerido

Cuando tengas definido el login “correcto” (endpoint + elemento visible post-login), conviene:

- capturar el API timing con `MYSTAPP_LOGIN_API_URL_REGEX` real
- reemplazar el heuristic de URL por un `expect` a un elemento post-login (ej: avatar, logout, dashboard)
