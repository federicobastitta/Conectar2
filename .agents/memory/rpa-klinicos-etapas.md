---
name: RPA Klinicos etapas 1-3
description: Decisiones y calibración del módulo de envío de prestaciones a KLINICOS (simulación)
---

## Decisiones del usuario (31/07/2026)
- **Arquitectura**: automatizador INTERNO de Conectar (`klinicos-robot.ts` + `klinicos-prestaciones.ts`), NO el Robot externo para la carga. El Robot externo sigue solo para validación de token.
- **Token completo**: se guarda en Conectar (pedido de la clínica), pero el RPA solo usa/loguea la versión enmascarada (`enmascararToken`, ••••XXXX). Sin reuso para validaciones posteriores: rechazo → aviso + carga manual por KLINICOS.
- **Why:** el manual de facturación dice "nunca guardar el token", contradicción resuelta explícitamente por el usuario.

## Reglas duras
- Eco Doppler y resonancias (RMN/RNM): carga manual SIEMPRE (decisión 22/07/2026). El worker cancela el trabajo antes de tocar Klinicos.
- Autorizar: exactamente UNA prestación CONFIRMADA sin bono; 0 o >1 → revisión (fail-closed). Tras autorizar releer y exigir N° bono; incierto ≠ rechazo, nunca reconsumir token.
- Consultas 420101 con profesional administrativo: DECISIÓN PENDIENTE (hoy el bono de consulta lo autogenera Klinicos con el médico del ingreso).

## Calibración por video (31/07/2026, ECG)
- Práctica se crea en `/ordenPrestacion/create/{atencionId}/3`; CIE-10 obligatorio; prácticas por código exacto (select2); éxito = redirect + "Prestación creada correctamente".
- Endpoints AJAX exactos del POST de creación/autorización pendientes de calibrar con credenciales (etapa 4). KLINICOS_USUARIO/PASSWORD NO están en Secrets todavía.

## Simulación
- `KLINICOS_DRY_RUN=1` (default) + payload persistido en `klinicos_trabajos.simulacion_payload/simulacion_en` (ingreso + prestación + plan de autorización, token enmascarado).
- Informe de diferencias manual↔código: `docs/rpa-klinicos-informe-diferencias.md`. El PDF "manual de facturacion.pdf" NUNCA fue subido; el informe usa el resumen funcional pegado.


## Modo asistido (regla vigente)
**Regla:** el worker de la cola solo simula; toda escritura real en Klinicos exige aprobación humana por caso (endpoint aprobar) MÁS dry-run desactivado en el entorno. Guardas post-intentado separadas por escritura (ingreso, prestación, autorización).
**Why:** un token IOMA consumido por error o un ingreso duplicado son incidentes operativos reales; incierto ≠ rechazo y un token jamás se reenvía — en reintentos solo el bono visible EN LA PRESTACIÓN OBJETIVO resuelve como aceptado.
**How to apply:** cualquier nueva escritura al portal debe sumar su propia guarda post-intentado, releer la pantalla para confirmar, y abortar antes del POST con mensaje de calibración si la página no matchea lo esperado. Editar un trabajo esperando aprobación invalida su simulación y lo reencola.
## Match fail-closed
**Regla:** todo macheo de profesional/práctica es por palabra completa (nunca substring: "JUAN" no machea "JUANA", "ECO" no machea "ECOGRAFICO") y exige exactamente UNA candidata; 0 o >1 → revisión humana. El CIE-10 sugerido por IA solo se envía si figura en el catálogo aprobado activo; si no, queda pendiente/revisable.
**Why:** principio fail-closed del manual RPA — elegir algo "parecido" carga la atención al paciente/profesional equivocado.
**How to apply:** cualquier matcher nuevo del robot Klinicos debe seguir este criterio; no reintroducir "mejor puntaje" ni contención cruda por substring.

## Decisiones del manual (01/08/2026, usuario)
- Consultas en Klinicos: profesional administrativo configurado + código 420101 (NO el médico real de la atención). Falta configurar quién es ese profesional.
- Práctica sin orden médica real: el robot genera la orden manuscrita de Conectar SIN aprobación previa (corrección 01/08/2026); un operador la revisa después en Klinicos; auditar que fue autogenerada.
- Ingreso Clínica Médica: rotar entre todos los profesionales del desplegable EXCEPTO "CANESTRO, FERREYRA" (y nunca "USUARIO, Medico").
- Manual de facturación PDF verificado: describe al Robot externo como arquitectura, pero rige solo como fuente funcional; la carga la hace el automatizador interno.

## Robot externo: se retira (01/08/2026)
Decisión del usuario: el Robot externo (ROBOT_API_URL) se DEJA DE USAR; el automatizador interno de Conectar asume todo (token + cargas). El equipo del robot viejo aún no lo sabe. No invertir más en el contrato robot-openapi; desactivar integraciones salientes cuando el interno esté productivo.

## Consulta espejo desde recepción (01/08/2026)
Flujo aprobado: recepción carga DNI + token (sin turno) → POST /integraciones/klinicos/consultas-espejo encola trabajo CLINICA MEDICA / CONSULTORIO con médico ROTADO del listado (no el administrativo 420101; el usuario pidió explícitamente el listado de rotación). Anti-duplicado atómico por paciente+token con advisory lock; validar longitudes DESPUÉS del trim. Se procesa al instante en background.
