---
name: Certificados de guardia
description: Protocolo institucional de certificados de guardia y cómo se refleja en el formulario guiado
---
El usuario aportó un protocolo institucional (PDF en attached_assets, "Protocolo_Certificados_Guardia_Diagnosticar") que rige los certificados de guardia.

**Reglas del protocolo que el formulario debe respetar:**
- Decisión ternaria: Asistencia (sin reposo) / Reposo 24 h / Reposo 48 h + control. **Nunca más de 48 h desde guardia** — para más plazo: nuevo control o derivación.
- El reposo exige correlato clínico documentado (hallazgo objetivo o diagnóstico); no se otorga "a pedido" ni retroactivo.
- Signos de alarma bloquean el alta simple → advertencia + se documenta derivación en observations.
- Texto institucional fijo: "Se deja constancia que el/la paciente fue evaluado/a en Guardia Clínica Ambulatoria… no acredita períodos previos no evaluados."

**Cómo se aplica:** SeccionCertificados (resolucion.tsx) tiene modo "guardia" (guiado, por defecto) y "libre" (form viejo). Los cuadros clínicos, hallazgos y alarmas salen de los algoritmos del PDF (respiratorio, gastro, columna, cefalea, urinario, ORL/piel, ansiedad). Si el usuario pide cambios, mantener las reglas de gobierno del protocolo.
