const BASE = "https://clinic-core-suite.replit.app";
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "desarrollador@diagnosticar.ar", password: "diagnosticar" }) });
const { token } = await login.json();
const h = { authorization: "Bearer " + token };
for (let i = 0; i < 8; i++) {
  const rt = await fetch(BASE + "/api/integraciones/klinicos/trabajos", { headers: h });
  const mio = (await rt.json()).find(x => x.id === 2330);
  console.log(`poll ${i}:`, JSON.stringify({ estado: mio.estado, ordenPracticaId: mio.ordenPracticaId, err: mio.ultimoError?.slice(0, 140) ?? null }));
  if (!["pendiente", "en_proceso"].includes(mio.estado)) {
    const pasos = mio.simulacionPayload?.pasos;
    if (pasos) console.log("simulación:\n" + pasos.map(p => `${p.paso}: ${p.ok ? "OK" : "FALLO"} — ${(p.detalle ?? "").slice(0, 130)}`).join("\n"));
    break;
  }
  await new Promise((s) => setTimeout(s, 15000));
}
