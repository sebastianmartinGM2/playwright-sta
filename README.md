# Playwright test setup

## Requisitos
- Node.js 18+ recomendado

## Instalar dependencias
```bash
npm install
```

## Instalar navegadores (una vez)
```bash
npx playwright install
```

## Correr tests
```bash
npm test
```

## Ver reporte HTML
```bash
npm run report
```

## Applitools (visual testing) (opcional)

1) Instalar dependencias (ya incluido en este repo)

2) Setear la API key
```bash
export APPLITOOLS_API_KEY="TU_API_KEY"
```

3) Ejecutar solo los tests visuales (tag `@visual`)
```bash
npm run test:visual
```

Notas:
- Si `APPLITOOLS_API_KEY` no está seteada, los tests visuales se van a marcar como `skipped`.
- El ejemplo está en `tests/demoblaze/cart.visual.spec.ts`.

## Testim Demo (demo.testim.io)

Los tests viven en `tests/testim/`.

### Correr flows públicos (no requieren login)
```bash
npm run test:testim -- --grep "Public flows"
```

### Correr flows autenticados (requieren credenciales)

Seteá estas variables antes de correr:
```bash
export TESTIM_USERNAME="..."
export TESTIM_PASSWORD="..."
```

Luego corré:
```bash
npm run test:testim
```

Notas:
- Si `TESTIM_USERNAME/TESTIM_PASSWORD` no están seteadas, los tests `@auth` se van a marcar como `skipped`.

## Mystapp (URL a definir) – stress de login

Los tests viven en `tests/mystapp/` y están documentados en `tests/mystapp/docs/README.md`.

Variables mínimas requeridas:
```bash
export MYSTAPP_BASE_URL="https://qa.mystaapp.com"
export MYSTAPP_USERS_COUNT="1"  # usado por auth.setup y login.stress
export MYSTAPP_USERS="804"       # o MYSTAPP_USER / MYSTAPP_USER_PREFIX
export MYSTAPP_PASSWORD="..."
```

Tips:
- Documentación completa: `tests/mystapp/docs/README.md`
- Comandos de uso diario (workers, loops, netlog): `tests/mystapp/docs/COMMANDS.md`

Correr setup (genera storageState por usuario):
```bash
npm run test:mystapp:setup
```

Correr stress (solo login):
```bash
npm run test:mystapp -- --grep @stress
```
