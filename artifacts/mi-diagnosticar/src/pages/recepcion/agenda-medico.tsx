import { useEffect, useMemo, useRef, useState } from "react";
import { AgentChat } from "@/components/agentes/AgentChat";
import {
  useAdmitirTurno,
  useLlamarTurno,
  useUpdateTurno,
  useCancelarTurno,
  useDevolverTurnoASala,
  useCreateTurno,
  useGetDisponibilidadTurnera,
  useGetDisponibilidadAgregada,
  useGetProximoHuecoAgregado,
  useGetRecepcionOcupacionMes,
  useGetRecepcionTurnosDia,
  useGetColaSalaEspera,
  useGetProfesional,
  useListConsultorios,
  useListEspecialidades,
  useListSedes,
  useListPacientes,
  useUpdatePaciente,
  useListTurneras,
  useListKlinicosPracticas,
  useBuscarAgendasRapido,
  obtenerLinkVideollamadaTurno,
} from "@workspace/api-client-react";
import { DemandaEspontaneaSwitch } from "@/components/medico/demanda-espontanea-switch";
import { ConsultorioSelector } from "@/components/medico/consultorio-selector";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPracticasCatalogo } from "@/api/ordenes-practicas";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Combobox, MultiCombobox } from "@/components/ui/combobox";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { marcaColorFondo, marcaColorLabel } from "@/lib/marca-color";
import { FichaRecepcionDialog } from "@/components/recepcion/ficha-recepcion-dialog";
import { TokenTurnoDialog } from "@/components/turnos/token-turno-dialog";
import { LlamadoOverlay, type DatosLlamado } from "@/components/turnos/llamado-overlay";
import { ArrowLeft, CalendarDays, CheckCircle2, Clock, Search, Sparkles, Stethoscope, UserPlus, X } from "lucide-react";
import { es } from "date-fns/locale";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function hoyArgentina(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
}

function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fechaADate(f: string): Date {
  const [y, m, d] = f.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dateAFecha(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Colores de fila al estilo agenda clásica: cada estado pinta la fila entera.
const FILA_ESTADO: Record<string, { bg: string; label: string; chip: string }> = {
  pendiente: { bg: "bg-violet-200 dark:bg-violet-900/60", label: "Reservado", chip: "bg-violet-300 text-violet-950" },
  reservado: { bg: "bg-violet-200 dark:bg-violet-900/60", label: "Reservado", chip: "bg-violet-300 text-violet-950" },
  confirmado: { bg: "bg-violet-200 dark:bg-violet-900/60", label: "Confirmado", chip: "bg-violet-300 text-violet-950" },
  publicado: { bg: "bg-violet-200 dark:bg-violet-900/60", label: "Reservado", chip: "bg-violet-300 text-violet-950" },
  arribo: { bg: "bg-amber-200 dark:bg-amber-900/60", label: "Esperando", chip: "bg-amber-300 text-amber-950" },
  en_sala: { bg: "bg-amber-200 dark:bg-amber-900/60", label: "Esperando", chip: "bg-amber-300 text-amber-950" },
  llamado: { bg: "bg-sky-200 dark:bg-sky-900/60", label: "En consulta", chip: "bg-sky-300 text-sky-950" },
  en_atencion: { bg: "bg-blue-200 dark:bg-blue-900/60", label: "En atención", chip: "bg-blue-300 text-blue-950" },
  visto: { bg: "bg-pink-200 dark:bg-pink-900/60", label: "Atendido", chip: "bg-pink-300 text-pink-950" },
  atendido: { bg: "bg-pink-200 dark:bg-pink-900/60", label: "Atendido", chip: "bg-pink-300 text-pink-950" },
  pendiente_informe: { bg: "bg-pink-200 dark:bg-pink-900/60", label: "Atendido", chip: "bg-pink-300 text-pink-950" },
  informando: { bg: "bg-pink-200 dark:bg-pink-900/60", label: "Atendido", chip: "bg-pink-300 text-pink-950" },
  informado: { bg: "bg-pink-200 dark:bg-pink-900/60", label: "Atendido", chip: "bg-pink-300 text-pink-950" },
  visto_usuario: { bg: "bg-pink-200 dark:bg-pink-900/60", label: "Atendido", chip: "bg-pink-300 text-pink-950" },
  ausente: { bg: "bg-yellow-200 dark:bg-yellow-900/60", label: "Ausente", chip: "bg-yellow-300 text-yellow-950" },
  cancelado: { bg: "bg-red-200 dark:bg-red-900/60", label: "Cancelado", chip: "bg-red-300 text-red-950" },
};

// Estados desde los que se puede recepcionar directamente (mismos que en la ficha).
const RECEPCIONABLES = ["pendiente", "reservado", "confirmado", "publicado", "ausente"];

// Agrupación de estados por color, para el filtro de la grilla: los médicos y
// recepción filtran por "los amarillos" (esperando), "los rosas" (atendidos), etc.
const GRUPO_ESTADO: Record<string, string> = {
  pendiente: "reservado",
  reservado: "reservado",
  confirmado: "reservado",
  publicado: "reservado",
  arribo: "esperando",
  en_sala: "esperando",
  llamado: "consulta",
  en_atencion: "consulta",
  visto: "atendido",
  atendido: "atendido",
  pendiente_informe: "atendido",
  informando: "atendido",
  informado: "atendido",
  visto_usuario: "atendido",
  ausente: "ausente",
};

// Chips de filtro por color (los cancelados ya no aparecen en la grilla).
const FILTROS_ESTADO: Array<{ value: string; label: string; punto: string; activo: string }> = [
  { value: "todos", label: "Todos", punto: "bg-slate-400", activo: "bg-slate-200 text-slate-900 ring-slate-500" },
  { value: "libre", label: "Libres", punto: "bg-green-300", activo: "bg-green-200 text-green-900 ring-green-500" },
  { value: "reservado", label: "Reservados", punto: "bg-violet-300", activo: "bg-violet-200 text-violet-900 ring-violet-500" },
  { value: "esperando", label: "Esperando", punto: "bg-amber-300", activo: "bg-amber-200 text-amber-900 ring-amber-500" },
  { value: "consulta", label: "En consulta", punto: "bg-sky-300", activo: "bg-sky-200 text-sky-900 ring-sky-500" },
  { value: "atendido", label: "Atendidos", punto: "bg-pink-300", activo: "bg-pink-200 text-pink-900 ring-pink-500" },
  { value: "ausente", label: "Ausentes", punto: "bg-yellow-300", activo: "bg-yellow-200 text-yellow-900 ring-yellow-500" },
  { value: "validado", label: "Validados", punto: "bg-emerald-400", activo: "bg-emerald-200 text-emerald-900 ring-emerald-500" },
];

// Token IOMA validado con bono real: pinta la fila y suma al filtro "Validados".
function esTurnoValidado(t: { tokenStatus?: string | null; nroBono?: string | null }): boolean {
  return t.tokenStatus === "ACCEPTED" && !!t.nroBono;
}

export default function AgendaPorMedico() {
  const [, navigate] = useLocation();
  const turneraDiaRef = useRef<HTMLDivElement>(null);
  const [fecha, setFecha] = useState<string>(hoyArgentina());
  // La sede elegida queda guardada como preferencia del equipo de recepción.
  const [sedeId, setSedeIdEstado] = useState<string>(
    () => localStorage.getItem("agenda_sede_default") ?? "all",
  );
  const setSedeId = (v: string) => {
    setSedeIdEstado(v);
    localStorage.setItem("agenda_sede_default", v);
  };
  // La especialidad elegida también queda guardada como preferencia.
  const [especialidadId, setEspecialidadIdEstado] = useState<string>(
    () => localStorage.getItem("agenda_especialidad_default") ?? "all",
  );
  const setEspecialidadId = (v: string) => {
    setEspecialidadIdEstado(v);
    localStorage.setItem("agenda_especialidad_default", v);
  };
  const [turneraId, setTurneraId] = useState<string>("all");
  // Filtro por color de estado: p. ej. solo los amarillos (esperando).
  const [estadoFiltro, setEstadoFiltro] = useState<string>("todos");
  const [busqueda, setBusqueda] = useState("");
  // Buscador rápido con asistente (práctica o consulta → agendas que la hacen)
  const [buscadorRapido, setBuscadorRapido] = useState("");
  const [buscadorAbierto, setBuscadorAbierto] = useState(false);
  const buscadorRapidoDeb = useDebounce(buscadorRapido, 300);
  const { data: resultadoBuscador, isFetching: buscandoAgendas } = useBuscarAgendasRapido(
    { q: buscadorRapidoDeb.trim() },
    { query: { enabled: buscadorRapidoDeb.trim().length >= 3 } },
  );
  const elegirAgendaDesdeBuscador = (a: { turneraId: number; sedeId?: number | null; especialidadId?: number | null }) => {
    setSedeId(a.sedeId != null ? String(a.sedeId) : "all");
    setEspecialidadId(a.especialidadId != null ? String(a.especialidadId) : "all");
    setTurneraId(String(a.turneraId));
    setBuscadorRapido("");
  };
  const [mesVisible, setMesVisible] = useState<Date>(fechaADate(hoyArgentina()));
  // Asistente IA embebido: la X lo pliega (y borra la conversación); este
  // botón angosto lo vuelve a abrir.
  const [asistenteAbierto, setAsistenteAbierto] = useState(true);
  const [pacienteSel, setPacienteSel] = useState<{ id: number; nombre: string; apellido: string; dni: string | null; observaciones: string } | null>(null);
  // Observaciones del paciente: se muestran/editar acá y se guardan en la
  // ficha del paciente (campo "Observaciones" en Pacientes), no en el turno.
  const [obsPaciente, setObsPaciente] = useState("");
  const [horaSel, setHoraSel] = useState<string>("");
  const [fichaTurnoId, setFichaTurnoId] = useState<number | null>(null);
  // Validar desde la tabla: abre la carga del token IOMA del turno
  const [tokenTurno, setTokenTurno] = useState<{ id: number; paciente?: string } | null>(null);
  // Último turno registrado desde el panel de la derecha: habilita "Validar
  // token" ahí mismo (clave en guardia, donde el listado es largo).
  const [turnoRecienCreado, setTurnoRecienCreado] = useState<{ id: number; paciente: string } | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { user } = useAuth();
  // Un médico solo ve sus propias agendas; el resto del staff las ve todas.
  const esMedico = user?.rol === "medico" && user?.profesionalId != null;

  // Confirmación visible al volver de finalizar una consulta (solo médicos):
  // la pantalla de consulta deja una marca en sessionStorage justo antes de
  // navegar; acá se consume una sola vez y se muestra un banner unos segundos.
  const [consultaRegistrada, setConsultaRegistrada] = useState<string | null>(null);
  useEffect(() => {
    if (!esMedico) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("consulta-registrada");
      if (raw) sessionStorage.removeItem("consulta-registrada");
    } catch { /* best-effort */ }
    if (!raw) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      const { paciente, ts } = JSON.parse(raw) as { paciente?: string; ts?: number };
      // Marca vieja (p. ej. quedó de otra pestaña): no confundir al médico.
      if (paciente && ts && Date.now() - ts <= 60_000) {
        setConsultaRegistrada(paciente);
        t = setTimeout(() => setConsultaRegistrada(null), 8000);
      }
    } catch { /* marca corrupta: ignorar */ }
    return () => { if (t) clearTimeout(t); };
  }, [esMedico]);

  const { data: especialidades } = useListEspecialidades();
  const { data: sedes } = useListSedes();
  // Si la sede o especialidad guardadas ya no existen (se borraron), volvemos a "Todas".
  useEffect(() => {
    if (sedes && sedeId !== "all" && !sedes.some(s => String(s.id) === sedeId)) {
      setSedeId("all");
    }
  }, [sedes]);
  useEffect(() => {
    if (especialidades && especialidadId !== "all" && !especialidades.some(e => String(e.id) === especialidadId)) {
      setEspecialidadId("all");
    }
  }, [especialidades]);
  // Todas las agendas (activas e inactivas): acá se consulta el histórico completo.
  const { data: turnerasTodas } = useListTurneras();
  const turneras = useMemo(
    () => esMedico
      ? (turnerasTodas ?? []).filter(t =>
          t.profesionalId === user?.profesionalId
          // Incluye agendas grupales en las que el médico participa.
          || (t.participantesIds ?? []).some(id => id === user?.profesionalId))
      : turnerasTodas,
    [turnerasTodas, esMedico, user?.profesionalId],
  );
  // Turneras que definen la ocupación del calendario según los filtros activos.
  const turnerasFiltradas = useMemo(() => {
    let lista = turneras ?? [];
    if (sedeId !== "all") {
      lista = lista.filter(t => String(t.sedeId ?? "") === sedeId);
    }
    if (especialidadId !== "all") {
      lista = lista.filter(t => String(t.especialidadId ?? "") === especialidadId);
    }
    if (turneraId !== "all") {
      lista = lista.filter(t => String(t.id) === turneraId);
    }
    return lista;
  }, [turneras, sedeId, especialidadId, turneraId]);

  const mesParam = `${mesVisible.getFullYear()}-${String(mesVisible.getMonth() + 1).padStart(2, "0")}`;
  const hayFiltro = esMedico || sedeId !== "all" || especialidadId !== "all" || turneraId !== "all";
  const { data: ocupacionMes } = useGetRecepcionOcupacionMes(
    {
      mes: mesParam,
      ...(hayFiltro ? { turneraIds: turnerasFiltradas.map(t => t.id).join(",") } : {}),
    },
    { query: { enabled: !hayFiltro || turnerasFiltradas.length > 0 } },
  );

  // Días pintados por nivel de ocupación: lleno (rojo), medio (amarillo), libre (verde).
  const diasOcupacion = useMemo(() => {
    const llenos: Date[] = [];
    const medios: Date[] = [];
    const libres: Date[] = [];
    const cancelados: Date[] = [];
    const hoyStr = hoyArgentina();
    for (const d of ocupacionMes ?? []) {
      // El pasado queda en blanco: los colores solo aplican de hoy en adelante.
      if (d.fecha < hoyStr) continue;
      const date = fechaADate(d.fecha);
      if (d.cancelado) { cancelados.push(date); continue; }
      if (d.capacidad <= 0) continue;
      const ratio = d.ocupados / d.capacidad;
      if (ratio >= 1) llenos.push(date);
      else if (ratio >= 0.5) medios.push(date);
      else libres.push(date);
    }
    return { llenos, medios, libres, cancelados, hoy: [fechaADate(hoyStr)] };
  }, [ocupacionMes]);

  const { data: turnos, isLoading } = useGetRecepcionTurnosDia(
    { fecha },
    { query: { refetchInterval: 30_000 } },
  );

  // Palabras extra para el autocompletado: códigos y nombres de las prácticas de cada agenda
  // (permite encontrar la agenda escribiendo p. ej. "ecografía mamaria" o el código).
  const keywordsTurnera = (t: NonNullable<typeof turneras>[number]): string =>
    (t.practicas ?? []).map(p => `${p.codigo} ${p.descripcion ?? ""}`).join(" ");

  const opcionesAgenda = useMemo(() => {
    const lista = (turneras ?? [])
      // Las agendas inactivas no se ofrecen para cargar turnos: solo generan
      // confusión con entradas repetidas del mismo profesional.
      .filter(t => t.activa)
      .filter(t => sedeId === "all" || String(t.sedeId ?? "") === sedeId)
      .filter(t => especialidadId === "all" || String(t.especialidadId ?? "") === especialidadId)
      .map(t => ({
        value: String(t.id),
        label: `${t.nombre ?? `Turnera ${t.id}`}${t.activa ? "" : " (inactiva)"}`,
        keywords: keywordsTurnera(t),
        esGuardia: !!t.esGuardia,
      }))
      // Las guardias siempre van primero en la lista de agendas
      .sort((a, b) => Number(b.esGuardia) - Number(a.esGuardia) || a.label.localeCompare(b.label, "es"));
    return [{ value: "all", label: esMedico ? "Todas mis agendas" : "Todos los profesionales" }, ...lista];
  }, [turneras, sedeId, especialidadId, esMedico]);

  // Catálogo de prácticas: aporta códigos y subprácticas (ej. "Eco Mamas") al autocompletado.
  const { data: catalogoData } = useQuery({
    queryKey: ["practicas-catalogo", true],
    queryFn: () => getPracticasCatalogo(true),
    staleTime: 5 * 60_000,
  });

  // Para cada especialidad, sus keywords son las prácticas de sus agendas
  // más las del catálogo cuya especialidad coincide por nombre.
  const keywordsPorEspecialidad = useMemo(() => {
    const mapa = new Map<string, string>();
    const agregar = (clave: string, kw: string) => {
      if (kw) mapa.set(clave, `${mapa.get(clave) ?? ""} ${kw}`.trim());
    };
    for (const t of turneras ?? []) {
      if (t.especialidadId == null) continue;
      agregar(String(t.especialidadId), keywordsTurnera(t));
    }
    for (const p of catalogoData?.practicas ?? []) {
      const espCat = normalizar(p.especialidad ?? "");
      const categoria = normalizar(p.categoria ?? "");
      // Coincide por nombre exacto de especialidad, o por categoría contenida
      // en el nombre (ej. categoría "ecografia" → "Ecografía", "Ecografias Lomas...").
      const matches = (especialidades ?? []).filter(e => {
        const nombre = normalizar(e.nombre);
        return (espCat && nombre === espCat) || (categoria.length >= 4 && nombre.includes(categoria));
      });
      for (const esp of matches) agregar(String(esp.id), `${p.codigo} ${p.nombre} ${(p.sinonimos ?? []).join(" ")}`);
    }
    return mapa;
  }, [turneras, catalogoData, especialidades]);

  const q = normalizar(busqueda.trim());
  const filas = useMemo(() => {
    // Los turnos cancelados no ocupan lugar: desaparecen del listado y su
    // horario vuelve a ofrecerse como hueco libre (la disponibilidad ya los
    // ignora). El día igual queda marcado en rojo en el calendario si se
    // canceló la atención completa.
    let lista = (turnos ?? []).filter(t => t.estado !== "cancelado");
    if (esMedico) {
      // El médico solo ve los turnos de sus propias agendas.
      const mias = new Set((turneras ?? []).map(t => normalizar(t.nombre ?? "")));
      lista = lista.filter(t => mias.has(normalizar(t.turneraNombre ?? "")));
    }
    if (sedeId !== "all") {
      // Los turnos del día no traen la sede: se filtra por las agendas de esa sede.
      const deSede = new Set(
        (turneras ?? [])
          .filter(t => String(t.sedeId ?? "") === sedeId)
          .map(t => normalizar(t.nombre ?? "")),
      );
      lista = lista.filter(t => deSede.has(normalizar(t.turneraNombre ?? "")));
    }
    if (especialidadId !== "all") {
      const esp = especialidades?.find(e => String(e.id) === especialidadId)?.nombre ?? "";
      lista = lista.filter(t => normalizar(t.especialidad ?? "").includes(normalizar(esp)));
    }
    if (turneraId !== "all") {
      const tu = (turneras ?? []).find(t => String(t.id) === turneraId);
      if (tu) {
        const clave = normalizar(tu.nombre ?? "");
        lista = lista.filter(t => normalizar(t.turneraNombre ?? "") === clave);
      }
    }
    // El buscador filtra la lista del día SOLO mientras se está buscando un
    // turno existente. Si ya se eligió un paciente para registrarle un turno
    // nuevo, o ya se eligió un horario libre (la intención es reservar ESE
    // turno), la agenda sigue mostrando todos los turnos del día.
    if (q && !pacienteSel && !horaSel) {
      lista = lista.filter(t =>
        [t.pacienteNombre, t.pacienteApellido, t.pacienteDni, t.pacienteTelefono, t.numeroHc].some(
          c => c && normalizar(String(c)).includes(q),
        ),
      );
    }
    return [...lista].sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
  }, [turnos, sedeId, especialidadId, turneraId, q, especialidades, turneras, esMedico, pacienteSel, horaSel]);

  const fechaLegible = fechaADate(fecha).toLocaleDateString("es-AR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // --- Panel "Cargar turno": búsqueda de pacientes + slots del día ---
  const busquedaDebounced = useDebounce(busqueda.trim(), 350);
  const { data: pacientesData, isFetching: buscandoPacientes } = useListPacientes(
    { q: busquedaDebounced, soloActivos: true, limit: 8 },
    { query: { enabled: !esMedico && busquedaDebounced.length >= 2 && !pacienteSel } },
  );
  const resultadosPacientes = pacientesData?.data ?? [];

  const { data: slotsDia } = useGetDisponibilidadTurnera(
    Number(turneraId), fecha,
    { query: { enabled: turneraId !== "all" } },
  );
  const horasDisponibles = useMemo(
    () => (slotsDia ?? []).filter(s => s.disponible).map(s => s.horaInicio),
    [slotsDia],
  );

  // Disponibilidad agregada: con "Todos los profesionales" + una especialidad
  // elegida, se muestran los turnos libres de TODAS las agendas coincidentes.
  const verAgregada = !esMedico && turneraId === "all" && especialidadId !== "all";
  const { data: slotsAgregados } = useGetDisponibilidadAgregada(
    {
      fecha,
      ...(sedeId !== "all" ? { sedeId: Number(sedeId) } : {}),
      especialidadId: Number(especialidadId),
    },
    { query: { enabled: verAgregada } },
  );

  // Día completo en la vista combinada: se busca el próximo slot libre entre
  // todos los profesionales de esa sede+especialidad (días siguientes) para
  // ofrecerlo en un aviso con salto directo a esa fecha.
  const diaCombinadoCompleto = verAgregada && slotsAgregados != null && slotsAgregados.length === 0;
  const { data: proximoHueco } = useGetProximoHuecoAgregado(
    {
      desde: fecha,
      ...(sedeId !== "all" ? { sedeId: Number(sedeId) } : {}),
      especialidadId: Number(especialidadId),
    },
    { query: { enabled: diaCombinadoCompleto } },
  );
  const sugerenciaHueco = diaCombinadoCompleto ? proximoHueco?.[0] : undefined;

  // Al clickear un hueco libre de la vista combinada se preseleccionan agenda
  // y hora juntas; esta marca evita que el efecto de abajo borre la hora.
  const [preseleccion, setPreseleccion] = useState<{ turneraId: string; hora: string } | null>(null);

  // Si cambia la agenda o la fecha, la hora elegida deja de ser válida.
  useEffect(() => {
    if (preseleccion && preseleccion.turneraId === turneraId) {
      setHoraSel(preseleccion.hora);
      setPreseleccion(null);
      return;
    }
    setHoraSel("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turneraId, fecha]);

  // Filas de la tabla: turnos ocupados + huecos libres (en verde) cuando hay una agenda elegida.
  type FilaTabla =
    | { tipo: "turno"; hora: string; turno: (typeof filas)[number] }
    | { tipo: "libre"; hora: string; turneraId?: number; turneraNombre?: string; profesionalNombre?: string | null };
  const filasTabla = useMemo<FilaTabla[]>(() => {
    // Filtro por color: deja solo los turnos de ese grupo de estado. Los
    // huecos libres tienen su propio chip ("Libres") y también se ven en "Todos".
    const filtradas = estadoFiltro === "todos"
      ? filas
      : estadoFiltro === "libre"
        ? []
        : estadoFiltro === "validado"
          ? filas.filter(esTurnoValidado)
          : filas.filter(t => (GRUPO_ESTADO[t.estado] ?? "") === estadoFiltro);
    const ocupadas: FilaTabla[] = filtradas.map(t => ({ tipo: "turno", hora: t.horaInicio, turno: t }));
    const verLibres = estadoFiltro === "todos" || estadoFiltro === "libre";
    // Los huecos libres se intercalan SIEMPRE (los de la agenda elegida, o los
    // combinados de todos los profesionales): la búsqueda solo filtra los
    // ocupados. Si se escondieran al tipear un DNI, no se podría cargar un
    // turno nuevo para ese paciente.
    if (turneraId !== "all" && verLibres) {
      const libres: FilaTabla[] = (slotsDia ?? [])
        .filter(s => s.disponible)
        .map(s => ({ tipo: "libre", hora: s.horaInicio }));
      return [...ocupadas, ...libres].sort((a, b) => a.hora.localeCompare(b.hora));
    }
    if (verAgregada && verLibres) {
      const libres: FilaTabla[] = (slotsAgregados ?? []).map(s => ({
        tipo: "libre",
        hora: s.horaInicio,
        turneraId: s.turneraId,
        turneraNombre: s.turneraNombre,
        profesionalNombre: s.profesionalNombre ?? null,
      }));
      return [...ocupadas, ...libres].sort((a, b) => a.hora.localeCompare(b.hora));
    }
    return ocupadas;
  }, [filas, slotsDia, turneraId, verAgregada, slotsAgregados, estadoFiltro]);

  // Pastillas de médicos atendiendo y demora estimada (solo para HOY, con
  // datos de la cola de sala de espera que trae la espera estimada real).
  const esHoy = fecha === hoyArgentina();
  const { data: colaHoy } = useGetColaSalaEspera(
    {},
    { query: { refetchInterval: 20_000, enabled: esHoy } },
  );
  const medicosAtendiendoAgenda = useMemo(() => {
    const nombres = new Set<string>();
    for (const t of filas) {
      if (!["llamado", "en_atencion"].includes(t.estado)) continue;
      // En guardia el turno no tiene profesional asignado: el que atiende es
      // el que llamó al paciente. Sin ese dato, cae al nombre de la agenda.
      nombres.add(t.llamadoPorNombre || t.profesionalNombre || t.turneraNombre || "Sin profesional");
    }
    return [...nombres].sort((a, b) => a.localeCompare(b, "es"));
  }, [filas]);
  const demoraEstimadaAgenda = useMemo(() => {
    if (!esHoy) return null;
    // La demora respeta los filtros de la vista: si hay una agenda elegida es
    // solo de esa; si no, solo de las agendas presentes en la grilla filtrada
    // (sede/médico/especialidad), matcheando por nombre de turnera.
    const filtro: (c: { turneraId: number; turneraNombre: string }) => boolean =
      turneraId !== "all"
        ? (c) => c.turneraId === Number(turneraId)
        : (() => {
            const nombresVisibles = new Set(filas.map(f => f.turneraNombre));
            return (c) => nombresVisibles.has(c.turneraNombre);
          })();
    const valores = (colaHoy ?? [])
      .filter(c => ["arribo", "en_sala"].includes(c.estado))
      .filter(filtro)
      .map(c => c.esperaEstimadaMinutos)
      .filter((v): v is number => typeof v === "number");
    if (valores.length === 0) return null;
    return Math.round(valores.reduce((a, b) => a + b, 0) / valores.length);
  }, [colaHoy, esHoy, turneraId, filas]);

  // Cuántos turnos hay de cada color, para mostrar en los botones de filtro.
  const conteosFiltro = useMemo(() => {
    const c: Record<string, number> = { todos: filas.length };
    for (const t of filas) {
      const g = GRUPO_ESTADO[t.estado];
      if (g) c[g] = (c[g] ?? 0) + 1;
      if (esTurnoValidado(t)) c.validado = (c.validado ?? 0) + 1;
    }
    const libres = turneraId !== "all"
      ? (slotsDia ?? []).filter(s => s.disponible).length
      : verAgregada ? (slotsAgregados ?? []).length : 0;
    if (libres > 0) c.libre = libres;
    return c;
  }, [filas, slotsDia, turneraId, verAgregada, slotsAgregados]);

  // Observaciones del turno editables desde la tabla (recepción); los médicos
  // las ven en modo lectura.
  const [obsEditando, setObsEditando] = useState<{ turnoId: number; texto: string } | null>(null);
  const obsCancelarRef = useRef(false);
  const guardarObs = useUpdateTurno({
    mutation: {
      onSuccess: () => {
        setObsEditando(null);
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
        });
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { error?: string } })?.data ?? {};
        toast({
          title: "No se pudo guardar la observación",
          description: e.error ?? "Probá de nuevo.",
          variant: "destructive",
        });
      },
    },
  });

  // Recepcionar directo desde la tabla: si el servidor exige algo más
  // (token, código de supervisor), se abre la ficha para completarlo.
  const admitir = useAdmitirTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Paciente recepcionado", description: "Pasó a la sala de espera." });
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
        });
      },
      onError: (err: unknown, variables) => {
        const e = (err as { data?: { error?: string } })?.data ?? {};
        toast({
          title: "No se pudo recepcionar",
          description: e.error ?? "Completá la validación desde la ficha.",
          variant: "destructive",
        });
        setFichaTurnoId(variables.id);
      },
    },
  });

  // Consultorio del médico logueado: es lo que anuncia la pantalla TV al llamar,
  // y acá se usa para replicar ese anuncio en el efecto visual del llamado.
  const { data: profesionalYo } = useGetProfesional(user?.profesionalId ?? 0, {
    query: { enabled: esMedico },
  });
  const { data: consultoriosLista } = useListConsultorios({
    query: { enabled: esMedico },
  });
  const consultorioNombre = useMemo(
    () => (consultoriosLista ?? []).find(c => c.id === profesionalYo?.consultorioId)?.nombre ?? null,
    [consultoriosLista, profesionalYo?.consultorioId],
  );

  // Efecto visual estilo TV al confirmar un llamado (se cierra solo).
  const [llamadoVisual, setLlamadoVisual] = useState<DatosLlamado | null>(null);

  // Llamar al paciente: aparece en la pantalla de la sala de espera
  const llamar = useLlamarTurno({
    mutation: {
      onSuccess: (_data, vars) => {
        toast({ title: "Paciente llamado", description: "Aparece en la pantalla de la sala de espera." });
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
        });
        const t = (turnos ?? []).find(x => x.turnoId === vars.id);
        if (t) {
          setLlamadoVisual({
            paciente: `${t.pacienteApellido}, ${t.pacienteNombre}`,
            profesional: t.profesionalNombre,
            consultorio: consultorioNombre,
            turnera: t.turneraNombre,
          });
        }
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { error?: string } })?.data ?? {};
        toast({
          title: "No se pudo llamar",
          description: e.error ?? "El paciente tiene que estar recepcionado (esperando).",
          variant: "destructive",
        });
      },
    },
  });

  // Cancelar la consulta (ej.: se lo llamó y el paciente no vino)
  const cancelar = useCancelarTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Consulta cancelada", description: "El turno quedó cancelado." });
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
        });
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { error?: string } })?.data ?? {};
        toast({
          title: "No se pudo cancelar",
          description: e.error ?? "Probá de nuevo en unos segundos.",
          variant: "destructive",
        });
      },
    },
  });

  // Destrabar a un paciente que quedó EN CONSULTA (el médico lo llamó por
  // error o se olvidó de finalizar): vuelve a la sala de espera con un clic.
  const devolverASala = useDevolverTurnoASala({
    mutation: {
      onSuccess: () => {
        toast({ title: "Paciente devuelto a la sala de espera", description: "Quedó disponible para ser llamado de nuevo." });
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
        });
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { error?: string } })?.data ?? {};
        toast({
          title: "No se pudo devolver a la sala",
          description: e.error ?? "Probá de nuevo en unos segundos.",
          variant: "destructive",
        });
      },
    },
  });

  const actualizarPaciente = useUpdatePaciente();
  // Observaciones a guardar en la ficha si el turno se registra bien.
  const obsPendienteRef = useRef<{ pacienteId: number; texto: string } | null>(null);

  const crearTurno = useCreateTurno({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Turno registrado", description: `${pacienteSel?.apellido}, ${pacienteSel?.nombre} — ${fecha}${horaSel ? ` ${horaSel} hs` : " (por orden de llegada)"}` });
        // El turno quedó registrado: recién ahora se guardan las observaciones
        // en la ficha del paciente (visibles en Pacientes).
        const obsPend = obsPendienteRef.current;
        obsPendienteRef.current = null;
        if (obsPend) {
          actualizarPaciente.mutate(
            { id: obsPend.pacienteId, data: { observaciones: obsPend.texto } },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({
                  predicate: qy => String(qy.queryKey[0] ?? "").includes("/pacientes"),
                });
              },
              onError: () => {
                toast({
                  title: "No se pudieron guardar las observaciones",
                  description: "El turno quedó registrado igual; cargalas desde la ficha del paciente.",
                  variant: "destructive",
                });
              },
            },
          );
        }
        // Deja a mano el botón "Validar token" del turno recién registrado,
        // así recepción no tiene que buscar al paciente en el listado.
        if (data?.id != null && pacienteSel) {
          setTurnoRecienCreado({
            id: data.id,
            paciente: `${pacienteSel.apellido}, ${pacienteSel.nombre}`,
          });
        }
        setPacienteSel(null);
        setHoraSel("");
        setBusqueda("");
        setObsPaciente("");
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
        });
        void queryClient.invalidateQueries({
          predicate: qy => String(qy.queryKey[0] ?? "").includes("/disponibilidad"),
        });
      },
      onError: (e: unknown) => {
        const msg = e instanceof Error ? e.message : "No se pudo registrar el turno";
        toast({ title: "Error al registrar turno", description: msg, variant: "destructive" });
        // El caso típico es un 409: otro puesto tomó el slot mientras la vista
        // (que se refresca cada 30 s) todavía lo mostraba libre. Refrescamos
        // los huecos (individuales y combinados) y la agenda del día para que
        // el hueco perdido desaparezca de inmediato.
        void queryClient.invalidateQueries({
          predicate: qy => {
            const k = String(qy.queryKey[0] ?? "");
            return k.includes("/disponibilidad") || k.includes("/recepcion/");
          },
        });
      },
    },
  });

  // Tipo de estudio: si la agenda elegida tiene códigos que corresponden a
  // más de una práctica del catálogo (ej. eco mamaria vs. abdominal), la
  // recepcionista debe elegir cuál es antes de registrar. Con una sola se
  // usa esa sin preguntar; el Robot necesita el id para el código exacto.
  const { data: klinicosPracticasData } = useListKlinicosPracticas();
  const turneraSel = useMemo(
    () => (turneras ?? []).find(t => String(t.id) === turneraId) ?? null,
    [turneras, turneraId],
  );
  // Agendas de estudios (ecografías, radiografías, etc.): aunque no tengan
  // prácticas tildadas, hay que preguntar el tipo de estudio igual — sin él
  // el turno viaja sin código y la validación queda en revisión manual.
  const esAgendaDeEstudios = useMemo(() => {
    const texto = normalizar(`${turneraSel?.nombre ?? ""} ${turneraSel?.especialidad?.nombre ?? ""}`);
    return /ecograf|radiograf|\brx\b|doppler|holter|electrocardio|mamograf|presurometr|espirometr|ecocardio|densitometr|tomograf/.test(texto);
  }, [turneraSel]);
  const practicasDeAgenda = useMemo(() => {
    const activas = (klinicosPracticasData ?? []).filter(p => p.activo !== false);
    const codigosAgenda = new Set((turneraSel?.practicas ?? []).map(p => p.codigo.trim()).filter(Boolean));
    if (codigosAgenda.size === 0) {
      // Sin prácticas tildadas en la agenda: en agendas de estudios se ofrece
      // el catálogo completo para no dejar el turno sin código.
      return esAgendaDeEstudios ? activas : [];
    }
    return activas.filter(p => {
      const cods = (p.codigos ?? []).map(c => c.trim()).filter(Boolean);
      return cods.length > 0 && cods.every(c => codigosAgenda.has(c));
    });
  }, [klinicosPracticasData, turneraSel, esAgendaDeEstudios]);
  // Puede haber más de un estudio en la misma visita (ej: eco abdomen +
  // eco tiroides): se tildan todos y viajan juntos con el turno.
  const [practicasSel, setPracticasSel] = useState<string[]>([]);
  // Al cambiar de agenda, los estudios elegidos dejan de ser válidos.
  useEffect(() => { setPracticasSel([]); }, [turneraId]);
  // Si cambia la agenda o el día, el turno recién registrado ya no corresponde
  // al contexto visible: ocultar el botón "Validar token" del panel.
  useEffect(() => { setTurnoRecienCreado(null); }, [turneraId, fecha]);
  const debeElegirPractica = practicasDeAgenda.length > 1;
  const practicasElegidasIds = debeElegirPractica
    ? practicasSel.map(Number)
    : practicasDeAgenda.length === 1 ? [practicasDeAgenda[0].id] : [];
  const faltaPractica = debeElegirPractica && practicasSel.length === 0;

  // Guardia seleccionada: se registra por orden de llegada, sin elegir hora.
  const esGuardiaSel = useMemo(
    () => turneraId !== "all" && !!(turneras ?? []).find(t => String(t.id) === turneraId)?.esGuardia,
    [turneras, turneraId],
  );

  // Si quedó activo el filtro "Libres" y se pasa a una guardia (donde no
  // existe ese concepto), se vuelve a "Todos" para no dejar la grilla vacía.
  useEffect(() => {
    if (esGuardiaSel && estadoFiltro === "libre") setEstadoFiltro("todos");
  }, [esGuardiaSel, estadoFiltro]);

  // Guardia: se puede mirar el historial y también fechas futuras (turnos
  // Check in reservados desde la app del paciente), pero el ingreso de
  // pacientes por orden de llegada es solo hoy.
  const guardiaMirandoAtras = esGuardiaSel && fecha !== hoyArgentina();

  // Al elegir una especialidad de guardia no hace falta elegir profesional:
  // se selecciona sola la agenda de guardia (igual que en "Todas las agendas").
  useEffect(() => {
    if (turneraId !== "all" || especialidadId === "all") return;
    const guardia = (turneras ?? []).find(
      (t) => t.esGuardia && String(t.especialidadId ?? "") === especialidadId
        && (sedeId === "all" || String(t.sedeId ?? "") === sedeId),
    );
    if (guardia) setTurneraId(String(guardia.id));
  }, [turneras, especialidadId, turneraId, sedeId]);


  function registrarTurno() {
    if (!pacienteSel || turneraId === "all") return;
    if (guardiaMirandoAtras) return; // en guardia solo se ingresa hoy
    // En guardia la hora es la de llegada: el servidor acomoda la cola solo.
    const ahora = new Date();
    const horaLlegada = `${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}`;
    const hora = esGuardiaSel ? horaLlegada : horaSel;
    if (!hora) return;
    if (faltaPractica) return; // hay que elegir el tipo de estudio primero
    setTurnoRecienCreado(null);
    // Si recepción escribió/cambió las observaciones, se guardan en la ficha
    // del paciente recién cuando el turno se registra OK (no antes, para no
    // tocar la ficha si el turno falla por un choque de horario).
    obsPendienteRef.current =
      obsPaciente.trim() !== (pacienteSel.observaciones ?? "").trim()
        ? { pacienteId: pacienteSel.id, texto: obsPaciente.trim() }
        : null;
    crearTurno.mutate({
      data: {
        turneraId: Number(turneraId),
        pacienteId: pacienteSel.id,
        fecha,
        horaInicio: hora,
        ...(practicasElegidasIds.length > 0 ? { klinicosPracticaIds: practicasElegidasIds } : {}),
      },
    });
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-56px)]">
      <LlamadoOverlay llamado={llamadoVisual} onCerrar={() => setLlamadoVisual(null)} />
      {/* Barra superior */}
      <div className="px-4 py-2.5 border-b bg-background shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2 -ml-2"
            onClick={() => navigate(esMedico ? "/consultorio" : "/recepcion")} data-testid="volver-recepcion">
            <ArrowLeft className="w-4 h-4" /> {esMedico ? "Consultorio" : "Recepción"}
          </Button>
          <h1 className="text-lg md:text-xl font-bold text-foreground truncate">
            {esMedico ? "Mi agenda" : "Agenda por médico"}
          </h1>
        </div>

        {/* Banner de confirmación: la consulta recién finalizada quedó guardada */}
        {consultaRegistrada && (
          <div
            className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200"
            data-testid="banner-consulta-registrada"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="font-medium">Consulta de {consultaRegistrada} registrada.</span>
            <span className="hidden sm:inline">La evolución quedó guardada en la historia clínica.</span>
            <button
              type="button"
              className="ml-auto text-green-700 hover:text-green-900 dark:text-green-300"
              onClick={() => setConsultaRegistrada(null)}
              aria-label="Cerrar aviso"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Médico: interruptor de demanda espontánea + su consultorio a mano */}
        {esMedico && (
          <div className="flex items-stretch gap-2 flex-wrap">
            <div className="flex-1 min-w-[280px]"><DemandaEspontaneaSwitch /></div>
            <ConsultorioSelector />
          </div>
        )}

        <div className="flex items-start gap-3 flex-wrap">
          {/* Filtros a la izquierda */}
          <div className="flex flex-col gap-2 rounded-lg border p-3 min-w-[280px]">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground w-24 shrink-0">Sede</span>
              <div className="flex-1">
                <Combobox
                  options={[
                    { value: "all", label: "Todas las sedes" },
                    ...(sedes ?? []).map(s => ({ value: String(s.id), label: s.nombre })),
                  ]}
                  value={sedeId}
                  onChange={(v) => {
                    setSedeId(v);
                    setTurneraId("all");
                    // Si la especialidad elegida no atiende en la nueva sede, se limpia.
                    if (especialidadId !== "all" && v !== "all" && !(turneras ?? []).some(t =>
                      String(t.sedeId ?? "") === v && String(t.especialidadId ?? "") === especialidadId)) {
                      setEspecialidadId("all");
                    }
                  }}
                  placeholder="Sede"
                  testId="agenda-medico-sede"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground w-24 shrink-0">Especialidad</span>
              <div className="flex-1">
                <Combobox
                  options={[
                    { value: "all", label: "Todas las especialidades" },
                    ...(especialidades ?? [])
                      // Con una sede elegida, solo las especialidades que tienen agendas en esa sede.
                      .filter(e => sedeId === "all" || (turneras ?? []).some(t =>
                        String(t.sedeId ?? "") === sedeId && String(t.especialidadId ?? "") === String(e.id)))
                      .map(e => ({
                        value: String(e.id),
                        label: e.nombre,
                        keywords: `${e.codigo ?? ""} ${keywordsPorEspecialidad.get(String(e.id)) ?? ""}`.trim(),
                      })),
                  ]}
                  value={especialidadId}
                  onChange={(v) => {
                    setEspecialidadId(v);
                    // Especialidad de guardia: la agenda grupal no tiene profesional
                    // asignado, se selecciona sola para abrir el buscador de turnos.
                    const guardia = v !== "all"
                      ? (turneras ?? []).find(t =>
                          t.esGuardia && t.activa &&
                          String(t.especialidadId ?? "") === v &&
                          (sedeId === "all" || String(t.sedeId ?? "") === sedeId))
                      : undefined;
                    setTurneraId(guardia ? String(guardia.id) : "all");
                  }}
                  placeholder="Especialidad"
                  testId="agenda-medico-especialidad"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground w-24 shrink-0">Profesional</span>
              <div className="flex-1">
                <Combobox
                  options={opcionesAgenda}
                  value={turneraId}
                  onChange={setTurneraId}
                  placeholder="Profesional"
                  testId="agenda-medico-turnera"
                />
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground pt-1">
              <CalendarDays className="w-4 h-4" />
              <span className="capitalize" data-testid="agenda-medico-fecha">{fechaLegible}</span>
            </div>
          </div>

          {/* Calendario mensual, como la agenda clásica. En guardia sirve para
              consultar días anteriores y ver los Check in reservados a futuro
              (el ingreso por orden de llegada es solo hoy). */}
          <div className="rounded-lg border relative">
            <Calendar
              mode="single"
              selected={fechaADate(fecha)}
              month={mesVisible}
              onMonthChange={setMesVisible}
              onSelect={(d) => { if (d) setFecha(dateAFecha(d)); }}
              locale={es}
              className="p-3 [--cell-size:2.5rem]"
              classNames={{
                weekdays: "flex gap-1",
                weekday: "text-muted-foreground flex-1 select-none text-[0.75rem] font-medium capitalize",
                week: "mt-1 flex w-full gap-1",
                day: "group/day relative aspect-square h-full w-full select-none p-0 text-center",
              }}
              modifiers={{
                lleno: diasOcupacion.llenos,
                medio: diasOcupacion.medios,
                libre: diasOcupacion.libres,
                cancelado: diasOcupacion.cancelados,
                hoy: diasOcupacion.hoy,
              }}
              modifiersClassNames={{
                lleno: "[&>button]:rounded-md [&>button]:bg-red-500/80 [&>button]:text-white [&>button]:hover:bg-red-500 dark:[&>button]:bg-red-600/70",
                medio: "[&>button]:rounded-md [&>button]:bg-yellow-400/80 [&>button]:text-yellow-950 [&>button]:hover:bg-yellow-400 dark:[&>button]:bg-yellow-500/70",
                libre: "[&>button]:rounded-md [&>button]:bg-green-500/70 [&>button]:text-white [&>button]:hover:bg-green-500 dark:[&>button]:bg-green-600/60",
                cancelado: "[&>button]:rounded-md [&>button]:bg-red-700 [&>button]:text-white [&>button]:line-through [&>button]:hover:bg-red-700 dark:[&>button]:bg-red-800",
                // Hoy pisa cualquier color de ocupación: azul, siempre visible.
                hoy: "[&>button]:rounded-md [&>button]:!bg-blue-600 [&>button]:!text-white [&>button]:hover:!bg-blue-700 [&>button]:font-semibold",
              }}
              data-testid="agenda-medico-calendario"
            />
            {fecha !== hoyArgentina() && (
              <Button size="sm"
                className="absolute top-2 right-2 h-6 px-2 text-[11px] bg-amber-500 hover:bg-amber-600 text-white"
                onClick={() => setFecha(hoyArgentina())} data-testid="agenda-medico-hoy">
                Hoy
              </Button>
            )}
          </div>

          {/* Asistente IA de recepción, embebido entre el calendario y la
              carga de turno: busca agendas por práctica/código/profesional/
              especialidad y ofrece los próximos horarios libres. */}
          {/* self-stretch sin min-h propio: la altura la marca el calendario,
              el chat scrollea adentro si la conversación es larga. */}
          {!asistenteAbierto && (
            <button
              type="button"
              onClick={() => setAsistenteAbierto(true)}
              className="shrink-0 self-stretch w-10 rounded-lg border bg-card hover:bg-accent flex flex-col items-center justify-center gap-2 text-muted-foreground transition-colors"
              title="Abrir asistente"
              data-testid="boton-abrir-asistente"
            >
              <Sparkles className="w-4 h-4" />
              <span className="text-[10px] font-medium [writing-mode:vertical-rl]">Asistente</span>
            </button>
          )}
          {asistenteAbierto && (
          <div className="w-[320px] shrink-0 flex flex-col self-stretch overflow-hidden" data-testid="columna-asistente-recepcion">
            <AgentChat
              agenteForzado="recepcion"
              inline
              onCerrar={() => setAsistenteAbierto(false)}
              onElegirHueco={(h) => {
                // Igual que el click en un hueco libre de la tabla: la
                // preselección evita que el efecto de cambio de agenda/fecha
                // borre la hora elegida.
                setFecha(h.fecha);
                setMesVisible(fechaADate(h.fecha));
                setSedeId(h.sedeId != null ? String(h.sedeId) : "all");
                setEspecialidadId(h.especialidadId != null ? String(h.especialidadId) : "all");
                setPreseleccion({ turneraId: String(h.turneraId), hora: h.hora });
                setTurneraId(String(h.turneraId));
                setEstadoFiltro("todos");
                window.setTimeout(() => {
                  turneraDiaRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 150);
                toast({ title: "Turno preseleccionado", description: `${h.agenda} · ${h.fecha} ${h.hora} hs. La turnera de ese día quedó abierta abajo.` });
              }}
            />
          </div>
          )}

          {/* Panel de carga de turno a la derecha */}
          <div className="flex-1 min-w-[280px] max-w-md ml-auto rounded-lg border p-3 flex flex-col gap-2">
            {/* Buscador rápido con asistente: por práctica (ej. ecografía de
                abdomen) o especialidad, muestra las agendas que la realizan y
                al elegir una la selecciona directo. */}
            <div className="relative">
              <Stethoscope className="absolute left-2.5 top-[18px] -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="h-9 pl-8"
                placeholder="Buscador rápido: práctica o consulta (ej: ecografía de abdomen)"
                value={buscadorRapido}
                onChange={e => { setBuscadorRapido(e.target.value); setBuscadorAbierto(true); }}
                onFocus={() => setBuscadorAbierto(true)}
                onBlur={() => setTimeout(() => setBuscadorAbierto(false), 200)}
                onKeyDown={e => { if (e.key === "Escape") setBuscadorAbierto(false); }}
                data-testid="buscador-rapido-input"
              />
              {buscadorAbierto && buscadorRapidoDeb.trim().length >= 3 && buscadorRapido.trim().length >= 3 && (
                <div className="absolute z-30 top-10 left-0 right-0 max-h-72 overflow-y-auto rounded-md border bg-popover shadow-md text-sm">
                  {buscandoAgendas && <div className="px-3 py-2 text-muted-foreground">Buscando…</div>}
                  {!buscandoAgendas && (resultadoBuscador?.practicas?.length ?? 0) === 0 && (resultadoBuscador?.especialidades?.length ?? 0) === 0 && (
                    <div className="px-3 py-2 text-muted-foreground">Sin coincidencias. Si es una práctica, fijate que esté tildada en la agenda (Editar turnera → Prácticas).</div>
                  )}
                  {(resultadoBuscador?.practicas ?? []).map(p => (
                    <div key={`p-${p.codigo}`}>
                      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase text-muted-foreground">{p.descripcion} <span className="font-normal normal-case">({p.codigo})</span></div>
                      {p.agendas.map(a => (
                        <button key={`p-${p.codigo}-${a.turneraId}`} type="button"
                          className="w-full text-left px-3 py-1.5 hover:bg-accent flex flex-col"
                          onClick={() => elegirAgendaDesdeBuscador(a)}
                          data-testid={`buscador-rapido-agenda-${a.turneraId}`}>
                          <span className="font-medium">{a.profesionalNombre ?? a.turneraNombre}</span>
                          <span className="text-xs text-muted-foreground">{[a.especialidadNombre, a.sedeNombre].filter(Boolean).join(" · ")}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {(resultadoBuscador?.especialidades ?? []).map(e2 => (
                    <div key={`e-${e2.id}`}>
                      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase text-muted-foreground">Consulta · {e2.nombre}</div>
                      {e2.agendas.map(a => (
                        <button key={`e-${e2.id}-${a.turneraId}`} type="button"
                          className="w-full text-left px-3 py-1.5 hover:bg-accent flex flex-col"
                          onClick={() => elegirAgendaDesdeBuscador(a)}
                          data-testid={`buscador-rapido-agenda-${a.turneraId}`}>
                          <span className="font-medium">{a.profesionalNombre ?? a.turneraNombre}</span>
                          <span className="text-xs text-muted-foreground">{[a.esGuardia ? "Guardia" : null, a.sedeNombre].filter(Boolean).join(" · ")}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="h-9 pl-8"
                placeholder="Buscar por documento, nombre, apellido o celular"
                value={busqueda}
                onChange={e => { setBusqueda(e.target.value); setPacienteSel(null); }}
                data-testid="agenda-medico-busqueda"
              />
              {!esMedico && !pacienteSel && busquedaDebounced.length >= 2 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 rounded-md border bg-popover shadow-md max-h-56 overflow-y-auto">
                  {resultadosPacientes.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex justify-between gap-2"
                      onClick={() => {
                        setPacienteSel({ id: p.id, nombre: p.nombre, apellido: p.apellido, dni: p.dni ?? null, observaciones: p.observaciones ?? "" });
                        setObsPaciente(p.observaciones ?? "");
                      }}
                      data-testid={`resultado-paciente-${p.id}`}
                    >
                      <span className="font-medium truncate">{p.apellido}, {p.nombre}</span>
                      <span className="text-muted-foreground shrink-0">{p.dni ?? "sin DNI"}</span>
                    </button>
                  ))}
                  {!buscandoPacientes && resultadosPacientes.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground flex items-center justify-between gap-2">
                      <span>Sin resultados en el padrón</span>
                      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs shrink-0"
                        onClick={() => navigate("/pacientes?nuevo=1")} data-testid="cargar-paciente-desde-busqueda">
                        <UserPlus className="w-3.5 h-3.5" /> Cargar paciente
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {!esMedico && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground w-16 shrink-0">Paciente</span>
                  {pacienteSel ? (
                    <span className="flex-1 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-sm" data-testid="paciente-seleccionado">
                      <span className="truncate font-medium">{pacienteSel.apellido}, {pacienteSel.nombre}{pacienteSel.dni ? ` — DNI ${pacienteSel.dni}` : ""}</span>
                      <button type="button" onClick={() => { setPacienteSel(null); setBusqueda(""); setObsPaciente(""); }} className="text-muted-foreground hover:text-foreground" data-testid="quitar-paciente">
                        <X className="w-4 h-4" />
                      </button>
                    </span>
                  ) : (
                    <span className="flex-1 rounded-md border border-dashed px-2 py-1.5 text-sm text-muted-foreground">
                      Buscá y seleccioná un paciente
                    </span>
                  )}
                </div>

                {/* La agenda hace varios tipos de estudio: hay que decir cuál es
                    para que la prestación viaje con el código correcto. */}
                {debeElegirPractica && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase text-muted-foreground w-16 shrink-0">Estudio</span>
                    <div className="flex-1">
                      <MultiCombobox
                        options={practicasDeAgenda.map(p => ({
                          value: String(p.id),
                          label: `${p.nombre} (${(p.codigos ?? []).join(", ")})`,
                        }))}
                        values={practicasSel}
                        onChange={setPracticasSel}
                        placeholder="Tipo de estudio… (podés tildar varios)"
                        testId="agenda-medico-practica"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground w-16 shrink-0">Hora</span>
                  <div className="flex-1">
                    {esGuardiaSel ? (
                      <span className="flex items-center rounded-md border bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 text-sm text-amber-800 dark:text-amber-200" data-testid="hora-orden-llegada">
                        {guardiaMirandoAtras
                          ? "Estás viendo otro día: el ingreso por orden de llegada es solo para hoy (los Check in futuros los reserva el paciente desde la app)"
                          : "Por orden de llegada (no hace falta elegir hora)"}
                      </span>
                    ) : (
                      <Combobox
                        options={horasDisponibles.map(h => ({ value: h, label: `${h} hs` }))}
                        value={horaSel}
                        onChange={setHoraSel}
                        placeholder={turneraId === "all" ? "Elegí una agenda primero" : horasDisponibles.length === 0 ? "Sin horarios libres" : "Horario"}
                        testId="agenda-medico-hora"
                      />
                    )}
                  </div>
                </div>

                {/* Observaciones del paciente: quedan guardadas en la ficha
                    (Pacientes) al registrar el turno. */}
                {pacienteSel && (
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-semibold uppercase text-muted-foreground w-16 shrink-0 pt-1.5">Observ.</span>
                    <Textarea
                      className="flex-1 min-h-[56px] text-sm"
                      placeholder="Observaciones del paciente (quedan en su ficha)"
                      value={obsPaciente}
                      onChange={e => setObsPaciente(e.target.value)}
                      data-testid="agenda-medico-observaciones"
                    />
                  </div>
                )}

                {/* Aviso claro de POR QUÉ el botón está deshabilitado: sin esto
                    recepción cree que "no deja seleccionar el turno". */}
                {faltaPractica && pacienteSel && (esGuardiaSel || horaSel) && (
                  <div
                    className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                    data-testid="aviso-falta-estudio"
                  >
                    Falta elegir el <span className="font-semibold">tipo de estudio</span> (arriba) para poder registrar el turno.
                  </div>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={!pacienteSel || turneraId === "all" || (!esGuardiaSel && !horaSel) || faltaPractica || guardiaMirandoAtras || crearTurno.isPending}
                    onClick={registrarTurno}
                    data-testid="boton-registrar-turno"
                  >
                    {crearTurno.isPending ? "Registrando..." : "Registrar turno"}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5"
                    onClick={() => navigate("/pacientes?nuevo=1")} data-testid="boton-cargar-paciente">
                    <UserPlus className="w-4 h-4" /> Cargar paciente
                  </Button>
                </div>

                {/* Turno recién registrado: validar el token acá mismo, sin
                    buscar al paciente en el listado (pedido de guardia). */}
                {turnoRecienCreado && (
                  <div
                    className="flex items-center justify-between gap-2 rounded-md border border-green-300 bg-green-50 px-2 py-1.5 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
                    data-testid="panel-turno-recien-creado"
                  >
                    <span className="truncate">
                      <span className="font-medium">{turnoRecienCreado.paciente}</span> quedó registrado.
                    </span>
                    <Button
                      size="sm"
                      className="shrink-0 gap-1.5"
                      onClick={() => {
                        setTokenTurno({ id: turnoRecienCreado.id, paciente: turnoRecienCreado.paciente });
                        setTurnoRecienCreado(null);
                      }}
                      data-testid="boton-validar-token-recien-creado"
                    >
                      Validar token
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Día completo en la vista combinada: aviso con el próximo turno libre */}
        {sugerenciaHueco && (
          <div
            className="flex items-center gap-2 flex-wrap rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200"
            data-testid="banner-proximo-hueco"
          >
            <CalendarDays className="w-4 h-4 shrink-0" />
            <span>
              No quedan turnos libres este día.{" "}
              <span className="font-medium">
                Próximo turno libre: {fechaADate(sugerenciaHueco.fecha).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}
                {" a las "}{sugerenciaHueco.horaInicio} hs
                {sugerenciaHueco.profesionalNombre ? ` con ${sugerenciaHueco.profesionalNombre}` : ` (${sugerenciaHueco.turneraNombre})`}
              </span>
            </span>
            <Button
              size="sm"
              className="h-7 px-3 text-xs bg-green-600 hover:bg-green-700 text-white ml-auto"
              onClick={() => {
                setFecha(sugerenciaHueco.fecha);
                setMesVisible(fechaADate(sugerenciaHueco.fecha));
              }}
              data-testid="boton-ir-proximo-hueco"
            >
              Ir a esa fecha
            </Button>
          </div>
        )}

        {/* Filtro por color de estado: botones clickeables (reemplaza la leyenda).
            Pensado para no tener que bajar hasta el final del listado: p. ej.
            tocar "Esperando" y ver solo los amarillos. */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Mostrar:</span>
          {FILTROS_ESTADO
            // En guardia se atiende por orden de llegada: no hay horarios
            // libres, así que la pastilla "Libres" no aplica.
            .filter(fl => !(esGuardiaSel && fl.value === "libre"))
            .map(fl => {
            const activo = estadoFiltro === fl.value;
            const cantidad = conteosFiltro[fl.value] ?? 0;
            return (
              <button
                key={fl.value}
                type="button"
                onClick={() => setEstadoFiltro(activo && fl.value !== "todos" ? "todos" : fl.value)}
                title={activo && fl.value !== "todos" ? "Clic para volver a ver todos" : `Ver solo: ${fl.label}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-sm transition-colors cursor-pointer ${
                  activo
                    ? `${fl.activo} ring-2 border-transparent`
                    : "bg-background text-foreground border-input hover:bg-muted"
                }`}
                data-testid={`filtro-estado-${fl.value}`}
              >
                <span className={`w-2.5 h-2.5 rounded-full ${fl.punto}`} />
                {fl.label}
                {fl.value !== "todos" && (
                  <span className={`tabular-nums rounded-full px-1.5 ${activo ? "bg-white/60" : "bg-muted text-muted-foreground"}`}>
                    {cantidad}
                  </span>
                )}
              </button>
            );
          })}
          {/* Pastillas de médicos atendiendo y demora estimada (solo hoy) */}
          {esHoy && (
            <>
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-3 py-1 text-xs font-medium shadow-sm"
                title={medicosAtendiendoAgenda.join(", ") || "Ningún médico atendiendo ahora"}
                data-testid="pastilla-agenda-medicos-atendiendo"
              >
                <Stethoscope className="w-3.5 h-3.5" />
                {medicosAtendiendoAgenda.length}{" "}
                {medicosAtendiendoAgenda.length === 1 ? "médico atendiendo" : "médicos atendiendo"}
              </span>
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-3 py-1 text-xs font-medium shadow-sm"
                data-testid="pastilla-agenda-demora"
              >
                <Clock className="w-3.5 h-3.5" />
                {demoraEstimadaAgenda != null ? `~${demoraEstimadaAgenda}' de demora` : "sin demora estimada"}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Tabla de turnos */}
      <div ref={turneraDiaRef} className="flex-1 scroll-mt-20" data-testid="turnera-dia-seleccionada">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : filasTabla.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground text-sm">
            {estadoFiltro !== "todos" ? (
              <>
                <span>No hay turnos de ese color en esta fecha</span>
                <Button size="sm" variant="outline" className="h-7 px-3 text-xs"
                  onClick={() => setEstadoFiltro("todos")} data-testid="boton-quitar-filtro-estado">
                  Ver todos
                </Button>
              </>
            ) : (
              "No hay turnos para esta agenda en la fecha elegida"
            )}
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="tabla-agenda-medico">
            <thead className="sticky top-14 bg-muted/95 backdrop-blur z-10">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 w-20">Hora</th>
                <th className="px-3 py-2">Paciente</th>
                <th className="px-3 py-2 w-36">Doc. / H.C.</th>
                <th className="px-3 py-2 w-32">Tel.</th>
                <th className="px-3 py-2 w-44">Cobertura</th>
                <th className="px-3 py-2 w-56">Agenda</th>
                <th className="px-3 py-2 w-28">N° Bono</th>
                <th className="px-3 py-2 w-48">Observaciones</th>
                <th className="px-3 py-2 w-32">Estado</th>
                <th className={`px-3 py-2 ${esMedico ? "w-28" : "w-52"}`}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filasTabla.map((f, i) => {
                if (f.tipo === "libre") {
                  // En la vista combinada la fila indica de qué agenda es y el
                  // clic preselecciona agenda + hora en el panel de registro.
                  const deAgregada = f.turneraId != null;
                  const elegido = horaSel === f.hora
                    && (!deAgregada || turneraId === String(f.turneraId));
                  return (
                    <tr
                      key={`libre-${f.turneraId ?? "sel"}-${f.hora}-${i}`}
                      className={`border-b bg-green-100 dark:bg-green-950/40 ${!esMedico ? "cursor-pointer hover:bg-green-200 dark:hover:bg-green-900/60" : ""}`}
                      onClick={() => {
                        if (esMedico) return;
                        if (deAgregada) {
                          setPreseleccion({ turneraId: String(f.turneraId), hora: f.hora });
                          setTurneraId(String(f.turneraId));
                        } else {
                          setHoraSel(f.hora);
                        }
                      }}
                      data-testid={`fila-libre-${f.turneraId != null ? `${f.turneraId}-` : ""}${f.hora}`}
                    >
                      <td className="px-3 py-2.5 font-bold tabular-nums align-top text-green-900 dark:text-green-200">{f.hora}</td>
                      <td className="px-3 py-2.5 align-top text-green-900 dark:text-green-200 font-medium" colSpan={deAgregada ? 5 : 8}>
                        Libre{!esMedico ? " — clic para elegir este horario" : ""}
                      </td>
                      {deAgregada && (
                        <td className="px-3 py-2.5 align-top text-xs text-green-900 dark:text-green-200" colSpan={3}>
                          <span className="block font-medium">{f.turneraNombre}</span>
                          {f.profesionalNombre && <span className="block">{f.profesionalNombre}</span>}
                        </td>
                      )}
                      <td className="px-3 py-2.5 align-top">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-green-200 text-green-800 ${elegido ? "ring-2 ring-green-500" : ""}`}>
                          {elegido ? "Elegido" : "Libre"}
                        </span>
                      </td>
                    </tr>
                  );
                }
                const t = f.turno;
                const meta = FILA_ESTADO[t.estado] ?? { bg: "", label: t.estado, chip: "bg-slate-200 text-slate-700" };
                const marcaBg = marcaColorFondo(t.marcaColor);
                const marcaLabel = marcaColorLabel(t.marcaColor);
                // El estado siempre pinta la fila entera (reservado, esperando,
                // llamado, en atención, atendido...); la marca de color queda
                // solo como pastilla junto al paciente.
                void marcaBg;
                // Token validado con bono: la fila en espera pasa a verde
                // distintivo para que recepción vea de un vistazo quiénes ya
                // están habilitados con IOMA.
                const tokenValidado = t.tokenStatus === "ACCEPTED" && !!t.nroBono;
                // Verde más intenso + borde izquierdo para no confundirse con
                // el verde suave de los horarios libres.
                const filaBg = tokenValidado && ["arribo", "en_sala"].includes(t.estado)
                  ? "bg-emerald-300/80 dark:bg-emerald-800/70 border-l-4 border-l-emerald-600"
                  : meta.bg;
                return (
                  <tr
                    key={t.turnoId}
                    className={`border-b ${filaBg} ${!esMedico ? "cursor-pointer hover:bg-muted/40" : ""}`}
                    onClick={() => { if (!esMedico) setFichaTurnoId(t.turnoId); }}
                    title={!esMedico ? "Abrir ficha de recepción" : undefined}
                    data-testid={`fila-turno-${t.turnoId}`}
                  >
                    <td className="px-3 py-2.5 font-bold tabular-nums align-top">
                      {t.horaInicio}
                      {t.sobreturno && <span className="ml-1 text-[10px] text-amber-600 font-medium">ST</span>}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <button
                        type="button"
                        className="font-semibold text-left hover:underline hover:text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Médico: directo a la consulta (sin pasar por la HCE).
                          if (esMedico) navigate(`/pacientes/${t.pacienteId}/consulta?turno=${t.turnoId}`);
                          else navigate(`/pacientes/${t.pacienteId}/hce`);
                        }}
                        title={esMedico ? "Iniciar consulta" : "Ver historia clínica"}
                        data-testid={`link-hce-${t.turnoId}`}
                      >
                        {t.pacienteApellido}, {t.pacienteNombre}
                      </button>
                      {t.especialidad && (
                        <span className="block text-xs text-muted-foreground">{t.especialidad}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {t.pacienteDni && <span className="block">DNI {t.pacienteDni}</span>}
                      {t.numeroHc && <span className="block text-xs text-muted-foreground">H.C. {t.numeroHc}</span>}
                    </td>
                    <td className="px-3 py-2.5 align-top">{t.pacienteTelefono ?? "—"}</td>
                    <td className="px-3 py-2.5 align-top">{t.cobertura ?? "—"}</td>
                    <td className="px-3 py-2.5 align-top text-xs text-muted-foreground">
                      {t.turneraNombre}
                      {t.profesionalNombre && <span className="block">{t.profesionalNombre}</span>}
                    </td>
                    <td className="px-3 py-2.5 align-top tabular-nums" data-testid={`bono-turno-${t.turnoId}`}>
                      {t.nroBono ? (
                        <span className="font-semibold text-emerald-800 dark:text-emerald-300">{t.nroBono}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2.5 align-top text-xs"
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`obs-turno-${t.turnoId}`}
                    >
                      {obsEditando?.turnoId === t.turnoId ? (
                        <Input
                          autoFocus
                          value={obsEditando.texto}
                          onChange={(e) => setObsEditando({ turnoId: t.turnoId, texto: e.target.value })}
                          onKeyDown={(e) => {
                            // Único camino de guardado: el blur. Enter solo saca el foco
                            // (evita el doble PATCH Enter+blur); Escape descarta.
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") {
                              obsCancelarRef.current = true;
                              e.currentTarget.blur();
                            }
                          }}
                          onBlur={() => {
                            if (obsCancelarRef.current) {
                              obsCancelarRef.current = false;
                              setObsEditando(null);
                              return;
                            }
                            if (guardarObs.isPending) return;
                            if (obsEditando.texto.trim() === (t.observaciones ?? "").trim()) {
                              setObsEditando(null);
                              return;
                            }
                            guardarObs.mutate({ id: t.turnoId, data: { observaciones: obsEditando.texto.trim() } });
                          }}
                          disabled={guardarObs.isPending}
                          placeholder="Ej.: quiere ser atendido por…"
                          className="h-7 text-xs"
                          data-testid={`input-obs-${t.turnoId}`}
                        />
                      ) : esMedico ? (
                        <span className="text-muted-foreground whitespace-pre-wrap">{t.observaciones || "—"}</span>
                      ) : (
                        <button
                          type="button"
                          className={`text-left w-full rounded px-1 py-0.5 hover:bg-muted/60 transition-colors ${t.observaciones ? "" : "text-muted-foreground/60 italic"}`}
                          onClick={() => setObsEditando({ turnoId: t.turnoId, texto: t.observaciones ?? "" })}
                          title="Clic para editar la observación"
                          data-testid={`boton-obs-${t.turnoId}`}
                        >
                          {t.observaciones || "Agregar observación…"}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${meta.chip}`}>
                        {meta.label}
                      </span>
                      {marcaLabel && (
                        <span className={`mt-1 block w-fit px-2 py-0.5 rounded-full text-[10px] font-medium ${t.marcaColor === "naranja" ? "bg-orange-200 text-orange-900" : "bg-yellow-200 text-yellow-900"}`}>
                          {marcaLabel}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <div className="flex flex-col items-start gap-1">
                        {/* Botones tipo chip (mismo estilo que "Reservado"), apilados: Recepcionar arriba */}
                        {!esMedico && RECEPCIONABLES.includes(t.estado) && fecha === hoyArgentina() && (
                          <button
                            type="button"
                            className="inline-block w-24 px-2 py-0.5 rounded-full text-xs font-medium text-center bg-emerald-200 text-emerald-900 hover:bg-emerald-300 transition-colors disabled:opacity-50"
                            disabled={admitir.isPending}
                            onClick={(e) => { e.stopPropagation(); admitir.mutate({ id: t.turnoId }); }}
                            data-testid={`boton-recepcionar-${t.turnoId}`}
                          >
                            Recepcionar
                          </button>
                        )}
                        {/* Llamar: el paciente aparece en la pantalla de la sala de espera.
                            Solo los médicos llaman pacientes. Al llamar, el paciente queda
                            EN CONSULTA (bloqueado para otros médicos) hasta Finalizar Consulta;
                            solo el mismo médico puede volver a llamarlo. */}
                        {esMedico &&
                          fecha === hoyArgentina() &&
                          (["arribo", "en_sala"].includes(t.estado) ||
                            (t.estado === "llamado" &&
                              t.llamadoPorProfesionalId != null &&
                              String(t.llamadoPorProfesionalId) === String(user?.profesionalId ?? ""))) && (
                          <button
                            type="button"
                            className="inline-block w-24 px-2 py-0.5 rounded-full text-xs font-medium text-center bg-sky-200 text-sky-900 hover:bg-sky-300 transition-colors disabled:opacity-50"
                            disabled={llamar.isPending}
                            onClick={(e) => { e.stopPropagation(); llamar.mutate({ id: t.turnoId }); }}
                            data-testid={`boton-llamar-${t.turnoId}`}
                          >
                            {t.estado === "llamado" ? "Llamar de nuevo" : "Llamar"}
                          </button>
                        )}
                        {/* Destrabar: el paciente quedó EN CONSULTA (llamado por un
                            médico que no finalizó). Recepción/gerencia lo devuelve a
                            la sala de espera con un clic; queda auditado. */}
                        {!esMedico && t.estado === "llamado" && fecha === hoyArgentina() && (
                          <button
                            type="button"
                            className="inline-block w-24 px-2 py-0.5 rounded-full text-xs font-medium text-center bg-amber-200 text-amber-900 hover:bg-amber-300 transition-colors disabled:opacity-50"
                            disabled={devolverASala.isPending}
                            onClick={(e) => { e.stopPropagation(); devolverASala.mutate({ id: t.turnoId }); }}
                            title="Devolver a sala de espera: el paciente deja de estar en consulta y puede ser llamado de nuevo"
                            data-testid={`boton-devolver-sala-${t.turnoId}`}
                          >
                            Devolver a sala
                          </button>
                        )}
                        {/* Cancelar: turno reservado que se da de baja, o paciente
                            llamado que no vino. Recepción puede cancelar reservas
                            de cualquier fecha (hoy o futuras). */}
                        {((["arribo", "en_sala"].includes(t.estado) && fecha === hoyArgentina()) ||
                          (!esMedico && ["pendiente", "reservado", "confirmado", "publicado"].includes(t.estado))) && (
                          <button
                            type="button"
                            className="inline-block w-24 px-2 py-0.5 rounded-full text-xs font-medium text-center bg-red-200 text-red-900 hover:bg-red-300 transition-colors disabled:opacity-50"
                            disabled={cancelar.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`¿Cancelar la consulta de ${t.pacienteApellido ?? ""} ${t.pacienteNombre ?? ""}?`.trim())) {
                                cancelar.mutate({ id: t.turnoId });
                              }
                            }}
                            data-testid={`boton-cancelar-${t.turnoId}`}
                          >
                            Cancelar
                          </button>
                        )}
                        {/* Videollamada: el turno es una videoconsulta (ej. guardia
                            virtual). El médico entra directo; recepción también puede
                            abrir el enlace para pasárselo o verificarlo. */}
                        {t.modalidad === "videoconsulta" &&
                          ["arribo", "en_sala", "llamado", "en_atencion"].includes(t.estado) && (
                          <button
                            type="button"
                            className="inline-block w-24 px-2 py-0.5 rounded-full text-xs font-medium text-center bg-violet-200 text-violet-900 hover:bg-violet-300 transition-colors"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const { url } = await obtenerLinkVideollamadaTurno(t.turnoId);
                                window.open(url, "_blank", "noopener");
                              } catch {
                                toast({
                                  title: "No se pudo abrir la videollamada",
                                  description: "Reintentá en unos segundos.",
                                  variant: "destructive",
                                });
                              }
                            }}
                            title="Abrir el enlace de la videollamada de este turno"
                            data-testid={`boton-videollamada-${t.turnoId}`}
                          >
                            Videollamada
                          </button>
                        )}
                        {!esMedico && (
                          <button
                            type="button"
                            className={`inline-block w-24 px-2 py-0.5 rounded-full text-xs font-medium text-center transition-colors ${
                              tokenValidado
                                ? "bg-emerald-300 text-emerald-950 hover:bg-emerald-400"
                                : "bg-indigo-200 text-indigo-900 hover:bg-indigo-300"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setTokenTurno({
                                id: t.turnoId,
                                paciente: `${t.pacienteApellido ?? ""} ${t.pacienteNombre ?? ""}`.trim() || undefined,
                              });
                            }}
                            title={tokenValidado ? `Token validado · N° de Bono ${t.nroBono}` : undefined}
                            data-testid={`boton-validar-${t.turnoId}`}
                          >
                            {tokenValidado ? "Validado ✓" : "Validar"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Ficha de recepción: se abre al hacer clic en un turno (solo staff) */}
      {fichaTurnoId != null && (
        <FichaRecepcionDialog
          turnoId={fichaTurnoId}
          abierto={fichaTurnoId != null}
          onClose={() => setFichaTurnoId(null)}
          onCambio={() => {
            void queryClient.invalidateQueries({
              predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
            });
          }}
        />
      )}

      {/* Validar desde la tabla: carga y validación del token IOMA del turno */}
      <TokenTurnoDialog
        turnoId={tokenTurno?.id ?? null}
        paciente={tokenTurno?.paciente}
        abierto={tokenTurno != null}
        onClose={() => {
          setTokenTurno(null);
          void queryClient.invalidateQueries({
            predicate: qy => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
          });
        }}
      />
    </div>
  );
}
