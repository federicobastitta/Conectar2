import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useListSedes,
  useListTurneras,
  useListSalasLlamado,
  useCrearCodigoTv,
  consultarCodigoTv,
} from "@workspace/api-client-react";
import { Tv, Building2, Siren, MonitorPlay, DoorOpen } from "lucide-react";

// ── Selección persistida en el dispositivo (localStorage) ──────────────────
// La TV recuerda la sala elegida: al recargar va directo a la pantalla.
export const TV_SELECCION_KEY = "tv_sala_seleccion";

export type TvSeleccion =
  | { tipo: "todas" }
  | { tipo: "sede"; sedeId: number }
  | { tipo: "turnera"; turneraId: number }
  | { tipo: "sala"; salaId: number };

export function leerSeleccionTv(): TvSeleccion | null {
  try {
    const crudo = localStorage.getItem(TV_SELECCION_KEY);
    if (!crudo) return null;
    const parsed = JSON.parse(crudo) as TvSeleccion;
    if (parsed.tipo === "todas") return parsed;
    if (parsed.tipo === "sede" && Number.isInteger(parsed.sedeId) && parsed.sedeId > 0) return parsed;
    if (parsed.tipo === "turnera" && Number.isInteger(parsed.turneraId) && parsed.turneraId > 0)
      return parsed;
    if (parsed.tipo === "sala" && Number.isInteger(parsed.salaId) && parsed.salaId > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function borrarSeleccionTv() {
  try {
    localStorage.removeItem(TV_SELECCION_KEY);
  } catch {
    // sin localStorage (modo privado): la TV simplemente vuelve a preguntar
  }
}

function guardarSeleccionTv(sel: TvSeleccion) {
  try {
    localStorage.setItem(TV_SELECCION_KEY, JSON.stringify(sel));
  } catch {
    // sin localStorage: igual navegamos, solo que no queda recordado
  }
}

export function urlPantalla(sel: TvSeleccion): string {
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/pantalla-sala`;
  if (sel.tipo === "sala") return `${base}?salaId=${sel.salaId}`;
  if (sel.tipo === "sede") return `${base}?sedeId=${sel.sedeId}`;
  if (sel.tipo === "turnera") return `${base}?turneraId=${sel.turneraId}`;
  return base;
}

export function urlTv(): string {
  return `${import.meta.env.BASE_URL.replace(/\/$/, "")}/tv`;
}

function irAPantalla(sel: TvSeleccion) {
  guardarSeleccionTv(sel);
  window.location.replace(urlPantalla(sel));
}

// ── Página de entrada corta /tv ─────────────────────────────────────────────
// Pensada para SmartTV: botones grandes, navegables con las flechas del
// control remoto (foco real del navegador), y código corto de vinculación
// para asignar la sala desde Recepción sin tocar la TV.
export default function TvEntrada() {
  // Si el dispositivo ya tiene una sala guardada, va directo a la pantalla.
  // (Se lee una sola vez, antes del primer render.)
  const seleccionGuardada = useMemo(leerSeleccionTv, []);
  useEffect(() => {
    if (seleccionGuardada) window.location.replace(urlPantalla(seleccionGuardada));
  }, [seleccionGuardada]);

  const { data: sedes } = useListSedes({ activa: true });
  const { data: turneras } = useListTurneras({ activa: true });
  const { data: salas } = useListSalasLlamado();
  const listaSalas = (salas ?? []).filter((s) => s.activa !== false);

  const listaSedes = (sedes ?? []).filter((s) => s.activa !== false);
  const guardias = useMemo(() => {
    const vistas = new Map<string, { id: number; etiqueta: string }>();
    for (const t of turneras ?? []) {
      if (!t.esGuardia || t.activa === false) continue;
      const clave = `${t.nombre.trim().toLowerCase()}|${t.sedeId ?? ""}`;
      if (vistas.has(clave)) continue;
      const sede = listaSedes.find((s) => s.id === t.sedeId);
      vistas.set(clave, {
        id: t.id,
        etiqueta: sede ? `${t.nombre} — ${sede.nombre}` : t.nombre,
      });
    }
    return [...vistas.values()].sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turneras, sedes]);

  // ── Código de vinculación: se genera al entrar y se consulta por polling ──
  const [codigo, setCodigo] = useState<string | null>(null);
  const codigoRef = useRef<string | null>(null);
  const { mutate: crearCodigo } = useCrearCodigoTv({
    mutation: {
      onSuccess: (data) => {
        codigoRef.current = data.codigo;
        setCodigo(data.codigo);
      },
    },
  });

  useEffect(() => {
    if (seleccionGuardada) return; // ya está redirigiendo
    crearCodigo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (seleccionGuardada || !codigo) return;
    const timer = setInterval(async () => {
      const actual = codigoRef.current;
      if (!actual) return;
      try {
        const estado = await consultarCodigoTv(actual);
        if (estado.estado === "asignado") {
          clearInterval(timer);
          if (estado.salaId) irAPantalla({ tipo: "sala", salaId: estado.salaId });
          else if (estado.turneraId) irAPantalla({ tipo: "turnera", turneraId: estado.turneraId });
          else if (estado.sedeId) irAPantalla({ tipo: "sede", sedeId: estado.sedeId });
          else irAPantalla({ tipo: "todas" });
        }
      } catch {
        // 404 = vencido o inválido: pedir un código nuevo
        codigoRef.current = null;
        setCodigo(null);
        crearCodigo();
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codigo, seleccionGuardada]);

  // ── Navegación con flechas del control remoto: mueve el foco real ────────
  const contenedorRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const botones = Array.from(
      contenedorRef.current?.querySelectorAll<HTMLButtonElement>("button[data-tv-opcion]") ?? [],
    );
    if (botones.length === 0) return;
    e.preventDefault();
    const idx = botones.findIndex((b) => b === document.activeElement);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const siguiente = idx < 0 ? 0 : (idx + delta + botones.length) % botones.length;
    botones[siguiente]?.focus();
  }, []);

  // Foco inicial en la primera opción (para que las flechas funcionen ya)
  const opcionesListas = listaSedes.length > 0 || guardias.length > 0;
  useEffect(() => {
    if (seleccionGuardada) return;
    contenedorRef.current
      ?.querySelector<HTMLButtonElement>("button[data-tv-opcion]")
      ?.focus();
  }, [opcionesListas, seleccionGuardada]);

  if (seleccionGuardada) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <p className="text-3xl text-slate-400">Abriendo la pantalla de sala…</p>
      </div>
    );
  }

  const claseBoton =
    "w-full flex items-center gap-4 rounded-2xl border-2 border-slate-700 bg-slate-900 px-8 py-6 text-left text-3xl font-bold transition-colors " +
    "hover:border-cyan-500 hover:bg-slate-800 focus:outline-none focus:border-cyan-400 focus:bg-cyan-500/15 focus:ring-4 focus:ring-cyan-500/40";

  return (
    <div
      ref={contenedorRef}
      onKeyDown={onKeyDown}
      className="min-h-screen bg-slate-950 text-white flex flex-col lg:flex-row"
    >
      {/* Selector de sala */}
      <main className="flex-1 p-10 lg:p-14 overflow-y-auto">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-14 h-14 rounded-xl bg-cyan-500 flex items-center justify-center">
            <Tv className="w-8 h-8 text-slate-950" />
          </div>
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight">Diagnosticar — Pantalla de sala</h1>
            <p className="text-slate-400 text-2xl">
              Elegí qué sala mostrar en esta TV (flechas del control remoto y OK)
            </p>
          </div>
        </div>

        <div className="mt-8 space-y-4 max-w-3xl">
          <button
            type="button"
            data-tv-opcion
            data-testid="tv-opcion-todas"
            className={claseBoton}
            onClick={() => irAPantalla({ tipo: "todas" })}
          >
            <MonitorPlay className="w-9 h-9 text-cyan-400 shrink-0" />
            Todas las sedes
          </button>

          {listaSalas.map((s) => (
            <button
              key={`sala-${s.id}`}
              type="button"
              data-tv-opcion
              data-testid={`tv-opcion-sala-${s.id}`}
              className={claseBoton}
              onClick={() => irAPantalla({ tipo: "sala", salaId: s.id })}
            >
              <DoorOpen className="w-9 h-9 text-emerald-400 shrink-0" />
              {s.nombre}
            </button>
          ))}

          {/* Si hay salas de llamado creadas, la TV se elige por sala; las
              sedes quedan solo como fallback cuando no hay salas. */}
          {listaSalas.length === 0 && listaSedes.map((s) => (
            <button
              key={s.id}
              type="button"
              data-tv-opcion
              data-testid={`tv-opcion-sede-${s.id}`}
              className={claseBoton}
              onClick={() => irAPantalla({ tipo: "sede", sedeId: s.id })}
            >
              <Building2 className="w-9 h-9 text-cyan-400 shrink-0" />
              {s.nombre}
            </button>
          ))}

          {guardias.map((g) => (
            <button
              key={g.id}
              type="button"
              data-tv-opcion
              data-testid={`tv-opcion-guardia-${g.id}`}
              className={claseBoton}
              onClick={() => irAPantalla({ tipo: "turnera", turneraId: g.id })}
            >
              <Siren className="w-9 h-9 text-amber-400 shrink-0" />
              {g.etiqueta}
            </button>
          ))}
        </div>
      </main>

      {/* Código de vinculación desde Recepción */}
      <aside className="lg:w-[26rem] shrink-0 lg:sticky lg:top-0 lg:h-screen bg-slate-900 border-t lg:border-t-0 lg:border-l border-slate-800 p-10 flex flex-col items-center justify-center text-center gap-6">
        <h2 className="text-2xl font-bold text-slate-300">¿Más fácil todavía?</h2>
        <p className="text-xl text-slate-400">
          Desde <span className="text-cyan-400 font-semibold">Recepción → Sala de espera → Vincular
          pantalla TV</span> ingresá este código y esta TV pasa sola a la sala elegida:
        </p>
        <div
          data-testid="tv-codigo-vinculacion"
          className="rounded-2xl border-4 border-cyan-500 bg-slate-950 px-8 py-6 text-6xl font-extrabold tracking-[0.3em] tabular-nums"
        >
          {codigo ?? "· · · · · ·"}
        </div>
        <p className="text-lg text-slate-500">
          El código se renueva solo si se vence. No hace falta tocar nada en la TV.
        </p>
      </aside>
    </div>
  );
}
