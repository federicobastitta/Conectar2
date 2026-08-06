import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useGetPantallaSalaEspera,
  type GetPantallaSalaEsperaParams,
  type PantallaLlamado,
} from "@workspace/api-client-react";
import { Bell, Users, Clock, Volume2, VolumeX, Settings } from "lucide-react";
import { borrarSeleccionTv, urlTv } from "@/pages/tv";

// Acción discreta para cambiar de sala (SmartTV): borra la selección guardada
// del dispositivo y vuelve al selector /tv.
function cambiarSala() {
  borrarSeleccionTv();
  window.location.href = urlTv();
}

function useReloj() {
  const [ahora, setAhora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAhora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return ahora;
}

function reproducirChime(ctx: AudioContext) {
  const notas = [880, 1174.66]; // A5 → D6
  notas.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const inicio = ctx.currentTime + i * 0.28;
    gain.gain.setValueAtTime(0.0001, inicio);
    gain.gain.exponentialRampToValueAtTime(0.4, inicio + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.55);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(inicio);
    osc.stop(inicio + 0.6);
  });
}

// Nombres típicos de voces femeninas en español latino según el sistema
// (Chrome/Windows/Android/macOS exponen distintas). Se prueba en orden.
const VOCES_FEMENINAS_LATINAS = [
  "paulina", "sabina", "mónica", "monica", "angélica", "angelica",
  "helena", "laura", "isabela", "camila", "lupe", "penélope", "penelope",
];

function elegirVozEspanol(): SpeechSynthesisVoice | null {
  const voces = window.speechSynthesis.getVoices();
  const esLatina = (v: SpeechSynthesisVoice) =>
    /^es-(MX|US|419|AR|CO|CL|PE|VE)/i.test(v.lang);
  const esEspanol = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith("es");
  const pareceFemenina = (v: SpeechSynthesisVoice) => {
    const n = v.name.toLowerCase();
    return VOCES_FEMENINAS_LATINAS.some((f) => n.includes(f)) || n.includes("female") || n.includes("mujer");
  };
  return (
    voces.find((v) => esLatina(v) && pareceFemenina(v)) ??
    voces.find((v) => esEspanol(v) && pareceFemenina(v)) ??
    voces.find(esLatina) ??
    voces.find((v) => v.lang === "es-AR") ??
    voces.find(esEspanol) ??
    null
  );
}

// El profesional puede venir "Apellido, Nombre": se muestra siempre como
// "Nombre Apellido", nunca con coma. Pedido del usuario.
function nombreDoctor(nombre: string | null | undefined): string {
  const crudo = (nombre ?? "").trim();
  if (!crudo) return "";
  const partes = crudo.split(",");
  if (partes.length === 2) {
    const [apellido, nombrePila] = partes.map((p) => p.trim());
    return [nombrePila, apellido].filter(Boolean).join(" ");
  }
  return crudo.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

function anunciarPorVoz(llamado: PantallaLlamado) {
  if (!("speechSynthesis" in window)) return;
  // Frase pedida por el usuario: "el Dr <profesional> llama a paciente <paciente> por <consultorio>".
  const destino = llamado.consultorioNombre || llamado.turneraNombre;
  const profesional = nombreDoctor(llamado.profesionalNombre);
  const texto = profesional
    ? `El doctor ${profesional} llama a paciente ${llamado.paciente}${destino ? ` por ${destino}` : ""}`
    : [llamado.paciente, destino].filter(Boolean).join(", ");
  const utterance = new SpeechSynthesisUtterance(texto);
  utterance.lang = "es-MX";
  utterance.rate = 0.9;
  const voz = elegirVozEspanol();
  if (voz) utterance.voice = voz;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function leerFiltro(): GetPantallaSalaEsperaParams {
  const search = new URLSearchParams(window.location.search);
  const salaId = Number(search.get("salaId"));
  if (Number.isInteger(salaId) && salaId > 0) return { salaId };
  const turneraId = Number(search.get("turneraId"));
  if (Number.isInteger(turneraId) && turneraId > 0) return { turneraId };
  const sedeId = Number(search.get("sedeId"));
  if (Number.isInteger(sedeId) && sedeId > 0) return { sedeId };
  return {};
}

export default function PantallaSala() {
  const ahora = useReloj();
  const filtro = useMemo(leerFiltro, []);

  const { data, isLoading } = useGetPantallaSalaEspera(filtro, {
    query: {
      refetchInterval: 5_000,
    },
  });

  const llamados = data?.llamados ?? [];
  const enEspera = data?.enEspera ?? [];
  const actual: PantallaLlamado | undefined = llamados[0];
  const anteriores = llamados.slice(1, 4);

  // Audio: chime + anuncio por voz (requiere activación por interacción del usuario)
  const [audioActivo, setAudioActivo] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioActivoRef = useRef(false);
  const ultimoAnunciadoId = useRef<number | null>(null);
  const ultimoTurnoId = useRef<number | null>(null);

  const toggleAudio = useCallback(() => {
    setAudioActivo((prev) => {
      const nuevo = !prev;
      audioActivoRef.current = nuevo;
      if (nuevo) {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioContext();
        }
        void audioCtxRef.current.resume();
        // No re-anunciar al paciente ya visible al activar el audio
        ultimoAnunciadoId.current = ultimoTurnoId.current;
        // Precargar voces (algunos navegadores las cargan async)
        if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
      } else {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      }
      return nuevo;
    });
  }, []);

  // Destacar visualmente cuando cambia el paciente llamado
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!actual || actual.turnoId === ultimoTurnoId.current) return undefined;
    ultimoTurnoId.current = actual.turnoId;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 6000);

    // Anunciar solo si el audio está activo y no se anunció ya este turno
    if (audioActivoRef.current && actual.turnoId !== ultimoAnunciadoId.current) {
      ultimoAnunciadoId.current = actual.turnoId;
      const ctx = audioCtxRef.current;
      if (ctx) {
        void ctx.resume();
        reproducirChime(ctx);
      }
      const llamado = actual;
      const tVoz = setTimeout(() => anunciarPorVoz(llamado), 900);
      return () => {
        clearTimeout(t);
        clearTimeout(tVoz);
      };
    }
    return () => clearTimeout(t);
  }, [actual]);

  // Cambio de sala discreto desde el control remoto: mantener presionada la
  // tecla OK/Enter (o Escape) unos segundos vuelve al selector /tv.
  useEffect(() => {
    let presionadoDesde: number | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      if (presionadoDesde === null) presionadoDesde = Date.now();
      // Los teclados repiten keydown mientras se mantiene presionada la tecla
      else if (Date.now() - presionadoDesde > 2000) cambiarSala();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") presionadoDesde = null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-10 py-5 border-b border-slate-800 bg-slate-900">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-cyan-500 flex items-center justify-center">
            <Bell className="w-7 h-7 text-slate-950" />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Diagnosticar</h1>
            <p className="text-slate-400 text-lg">
              Sala de espera
              {data?.filtroNombre && (
                <span className="text-cyan-400"> — {data.filtroNombre}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {/* Botón discreto para cambiar de sala (también: mantener OK/Enter 2 s) */}
          <button
            type="button"
            onClick={cambiarSala}
            title="Cambiar de sala"
            aria-label="Cambiar de sala"
            data-testid="boton-cambiar-sala"
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-slate-600 transition-colors hover:text-slate-300 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          >
            <Settings className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={toggleAudio}
            title={audioActivo ? "Silenciar anuncios" : "Activar anuncios con sonido y voz"}
            aria-label={audioActivo ? "Silenciar anuncios" : "Activar anuncios con sonido y voz"}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-lg font-semibold transition-colors ${
              audioActivo
                ? "border-cyan-500 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25"
                : "border-slate-700 bg-slate-800/60 text-slate-400 hover:bg-slate-800"
            }`}
          >
            {audioActivo ? (
              <Volume2 className="w-6 h-6" />
            ) : (
              <VolumeX className="w-6 h-6" />
            )}
            <span className="hidden sm:inline">
              {audioActivo ? "Sonido activado" : "Activar sonido"}
            </span>
          </button>
          <div className="text-right">
            <div className="text-5xl font-bold tabular-nums">
              {ahora.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div className="text-slate-400 text-lg capitalize">
              {ahora.toLocaleDateString("es-AR", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-0 min-h-0">
        {/* Llamado actual */}
        <section className="lg:col-span-2 flex flex-col p-10 gap-8">
          <div
            className={`flex-1 rounded-3xl border-4 flex flex-col items-center justify-center text-center px-8 py-12 transition-colors duration-500 ${
              flash
                ? "border-cyan-400 bg-cyan-500/15 animate-pulse"
                : actual
                  ? "border-cyan-600 bg-slate-900"
                  : "border-slate-800 bg-slate-900/50"
            }`}
          >
            {actual ? (
              <>
                <div className="flex items-center gap-3 text-cyan-400 text-3xl font-semibold uppercase tracking-widest mb-6">
                  <Bell className="w-9 h-9" />
                  Llamando a
                </div>
                <div className="text-7xl xl:text-8xl font-extrabold leading-tight break-words max-w-full">
                  {actual.paciente}
                </div>
                {actual.profesionalNombre && (
                  <div className="mt-6 text-3xl xl:text-4xl text-slate-300">
                    Dr. {nombreDoctor(actual.profesionalNombre)}
                  </div>
                )}
                {/* Consultorio en grande, debajo del médico */}
                {actual.consultorioNombre ? (
                  <div className="mt-4 text-5xl xl:text-6xl font-extrabold text-cyan-300 uppercase">
                    {actual.consultorioNombre}
                  </div>
                ) : (
                  <div className="mt-4 text-4xl xl:text-5xl font-bold text-cyan-300">
                    {actual.turneraNombre}
                  </div>
                )}
              </>
            ) : (
              <>
                <Bell className="w-16 h-16 text-slate-700 mb-6" />
                <div className="text-4xl font-bold text-slate-500">
                  {isLoading ? "Cargando…" : "Sin llamados por el momento"}
                </div>
                <p className="mt-4 text-xl text-slate-600">
                  Aguarde a ser llamado por pantalla
                </p>
              </>
            )}
          </div>

          {/* Llamados anteriores */}
          {anteriores.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold text-slate-400 uppercase tracking-widest mb-4">
                Llamados recientes
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {anteriores.map((ll) => (
                  <div
                    key={ll.turnoId}
                    className="rounded-2xl bg-slate-900 border border-slate-800 px-6 py-4"
                  >
                    <div className="text-2xl font-bold truncate">{ll.paciente}</div>
                    <div className="text-lg text-cyan-400 truncate">
                      {ll.consultorioNombre ?? ll.turneraNombre}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Próximos en espera */}
        <aside className="bg-slate-900 border-l border-slate-800 p-8 flex flex-col min-h-0">
          <div className="flex items-center gap-3 mb-6">
            <Users className="w-8 h-8 text-amber-400" />
            <h2 className="text-3xl font-bold">En espera</h2>
            <span className="ml-auto text-3xl font-bold text-amber-400 tabular-nums">
              {enEspera.length}
            </span>
          </div>
          {enEspera.length === 0 ? (
            <p className="text-xl text-slate-500 mt-4">No hay pacientes en espera</p>
          ) : (
            <ol className="space-y-3 overflow-y-auto">
              {enEspera.map((p, idx) => (
                <li
                  key={p.turnoId}
                  className="flex items-center gap-4 rounded-xl bg-slate-800/70 px-5 py-4"
                >
                  <span className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-xl font-bold shrink-0 tabular-nums">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-2xl font-semibold truncate">{p.paciente}</div>
                    <div className="text-lg text-slate-400 truncate">{p.turneraNombre}</div>
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <span className="flex items-center gap-1.5 text-xl text-slate-300 tabular-nums">
                      <Clock className="w-5 h-5 text-slate-500" />
                      {p.horaInicio}
                    </span>
                    {p.esperaEstimadaMinutos != null && (
                      <span className="text-lg text-amber-400 tabular-nums">
                        ~{p.esperaEstimadaMinutos} min
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </main>
    </div>
  );
}
