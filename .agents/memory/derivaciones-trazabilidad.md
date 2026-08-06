---
name: Trazabilidad de derivaciones internas
description: Estados y permisos de las derivaciones a servicios de la clínica
---
Regla: las derivaciones (referrals) tienen circuito pedido → agendado → realizado → informado (anulable hasta realizarse); el estado legado "emitida" se migra a "pedido" al arrancar (idempotente). OJO: las recetas (prescriptions) siguen usando "emitida" — no unificar los enums, son contratos distintos.
**Why:** una vez se cambió por error el status de recetas a "pedido" con un sed masivo y rompió el contrato OpenAPI.
**How to apply:** cualquier cambio de estados de un documento clínico debe tocar en lockstep: DB write, TRANSICIONES en backend y frontend (espejo), enum en openapi.yaml + codegen. El médico solo gestiona sus propias derivaciones (backend lo valida; la UI debe ocultar el control para ajenas).
