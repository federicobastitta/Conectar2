/**
 * Unifica agendas (turneras) duplicadas que aún tienen turnos a futuro.
 *
 * Criterio de duplicado: turneras ACTIVAS, no-guardia, del mismo
 * profesional + sede + especialidad cuyos horarios se superponen
 * (comparten al menos un día de atención y los rangos horarios se cruzan).
 * La sobreviviente es la de menor id; las demás son redundantes.
 *
 * Para cada redundante con turnos a futuro:
 *  - mueve cada turno futuro a la sobreviviente (mismo fecha/hora);
 *  - si el slot ya está ocupado en la sobreviviente:
 *      · mismo paciente ⇒ es un duplicado exacto: se cancela con observación;
 *      · otro paciente ⇒ se mueve como sobreturno=true;
 *  - al final desactiva la redundante (activa=false, nunca DELETE).
 *
 * Todo vía la API (sirve igual para dev local y la app publicada).
 *
 * Env:
 *  BASE_URL        p.ej. https://xxx.replit.app/api  (sin barra final)
 *  ADMIN_EMAIL / ADMIN_PASSWORD
 *  APPLY=1         aplica los cambios (default: dry-run, solo reporta)
 *  FORZAR=1        permite aplicar pares conectados solo por transitividad
 *  SOLO_TURNERAS   opcional: ids de redundantes separadas por coma para acotar
 */

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const EMAIL = process.env.ADMIN_EMAIL ?? "";
const PASS = process.env.ADMIN_PASSWORD ?? "";
const APPLY = process.env.APPLY === "1";
const SOLO = (process.env.SOLO_TURNERAS ?? "")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

if (!BASE || !EMAIL || !PASS) {
  console.error("Faltan BASE_URL / ADMIN_EMAIL / ADMIN_PASSWORD");
  process.exit(1);
}

let token = "";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* respuestas sin body */ }
  return { status: res.status, json };
}

type Turnera = {
  id: number; nombre: string; profesionalId: number | null; sedeId: number | null;
  especialidadId: number | null; diasAtencion: string; horaInicio: string; horaFin: string;
  activa: boolean; esGuardia: boolean;
};
type Turno = {
  id: number; turneraId: number; pacienteId: number | null; fecha: string;
  horaInicio: string; estado: string; sobreturno: boolean;
};

const ESTADOS_INACTIVOS = new Set(["cancelado", "ausente"]);
const hoy = new Date().toISOString().split("T")[0];

const dias = (t: Turnera): string[] =>
  Array.isArray(t.diasAtencion) ? t.diasAtencion.map(String) : String(t.diasAtencion).split(",");

function seSuperponen(a: Turnera, b: Turnera): boolean {
  const da = dias(a), db = dias(b);
  return da.some((d) => db.includes(d)) && a.horaInicio < b.horaFin && b.horaInicio < a.horaFin;
}

async function turnosFuturos(turneraId: number, hasta?: string): Promise<Turno[]> {
  const out: Turno[] = [];
  for (let page = 1; ; page++) {
    const rango = `fechaDesde=${hoy}${hasta ? `&fechaHasta=${hasta}` : ""}`;
    const r = await api("GET", `/turnos?turneraId=${turneraId}&${rango}&limit=200&page=${page}`);
    if (r.status !== 200) throw new Error(`GET /turnos ${turneraId} -> ${r.status}`);
    const data: Turno[] = r.json.data ?? [];
    out.push(...data);
    if (out.length >= (r.json.total ?? 0) || data.length === 0) break;
  }
  return out;
}

const slotKey = (t: { fecha: string; horaInicio: string }) =>
  `${String(t.fecha).split("T")[0]}|${t.horaInicio.substring(0, 5)}`;

async function main() {
  const login = await api("POST", "/auth/login", { email: EMAIL, password: PASS });
  if (login.status !== 200 || !login.json?.token) {
    throw new Error(`Login falló (${login.status}): ${JSON.stringify(login.json)}`);
  }
  token = login.json.token;

  const lt = await api("GET", "/turneras?activa=true");
  if (lt.status !== 200) throw new Error(`GET /turneras -> ${lt.status}`);
  const activas: Turnera[] = (lt.json as Turnera[]).filter(
    (t) => t.activa && !t.esGuardia && t.profesionalId != null,
  );

  // Agrupar por profesional+sede+especialidad y detectar redundantes solapadas
  const grupos = new Map<string, Turnera[]>();
  for (const t of activas) {
    const k = `${t.profesionalId}|${t.sedeId}|${t.especialidadId}`;
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(t);
  }
  // Dentro de cada grupo, componentes conexas por superposición: dos bloques
  // horarios disjuntos del mismo profesional NO se unifican entre sí. La
  // sobreviviente es la de menor id DE SU componente.
  const pares: { surv: Turnera; red: Turnera }[] = [];
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.id - b.id);
    const compDe = new Map<number, number>(); // turnera.id -> id raíz de la componente
    for (const t of g) {
      const vecinas = g.filter((o) => o.id !== t.id && compDe.has(o.id) && seSuperponen(o, t));
      if (vecinas.length === 0) { compDe.set(t.id, t.id); continue; }
      const raices = [...new Set(vecinas.map((v) => compDe.get(v.id)!))].sort((a, b) => a - b);
      const raiz = Math.min(raices[0]!, t.id);
      compDe.set(t.id, raiz);
      for (const [id, r] of compDe) if (raices.includes(r)) compDe.set(id, raiz);
    }
    const comps = new Map<number, Turnera[]>();
    for (const t of g) {
      const r = compDe.get(t.id)!;
      (comps.get(r) ?? comps.set(r, []).get(r)!).push(t);
    }
    for (const miembros of comps.values()) {
      if (miembros.length < 2) continue;
      miembros.sort((a, b) => a.id - b.id);
      const surv = miembros[0]!;
      for (const red of miembros.slice(1)) pares.push({ surv, red });
    }
  }

  // Guardia extra: si una redundante llegó a la componente solo por transitividad
  // (no se superpone DIRECTAMENTE con la sobreviviente) se reporta y NO se aplica
  // salvo FORZAR=1 — un humano tiene que confirmar que no son bloques distintos.
  const indirectos = pares.filter(({ surv, red }) => !seSuperponen(surv, red));
  if (indirectos.length > 0) {
    for (const { surv, red } of indirectos) {
      console.log(`!! ${red.id} "${red.nombre}" solo se conecta con ${surv.id} "${surv.nombre}" por transitividad (no se superponen directamente)`);
    }
    if (APPLY && process.env.FORZAR !== "1") {
      console.error("Hay pares con superposición solo transitiva: revisar y re-correr con FORZAR=1 si corresponde.");
      process.exit(2);
    }
  }

  let movidos = 0, sobreturnos = 0, cancelados = 0, desactivadas = 0;
  for (const { surv, red } of pares) {
    if (SOLO.length && !SOLO.includes(red.id)) continue;
    const futuros = await turnosFuturos(red.id);
    if (futuros.length === 0) continue; // fuera de alcance: solo redundantes con turnos a futuro
    console.log(`\n== Redundante ${red.id} "${red.nombre}" (${futuros.length} turnos futuros) -> sobreviviente ${surv.id} "${surv.nombre}"`);
    if (!APPLY) {
      for (const t of futuros) console.log(`   [dry] turno ${t.id} ${t.fecha} ${t.horaInicio} estado=${t.estado} sobreturno=${t.sobreturno}`);
      continue;
    }
    // Mapa de ocupación de la sobreviviente (solo turnos activos no-sobreturno),
    // acotado al rango de fechas de los turnos a mover.
    const fechas = futuros.map((t) => String(t.fecha).split("T")[0]!).sort();
    const ocupados = new Map<string, Turno>();
    for (const t of await turnosFuturos(surv.id, fechas[fechas.length - 1])) {
      if (!ESTADOS_INACTIVOS.has(t.estado) && !t.sobreturno) ocupados.set(slotKey(t), t);
    }
    // Los turnos de una misma redundante ocupan slots distintos entre sí
    // (índice único), así que se pueden mover en paralelo con moderación.
    const CONCURRENCIA = 8;
    const mover = async (t: Turno): Promise<void> => {
      const activo = !ESTADOS_INACTIVOS.has(t.estado) && !t.sobreturno;
      const ocupante = activo ? ocupados.get(slotKey(t)) : undefined;
      if (ocupante && ocupante.pacienteId != null && ocupante.pacienteId === t.pacienteId) {
        // Duplicado exacto: mismo paciente ya tiene ese slot en la sobreviviente
        const r = await api("PATCH", `/turnos/${t.id}`, {
          estado: "cancelado",
          observaciones: `Cancelado por unificación de agendas: duplicado del turno ${ocupante.id} en la agenda ${surv.id}`,
        });
        if (r.status !== 200) throw new Error(`PATCH turno ${t.id} (cancelar) -> ${r.status}: ${JSON.stringify(r.json)}`);
        cancelados++;
        console.log(`   turno ${t.id} ${t.fecha} ${t.horaInicio}: duplicado exacto (paciente ${t.pacienteId}) -> cancelado`);
        return;
      }
      const body: Record<string, unknown> = { turneraId: surv.id };
      if (ocupante) body.sobreturno = true;
      let r = await api("PATCH", `/turnos/${t.id}`, body);
      if (r.status === 409 && !body.sobreturno) {
        r = await api("PATCH", `/turnos/${t.id}`, { turneraId: surv.id, sobreturno: true });
      }
      if (r.status !== 200) throw new Error(`PATCH turno ${t.id} -> ${r.status}: ${JSON.stringify(r.json)}`);
      if (r.json?.sobreturno && !t.sobreturno) {
        sobreturnos++;
        console.log(`   turno ${t.id} ${t.fecha} ${t.horaInicio}: slot ocupado -> movido como sobreturno`);
      } else {
        movidos++;
      }
    };
    for (let i = 0; i < futuros.length; i += CONCURRENCIA) {
      await Promise.all(futuros.slice(i, i + CONCURRENCIA).map(mover));
    }
    // Los duplicados exactos quedan cancelados en la redundante: solo cuentan los activos
    const quedan = (await turnosFuturos(red.id)).filter((t) => !ESTADOS_INACTIVOS.has(t.estado));
    if (quedan.length > 0) throw new Error(`La turnera ${red.id} sigue con ${quedan.length} turnos futuros activos`);
    const rd = await api("PATCH", `/turneras/${red.id}`, { activa: false });
    if (rd.status !== 200) throw new Error(`PATCH turnera ${red.id} -> ${rd.status}: ${JSON.stringify(rd.json)}`);
    desactivadas++;
    console.log(`   turnera ${red.id} desactivada`);
  }
  console.log(`\nResumen${APPLY ? "" : " (dry-run)"}: movidos=${movidos} sobreturnos=${sobreturnos} cancelados=${cancelados} desactivadas=${desactivadas}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
