# Mystapp – comandos útiles (Playwright)

Este archivo es una “chuleta” de comandos para correr los specs de Mystapp, ajustar concurrencia (workers), correr en loop y habilitar captura de red (fetch/xhr).

> Nota: estos comandos asumen que estás parado en la raíz del repo.

## Usar múltiples perfiles `.env`

Este repo carga variables con `dotenv` desde `playwright.config.ts`. Para elegir *qué archivo* cargar en cada corrida, usá `DOTENV_CONFIG_PATH`.

Templates listos para copiar:

- `env/mystapp-service-vehicles.env.example`
- `env/mystapp-invoices.env.example`
- `env/mystapp-stress-login.env.example`

Ejemplo (Service Vehicles):

```bash
cp env/mystapp-service-vehicles.env.example env/mystapp-service-vehicles.env
DOTENV_CONFIG_PATH=env/mystapp-service-vehicles.env npm run test:mystapp:service-vehicles
```

Ejemplo (Invoices):

```bash
cp env/mystapp-invoices.env.example env/mystapp-invoices.env
DOTENV_CONFIG_PATH=env/mystapp-invoices.env npm run test:mystapp:invoices
```

---

## 1) Reporte HTML

Abrir el último reporte:

```bash
npx playwright show-report
```

---

## 2) Correr specs de Mystapp

### Service Vehicles

```bash
npm run test:mystapp:service-vehicles
```

Fecha start (default `02/01/2025`):

```bash
MYSTAPP_SERVICE_VEHICLES_START_DATE="02/01/2025" npm run test:mystapp:service-vehicles
```

Con credenciales por env vars (ejemplo):

```bash
MYSTAPP_USER=804 MYSTAPP_PASSWORD=999753 npm run test:mystapp:service-vehicles
```

### Invoices

Script dedicado:

```bash
npm run test:mystapp:invoices
```

Fechas (defaults: `MYSTAPP_INVOICES_FROM_DATE=02/01/2025`, `MYSTAPP_INVOICES_TO_DATE` opcional):

```bash
MYSTAPP_INVOICES_FROM_DATE="02/01/2025" MYSTAPP_INVOICES_TO_DATE="02/13/2026" npm run test:mystapp:invoices
```

Alternativa (directo con Playwright):

```bash
npx playwright test tests/mystapp/invoices.spec.ts --project mystapp-chromium
```

Concurrencia (1 test por usuario):

```bash
MYSTAPP_INVOICES_USERS=20 MYSTAPP_WORKERS=20 npm run test:mystapp:invoices
```

---

## 3) Correr en loop infinito (hasta cortar manualmente)

### Loop simple

```bash
while true; do npx playwright test tests/mystapp/service-vehicles.spec.ts --project mystapp-chromium; done
```

Cortar con `Ctrl+C`.

### Loop con pausa entre iteraciones

```bash
while true; do 
  npx playwright test tests/mystapp/service-vehicles.spec.ts --project mystapp-chromium
  sleep 2
done
```

---

## 4) Concurrencia (workers) y usuarios

### Workers

Para Mystapp, el número de workers se controla con:

- `MYSTAPP_WORKERS` (con el ajuste en `playwright.config.ts`, también levanta el pool global local)

Ejemplo:

```bash
MYSTAPP_WORKERS=20 npx playwright test tests/mystapp/service-vehicles.spec.ts --project mystapp-chromium
```

### “Un test por usuario” (Service Vehicles)

El spec `service-vehicles.spec.ts` genera 1 test por usuario:

- `MYSTAPP_SERVICE_VEHICLES_USERS` = cantidad de tests (usuarios) que se generan

Ejemplo (20 tests y hasta 20 en paralelo):

```bash
MYSTAPP_SERVICE_VEHICLES_USERS=20 MYSTAPP_WORKERS=20 npm run test:mystapp:service-vehicles
```

### Reusar 1 solo usuario en paralelo (no recomendado, pero útil para stress)

Si solo tenés un usuario y querés correr varios tests en paralelo igual:

```bash
MYSTAPP_USER=804 MYSTAPP_PASSWORD=999753 MYSTAPP_REUSE_SINGLE_USER=1 MYSTAPP_SERVICE_VEHICLES_USERS=20 MYSTAPP_WORKERS=20 npm run test:mystapp:service-vehicles
```

> Ojo: reusar el mismo usuario puede generar interferencia (sesiones, locks, datos compartidos).

---

## 5) Captura de red (fetch/xhr) – endpoints, request/response y duración

Está soportado en:

- `tests/mystapp/service-vehicles.spec.ts`
- `tests/mystapp/invoices.spec.ts`

y se implementa en `tests/mystapp/netlog.ts`.

### Activar captura (metadata)

Adjunta `network.json` y `network.md` al reporte por cada test:

```bash
MYSTAPP_NETLOG=1 npm run test:mystapp:service-vehicles
```

### Capturar bodies (cuidado: puede ser pesado/sensible)

```bash
MYSTAPP_NETLOG=1 MYSTAPP_NETLOG_BODIES=1 npm run test:mystapp:service-vehicles
```

- Se intenta capturar solo respuestas tipo JSON/text.
- Se recorta el tamaño para evitar adjuntos enormes.
- Se redaccionan headers sensibles (ej. cookies/authorization) y algunas keys típicas en JSON.

### Filtrar solo endpoints “backend” (por regex)

Ejemplos:

```bash
MYSTAPP_NETLOG=1 MYSTAPP_NETLOG_URL_REGEX="/api/|/graphql" npm run test:mystapp:service-vehicles
```

```bash
MYSTAPP_NETLOG=1 MYSTAPP_NETLOG_URL_REGEX="/api/invoices|/api/service" npx playwright test tests/mystapp/invoices.spec.ts --project mystapp-chromium
```

---

## 6) Pausa para debug visual

Muchos specs soportan pausar el test para inspección:

```bash
MYSTAPP_PAUSE=1 npm run test:mystapp:service-vehicles
```

---

## 7) Perf summary (si estás usando el flujo perf)

Este script agrega/convierte resultados (según lo que ya tengas en `test-results/`):

```bash
npm run perf:mystapp:md
```

O el combo:

```bash
npm run test:mystapp:service-vehicles:perf
```
