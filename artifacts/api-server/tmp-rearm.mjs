const BASE = "https://clinic-core-suite.replit.app";
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "desarrollador@diagnosticar.ar", password: "diagnosticar" }) });
const { token } = await login.json();
const h = { authorization: "Bearer " + token, "content-type": "application/json" };

// 1. Configurar la agenda ECG como práctica de cardiología con Cáceres
const rp = await fetch(BASE + "/api/turneras/1385", { method: "PATCH", headers: h, body: JSON.stringify({ klinicosSector: "CONSULTORIOS", klinicosEspecialidad: "CARDIOLOGIA", klinicosProfesional: "CACERES FRANCO" }) });
console.log("PATCH turnera →", rp.status);

// 2. Cancelar el trabajo viejo (quedó con especialidad Electrocardiograma)
const rc = await fetch(BASE + "/api/integraciones/klinicos/trabajos/2330", { method: "PATCH", headers: h, body: JSON.stringify({ estado: "cancelado" }) });
console.log("cancelar 2330 →", rc.status);

// 3. Re-encolar el turno
const re = await fetch(BASE + "/api/turnos/49553/encolar-klinicos", { method: "POST", headers: h, body: "{}" });
const je = await re.json().catch(() => null);
console.log("encolar →", re.status, JSON.stringify(je).slice(0, 150));
const nuevoId = je?.trabajoId;

// 4. Prescriptor Piropo (regla fija) por si el enriquecido puso otro
if (nuevoId) {
  const rpr = await fetch(`${BASE}/api/integraciones/klinicos/trabajos/${nuevoId}`, { method: "PATCH", headers: h, body: JSON.stringify({ prescriptorNombre: "PIROPO NETO RUBEM" }) });
  console.log("PATCH prescriptor →", rpr.status);
}

// 5. Esperar preparación (enriquecido + orden automática + simulación)
for (let i = 0; i < 8; i++) {
  await new Promise((s) => setTimeout(s, 15000));
  const rt = await fetch(BASE + "/api/integraciones/klinicos/trabajos", { headers: h });
  const mio = (await rt.json()).find(x => x.id === nuevoId);
  if (!mio) { console.log("trabajo no encontrado"); break; }
  console.log(`t+${(i + 1) * 15}s:`, JSON.stringify({ estado: mio.estado, esp: mio.especialidad, sector: mio.sectorServicio, codigos: mio.practicaCodigos, ordenPracticaId: mio.ordenPracticaId, prescriptor: mio.prescriptorNombre, efector: mio.efectorNombre, err: mio.ultimoError?.slice(0, 120) ?? null }));
  if (!["pendiente", "en_proceso"].includes(mio.estado)) {
    const pasos = mio.simulacionPayload?.pasos;
    if (pasos) console.log("simulación:\n" + pasos.map(p => `  ${p.paso}: ${p.ok ? "OK" : "FALLO"} — ${(p.detalle ?? "").slice(0, 120)}`).join("\n"));
    break;
  }
}
