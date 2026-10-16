# Seguridad — minio-upload-service

Carpeta de seguridad del servicio. Acá está **qué se auditó, qué se arregló, qué queda
pendiente, y cómo operarlo**. Todo el trabajo se hizo sobre infraestructura propia y
autorizada (ver [`PENTEST-AUTHORIZATION.md`](./PENTEST-AUTHORIZATION.md)).

> Última actualización: **2026-07-25** · Trabajo de auditoría/hardening: **2026-07-24**

## Estado de un vistazo

| Área | Estado |
|---|---|
| XSS almacenado (robo de master key) | ✅ Corregido y deployado |
| Validación de archivos (nombre / tipo / tamaño) | ✅ Corregido y deployado |
| SVG inline / descargas activas | ✅ Corregido (disposition quirúrgico) |
| Endurecimiento HTTP (helmet/CSP) | ✅ Corregido y deployado |
| Cifrado en reposo (SSE-S3) | ✅ Activo y verificado (objetos **nuevos**) |
| Permisos de secretos (`.env`) | ✅ `chmod 600` aplicado |
| Suite de regresión de seguridad | ✅ 14/14 PASS |
| Aislamiento cross-tenant (por carpeta) | ⚠️ Pendiente (fix riesgoso — ver informe) |
| Recifrado de los 1.341 objetos viejos | ⚠️ Pendiente (siguen en texto plano) |
| Cloudflare Access sobre `/dashboard` | ⚠️ Pendiente (lado del panel de Cloudflare) |

> **Nota de estado:** los fixes están **deployados en el servicio corriendo** (build +
> `pm2 restart` hechos) pero **no** commiteados en git todavía.

## Archivos de esta carpeta

| Archivo | Para qué |
|---|---|
| [`SECURITY-REPORT.md`](./SECURITY-REPORT.md) | Informe completo: hallazgos, pentest, correcciones, verificación. |
| [`RUNBOOK.md`](./RUNBOOK.md) | Operación: deploy, SSE/KMS, recifrado, rotación de key, respuesta a incidentes. |
| [`selftest.mjs`](./selftest.mjs) | Suite de regresión de seguridad (14 asserts, auto-limpiante). |
| [`PENTEST-AUTHORIZATION.md`](./PENTEST-AUTHORIZATION.md) | Constancia de autorización (el suite se niega a correr sin ella). |
| [`PENTEST-PROMPT.md`](./PENTEST-PROMPT.md) | Preámbulo reusable para testing exploratorio en un chat nuevo. |

## Quickstart

```bash
# Verificar que todas las protecciones siguen en pie (14 asserts, no destructivo)
node security/selftest.mjs

# Ver el estado del cifrado en reposo
node scripts/enable-sse.js --check

# Deployar cambios de código (tras editar src/)
npm run build && pm2 restart minio-upload-service
```

## Lo más importante en una línea

🔑 **La master key del cifrado está en `/home/nicolas/minio-stack/kms-backup/`.
Si se pierde, los archivos cifrados son irrecuperables. Guardá una copia FUERA de la Raspberry.**
