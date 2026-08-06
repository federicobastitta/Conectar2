// Carga los códigos de envío de la planilla Conectar en la APP PUBLICADA
// vía su propia API (nunca tocando la base de prod directo).
// Uso: BASE_URL=https://... ADMIN_EMAIL=... ADMIN_PASS=... pnpm --filter @workspace/api-server exec tsx scripts/cargar-codigos-conectar-prod.mts
// Idempotente: matchea por nombre exacto y hace PATCH (o POST si falta).

const BASE = process.env.BASE_URL;
const EMAIL = process.env.ADMIN_EMAIL;
const PASS = process.env.ADMIN_PASS;
if (!BASE || !EMAIL || !PASS) {
  console.error("Faltan BASE_URL / ADMIN_EMAIL / ADMIN_PASS");
  process.exit(1);
}

// Misma lista que seed-codigos-envio-conectar.mts (planilla Conectar exacta)
const PLANILLA: Array<[string, string, string[]]> = [
  ["ECG", "170101", ["170101"]],
  ["ERGOMETRIA", "881706", ["881706"]],
  ["HOLTER", "881710", ["881710"]],
  ["MAPA", "881701", ["881701"]],
  ["EEG", "290101-290102-420102", ["290101", "290102", "420102"]],
  ["ESPIROMETRIA", "880502-880501-280102", ["880502", "880501", "280102"]],
  ["ECO TOCOGINECOLOGICA", "180104", ["180104"]],
  ["ECO TV TRANSVAGINAL", "881807", ["881807"]],
  ["ECO PARTES BLANDAS", "881806", ["881806"]],
  ["ECO CADERAS BEBE", "881803", ["881803"]],
  ["ECO MAMAS", "180106-881806", ["180106", "881806"]],
  ["ECO TIROIDES", "180110", ["180110"]],
  ["ECO TESTICULAR", "180111", ["180111"]],
  ["ECO ABDOMEN", "180112-180113", ["180112", "180113"]],
  ["ECO HBP", "180113", ["180113"]],
  ["ECO VESICAL Y/O PROSTATA", "180114", ["180114"]],
  ["ECO RENAL", "180116", ["180116"]],
  ["MAMOGRAFIA", "340601+340601+340602+340602", ["340601", "340601", "340602", "340602"]],
  ["RX CRANEO/CAVUM / SENOS PARANASALES……... ( FRENTE)", "340201", ["340201"]],
  ["RX CRANEO / SENOS PARANASALES….… ( PERFIL)", "340202", ["340202"]],
  ["RX COLUMNA CERVICAL, DORSAL Y LUMBAR……….. ( FRENTE)", "340209", ["340209"]],
  ["RX COLUMNA CERVICAL, DORSAL Y LUMBAR …………( PERFIL)", "340210", ["340210"]],
  ["RX HOMBRO / PELVIS/CADERA/ FEMUR/HUMERO……..… .(FRENTE)", "340211", ["340211"]],
  ["RX HOMBRO/PELVIS/CADERA/ FEMUR/HUMERO ……..….. ( PERFIL)", "340212", ["340212"]],
  [
    "RX CODO, ANTEBRAZO, MUÑECA, MANO, DEDOS, RODILLA,ROTULA, PIERNA, TOBILLO , PIE TODO FRENTE Y PERFIL",
    "340213",
    ["340213"],
  ],
  ["RX TORAX / PARRILLA COSTAL…..……. (FRENTE)", "340301", ["340301"]],
  ["RX TORAX/PARILLA COSTAL……..…. ( PERFIL)", "340302", ["340302"]],
  ["RX ABDOMEN ……....(FRENTE)", "340421", ["340421"]],
  ["RX ABDOMEN ………( PERFIL)", "340422", ["340422"]],
  ["DOPPLER CARDIACO - PESADO 88", "881840", ["881840"]],
  ["DOPPLER ARTERIAL MMSS O MMII- PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER VENOSO MMSS O MMII - PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER ARTERIAL Y VENOSO MMII O MMSS - PESADO 88", "881841/A+881841/B", ["881841/A", "881841/B"]],
  ["DOPPLER VASOS CUELLO - PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER RENAL PESADO 88", "881842", ["881842"]],
  ["COLPOSCOPIA", "220101", ["220101"]],
  ["PAP", "150106", ["150106"]],
  ["EXTRACCION DE PUNTOS", "130110", ["130110"]],
];

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}/api${path}`, init);
}

// Login admin
const loginRes = await api("/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
});
if (!loginRes.ok) {
  console.error("Login falló:", loginRes.status, await loginRes.text());
  process.exit(1);
}
const { token } = (await loginRes.json()) as { token: string };
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const listRes = await api("/integraciones/klinicos/practicas", { headers: auth });
if (!listRes.ok) {
  console.error("GET practicas falló:", listRes.status, await listRes.text());
  process.exit(1);
}
type Practica = { id: number; nombre: string; codigoEnvio?: string | null; codigos: string[]; activo: boolean };
const existentes = (await listRes.json()) as Practica[];
const porNombre = new Map(existentes.map((p) => [p.nombre, p]));

let actualizadas = 0;
let creadas = 0;
let sinCambio = 0;
let errores = 0;
for (const [nombre, codigoEnvio, codigos] of PLANILLA) {
  const ex = porNombre.get(nombre);
  if (ex) {
    if (ex.codigoEnvio === codigoEnvio && JSON.stringify(ex.codigos) === JSON.stringify(codigos) && ex.activo) {
      sinCambio++;
      continue;
    }
    const res = await api(`/integraciones/klinicos/practicas/${ex.id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ nombre, codigos, codigoEnvio, activo: true }),
    });
    if (res.ok) actualizadas++;
    else {
      errores++;
      console.error(`PATCH ${nombre}: ${res.status} ${await res.text()}`);
    }
  } else {
    const res = await api("/integraciones/klinicos/practicas", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ nombre, codigos, codigoEnvio, activo: true }),
    });
    if (res.ok) creadas++;
    else {
      errores++;
      console.error(`POST ${nombre}: ${res.status} ${await res.text()}`);
    }
  }
}
console.log(
  `Planilla Conectar en prod: ${actualizadas} actualizadas, ${creadas} creadas, ${sinCambio} sin cambio, ${errores} errores.`,
);

// Verificación final
const verifRes = await api("/integraciones/klinicos/practicas", { headers: auth });
const finales = (await verifRes.json()) as Practica[];
const nombres = new Set(PLANILLA.map(([n]) => n));
const conCodigo = finales.filter((p) => nombres.has(p.nombre) && p.codigoEnvio && p.activo);
const faltantes = [...nombres].filter((n) => !finales.some((p) => p.nombre === n && p.codigoEnvio && p.activo));
console.log(`Verificación: ${conCodigo.length}/${PLANILLA.length} prácticas de la planilla con codigoEnvio en prod.`);
if (faltantes.length) console.error("Faltan:", faltantes);
process.exit(errores || faltantes.length ? 1 : 0);
