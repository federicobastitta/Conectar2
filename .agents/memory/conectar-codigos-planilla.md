---
name: practice_code según planilla Conectar
description: Cómo se arma el código de facturación IOMA que viaja al Robot Klinicos.
---
Conectar exige que cada solicitud al Robot lleve el practice_code EXACTO de la planilla acordada (combos como un solo código con sus separadores, ej "290101-290102-420102", "340601+340601+340602+340602", "881841/A+881841/B"); consultas de especialidad siempre 420101 + specialty_code = nombre exacto de la especialidad.

Resolución (helper klinicos-codigo-facturacion en api-server/src/lib): 1) override klinicos_practicas.codigo_facturacion, 2) planilla embebida matcheada por multiconjunto de códigos, 3) código único tal cual, 4) fallback join con "-".

**Why:** un código faltante o con separador inventado (coma) frena la validación del token y pasa a resolución manual.

El nomenclador IOMA oficial completo (mayo 2026, ~1100 códigos individuales con nombre y valores) está en attached_assets/NOMENCLADOR_MEDICO_PN_MAYO_2026*.xlsx; sirve para validar códigos individuales pero NO trae las combinaciones (esas solo están en la planilla Conectar, que manda). Ojo: la hoja "88 liv-Pes" usa formato punteado (88.18.41/A0) y la planilla Conectar usa /A, /B sin el 0; el código 420102 del combo EEG de la planilla no existe en el nomenclador — igual se manda porque la planilla es la autoridad.

**How to apply:** códigos nuevos de Conectar se cargan como override vía PATCH /integraciones/klinicos/practicas/:id (codigoFacturacion) o se agregan a la planilla embebida; ojo con catálogos con typos (EEG tenía 202102) — el override cubre esos casos y hay que replicarlo en prod tras el publish.

## Seed de arranque (jul 2026)
- El catálogo completo de la planilla vive en `artifacts/api-server/src/lib/seed-planilla-conectar.ts` y se aplica solo al arrancar (dev y prod); el script viejo de scripts/ solo lo invoca a mano.
- Matchea por NOMBRE exacto de la práctica; hay dos EEG ("EEG" y "EEG (290101-202102)") porque la planilla trae dos combos textuales.
- Consultas de especialidad NO llevan practice_code de planilla (circuito propio del robot).
