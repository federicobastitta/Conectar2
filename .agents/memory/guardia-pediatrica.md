---
name: Guardia pediátrica separada
description: La guardia virtual/check-in previo soporta dos guardias (clinica y pediatrica) con turneras y switches propios.
---

La guardia virtual tiene dos slots: `clinica` (adultos, claves de config originales `guardia_virtual_*`, default en toda la API pública para no romper la app del paciente publicada) y `pediatrica` (claves `guardia_virtual_pediatria_activa` / `_turnera_id`). Comparten horario, obras sociales (IOMA) y allowlist presencial.

**Cómo se enruta:** la sesión guarda su columna `guardia`; turnera, fila y posición se calculan siempre contra la guardia de la sesión (el polling usa `turno.turneraId` real). El anti-duplicado de `klinicos_trabajos` en la validación de token está scopeado por especialidad — mismo DNI+token en guardias distintas NO reutiliza el trabajo de la otra.

**Especialidad Klinicos:** pediatría valida token con especialidad `PEDIATRIA` → el robot detecta `/PEDIATR/` y usa el desplegable `PEDIATRIA-LACTANTES` con motivos pediátricos propios.

**Pendiente clave:** no hay pediatras sembrados en `klinicos_profesionales_ingreso` (especialidad `PEDIATRIA`). Hasta que gestión cargue nombres exactos del desplegable de Klinicos (activo=true), la validación de token pediátrica falla con mensaje claro. Preguntado a Federico.

**UI:** la sección "Guardia virtual" en Editar turnera configura el slot pediátrico automáticamente si el nombre de la agenda contiene "pediatr" (sin acentos).

**Why:** Federico pidió separar la guardia pediátrica con su propio check-in previo (ago 2026); la demora publicada de cada guardia debe ser la propia, nunca mezclada.
**How to apply:** cualquier endpoint o superficie nueva de guardia virtual debe recibir/propagar `guardia` con default `clinica`; nunca usar `config.turneraId` a secas para una sesión.
