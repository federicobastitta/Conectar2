import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecepcionTurnosDia,
  getGetRecepcionTurnosDiaQueryKey,
  useGetColaSalaEspera,
  useListEspecialidades,
  useListTurneras,
  useGetDemandaEspontanea,
  useCancelarTurno,
  useMarcarNoPresentado,
  useGetRobotKlinicosEstado,
  type RecepcionTurnoDia,
  type Turnera,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { getEstadoMacro, ESTADO_MACRO_META, esAtendido, ATENDIDO_META, CHECK_IN_META, FILA_ATENDIDO_BG } from "@/lib/episodio";
import { marcaColorFondo, marcaColorLabel } from "@/lib/marca-color";
import { PanelRecepcionActivo } from "@/components/recepcion/panel-recepcion-activo";
import { NuevoPacienteDialog } from "@/components/pacientes/nuevo-paciente-dialog";
import { EscanearQrDialog } from "@/components/recepcion/escanear-qr-dialog";
import { SalaEsperaBoton } from "@/components/recepcion/sala-espera-boton";
import { useLocation } from "wouter";
import {
  CheckCircle2, Clock, Users, AlertTriangle, Search, Plus, UserPlus, Stethoscope,
  ChevronRight, MoreHorizontal, X, XCircle, QrCode, ArrowLeft, ClipboardList, CalendarDays,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function hoyArgentina(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
}

function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const ESTADO_TOKEN_META: Record<string, { label: string; color: string }> = {
  ACCEPTED: { label: "Token OK", color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  DENIED: { label: "Rechazado", color: "bg-red-100 text-red-800 border-red-200" },
  TECHNICAL_ERROR: { label: "Error técnico", color: "bg-amber-100 text-amber-800 border-amber-200" },
  TIMEOUT: { label: "Timeout", color: "bg-amber-100 text-amber-800 border-amber-200" },
  MANUAL_REVIEW: { label: "Revisión", color: "bg-amber-100 text-amber-800 border-amber-200" },
};

function KpiCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 border-r last:border-0">
      <span className={`text-xl font-bold tabular-nums ${color ?? "text-foreground"}`}>{value}</span>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

// Pastilla "Indicaciones": visible para todo el staff cuando el médico emitió
// indicaciones (plan de atención) en la última consulta del paciente. Al
// clickearla se abre el detalle sin salir de la agenda.
function PastillaIndicaciones({ ind }: { ind: NonNullable<RecepcionTurnoDia["indicaciones"]> }) {
  const fecha = new Date(ind.createdAt).toLocaleDateString("es-AR");
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800 hover:bg-sky-200 dark:hover:bg-sky-900/70 whitespace-nowrap"
            data-testid={`pastilla-indicaciones-${ind.id}`}
          >
            <ClipboardList className="w-3 h-3" /> Indicaciones
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 text-sm space-y-2" onClick={(e) => e.stopPropagation()}>
          <div>
            <p className="font-semibold flex items-center gap-1.5">
              <ClipboardList className="w-4 h-4 text-primary" /> Indicaciones de la última consulta
            </p>
            <p className="text-xs text-muted-foreground">
              {fecha}{ind.profesionalNombre ? ` · ${ind.profesionalNombre}` : ""}
            </p>
          </div>
          {ind.estudios && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Estudios a realizar</p>
              <p className="text-xs whitespace-pre-wrap">{ind.estudios}</p>
            </div>
          )}
          {ind.medicamentos && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Medicamentos</p>
              <p className="text-xs whitespace-pre-wrap">{ind.medicamentos}</p>
            </div>
          )}
          {ind.otrasIndicaciones && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Otras indicaciones</p>
              <p className="text-xs whitespace-pre-wrap">{ind.otrasIndicaciones}</p>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}

function FilaAgenda({
  item,
  seleccionado,
  onClick,
  onCancelar,
  onAusente,
}: {
  item: RecepcionTurnoDia;
  seleccionado: boolean;
  onClick: () => void;
  onCancelar: () => void;
  onAusente: () => void;
}) {
  const macro = getEstadoMacro(item.estado);
  // Post-consulta la fila se muestra como "Atendido" (chip y fondo rosa),
  // aunque internamente el estado sea visto / pendiente_informe / etc.
  const atendido = esAtendido(item.estado);
  // Si el token ya fue validado y el turno sigue sin recepcionar, la pastilla
  // principal pasa de "Reservado" a "Token validado" (verde).
  // Regla única de verdad (2-ago-2026): "Token validado" (verde) exige el
  // estado ACCEPTED persistido Y el N° de bono; ACCEPTED sin bono no habilita.
  const tokenValidado = item.tokenStatus === "ACCEPTED" && Boolean(item.nroBono);
  const meta = atendido
    ? ATENDIDO_META
    : tokenValidado && macro === "agendado"
      ? {
          label: item.checkInPrevio ? "Check in validado" : "Token validado",
          bg: "bg-emerald-100 dark:bg-emerald-900/40",
          color: "text-emerald-800 dark:text-emerald-200",
          border: "border-emerald-200 dark:border-emerald-800",
          dot: "bg-emerald-500",
        }
      : item.checkInPrevio && macro === "agendado"
        ? CHECK_IN_META
        : ESTADO_MACRO_META[macro];
  // El chip chico de token se omite cuando la pastilla principal ya lo dice.
  const tokenMeta =
    item.tokenStatus && !(tokenValidado && macro === "agendado" && !atendido)
      ? ESTADO_TOKEN_META[item.tokenStatus]
      : null;

  const semBg =
    item.semaforo?.color === "verde"
      ? "bg-emerald-400"
      : item.semaforo?.color === "amarillo"
        ? "bg-amber-400"
        : item.semaforo?.color === "rojo"
          ? "bg-red-500"
          : "bg-muted";

  const cancelable = ["pendiente", "reservado", "confirmado", "publicado", "arribo", "en_sala"].includes(item.estado);
  const ausentable = ["pendiente", "reservado", "confirmado", "arribo", "en_sala", "llamado"].includes(item.estado);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left border-b last:border-0 transition-colors cursor-pointer
        ${marcaColorFondo(item.marcaColor) ?? (atendido ? FILA_ATENDIDO_BG : "")}
        ${seleccionado
          ? `${atendido && !item.marcaColor ? "" : "bg-primary/5"} border-l-2 border-l-primary`
          : `${item.marcaColor || atendido ? "" : "hover:bg-muted/50"} border-l-2 border-l-transparent`
        }`}
      title={marcaColorLabel(item.marcaColor) ?? undefined}
    >
      {/* Semáforo documental */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${semBg}`} title={item.semaforo?.faltantes?.join(", ") ?? ""} />

      {/* Hora */}
      <span className="text-sm font-bold tabular-nums w-12 shrink-0 text-muted-foreground">
        {item.horaInicio}
      </span>

      {/* Paciente */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-base font-semibold truncate">
            {item.pacienteApellido}, {item.pacienteNombre}
          </span>
          {item.sobreturno && (
            <span className="text-[10px] text-amber-600 font-medium">·ST</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {item.turneraNombre && (
            <span className="text-sm font-medium text-primary truncate max-w-[220px]">{item.turneraNombre}</span>
          )}
          {item.pacienteDni && (
            <span className="text-sm text-muted-foreground">{item.pacienteDni}</span>
          )}
          {item.cobertura && (
            <span className="text-sm text-muted-foreground truncate max-w-[110px]">{item.cobertura}</span>
          )}
          {item.indicaciones && <PastillaIndicaciones ind={item.indicaciones} />}
        </div>
      </div>

      {/* Botón principal: Recepcionar */}
      {["pendiente", "reservado", "confirmado", "publicado"].includes(item.estado) && (
        <span onClick={e => e.stopPropagation()}>
          <Button
            size="sm"
            className="h-7 text-xs gap-1 shrink-0"
            onClick={onClick}
            data-testid={`recepcionar-${item.turnoId}`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Recepcionar
          </Button>
        </span>
      )}

      {/* Estado + token */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={`inline-flex items-center gap-1 text-sm font-medium px-2.5 py-0.5 rounded-full border whitespace-nowrap ${meta.bg} ${meta.color} ${meta.border}`}>
          <span className={`w-1 h-1 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
        {tokenMeta && (
          <span className={`text-[10px] px-1.5 py-0 rounded-full border ${tokenMeta.color}`}>
            {tokenMeta.label}
          </span>
        )}
        {item.nroBono && (
          <span
            className="text-[10px] px-1.5 py-0 rounded-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 font-medium whitespace-nowrap"
            data-testid={`agenda-bono-${item.turnoId}`}
          >
            Bono {item.nroBono}
          </span>
        )}
      </div>

      {/* Acciones rápidas */}
      <div onClick={e => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" tabIndex={-1}>
              <MoreHorizontal className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-sm">
            {cancelable && (
              <DropdownMenuItem className="text-red-600" onClick={onCancelar}>
                <X className="w-3.5 h-3.5 mr-2" /> Cancelar turno
              </DropdownMenuItem>
            )}
            {ausentable && (
              <DropdownMenuItem onClick={onAusente}>
                <XCircle className="w-3.5 h-3.5 mr-2" /> Marcar ausente
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    </div>
  );
}

export default function RecepcionTablero() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const hoy = hoyArgentina();

  const [especialidadId, setEspecialidadId] = useState<string>("all");
  const [profesionalKey, setProfesionalKey] = useState<string>("all");
  const [busqueda, setBusqueda] = useState("");
  const [turnoSeleccionado, setTurnoSeleccionado] = useState<number | null>(null);
  // Sala elegida en el mosaico: filtra la agenda a los turnos de ese médico/turnera.
  const [salaSeleccionada, setSalaSeleccionada] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const [nuevoPacienteOpen, setNuevoPacienteOpen] = useState(false);
  const [escanearQrOpen, setEscanearQrOpen] = useState(false);

  const { data: especialidades } = useListEspecialidades();
  const { data: turneras } = useListTurneras({ activa: true });
  const { data: turnosDia, isLoading } = useGetRecepcionTurnosDia(
    { fecha: hoy },
    { query: { refetchInterval: 20_000 } },
  );
  const { data: cola } = useGetColaSalaEspera({}, { query: { refetchInterval: 20_000 } });
  const { data: robot } = useGetRobotKlinicosEstado(undefined, { query: { refetchInterval: 60_000 } });

  const invalidar = () => {
    void queryClient.invalidateQueries({ queryKey: getGetRecepcionTurnosDiaQueryKey({ fecha: hoy }) });
  };

  const cancelar = useCancelarTurno({
    mutation: {
      onSuccess: () => { toast({ title: "Turno cancelado" }); invalidar(); },
      onError: () => toast({ title: "No se pudo cancelar", variant: "destructive" }),
    },
  });
  const noAsistio = useMarcarNoPresentado({
    mutation: {
      onSuccess: () => { toast({ title: "Marcado como ausente" }); invalidar(); },
      onError: () => toast({ title: "No se pudo marcar ausente", variant: "destructive" }),
    },
  });

  // El listado de profesionales respeta la especialidad elegida: si se filtra
  // por Cardiología, solo se ofrecen los profesionales con agenda de esa
  // especialidad.
  const profesionales: { key: string; label: string }[] = useMemo(() => {
    const visto = new Set<string>();
    const lista: { key: string; label: string }[] = [];
    for (const t of (turneras ?? [])) {
      if (t.profesionalId == null) continue;
      if (especialidadId !== "all" && String(t.especialidadId ?? "") !== especialidadId) continue;
      const key = `p:${t.profesionalId}`;
      if (!visto.has(key)) {
        visto.add(key);
        const nombre = t.profesional
          ? `${t.profesional.apellido ?? ""}, ${t.profesional.nombre ?? ""}`.replace(/^, /, "")
          : t.nombre;
        lista.push({ key, label: nombre });
      }
    }
    return lista.sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [turneras, especialidadId]);

  // Si cambia la especialidad y el profesional elegido no atiende esa
  // especialidad, se vuelve a "Todos los profesionales".
  useEffect(() => {
    if (profesionalKey !== "all" && !profesionales.some(p => p.key === profesionalKey)) {
      setProfesionalKey("all");
    }
  }, [profesionales, profesionalKey]);

  const q = normalizar(busqueda.trim());
  const filas = useMemo(() => {
    let lista = (turnosDia ?? []).filter(t => t.estado !== "cancelado");
    if (especialidadId !== "all") {
      const esp = especialidades?.find(e => String(e.id) === especialidadId)?.nombre ?? "";
      lista = lista.filter(t => normalizar(t.especialidad ?? "").includes(normalizar(esp)));
    }
    if (profesionalKey !== "all") {
      const pid = profesionalKey.replace("p:", "");
      lista = lista.filter(t => {
        const prof = (turneras ?? []).find(tu => tu.profesionalId === Number(pid));
        return prof ? normalizar(t.turneraNombre).includes(normalizar(prof.nombre ?? "")) || normalizar(t.profesionalNombre ?? "").includes(normalizar((prof.profesional?.apellido ?? "") + " " + (prof.profesional?.nombre ?? ""))) : false;
      });
    }
    if (salaSeleccionada) {
      const clave = normalizar(salaSeleccionada);
      lista = lista.filter(t =>
        normalizar(t.profesionalNombre ?? "") === clave || normalizar(t.turneraNombre ?? "") === clave,
      );
    }
    if (q) {
      lista = lista.filter(t =>
        [t.pacienteNombre, t.pacienteApellido, t.pacienteDni, t.pacienteTelefono, t.numeroHc].some(
          c => c && normalizar(String(c)).includes(q),
        ),
      );
    }
    return lista.sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
  }, [turnosDia, especialidadId, profesionalKey, q, especialidades, turneras, salaSeleccionada]);

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const kpiEnSala = (cola ?? []).filter(c => ["arribo", "en_sala"].includes(c.estado)).length;
  const kpiEspera = (cola ?? []).filter(c => c.estado === "en_sala").length;
  // Médicos atendiendo AHORA: profesionales con un paciente llamado o en atención.
  const medicosAtendiendo = useMemo(() => {
    const nombres = new Set<string>();
    for (const t of turnosDia ?? []) {
      if (!["llamado", "en_atencion"].includes(t.estado)) continue;
      // En guardia el turno no tiene profesional asignado: cuenta el médico
      // que llamó al paciente (si no, caería al nombre de la agenda y varios
      // médicos de guardia se contarían como uno solo).
      nombres.add(t.llamadoPorNombre || t.profesionalNombre || t.turneraNombre || "Sin profesional");
    }
    return [...nombres].sort((a, b) => a.localeCompare(b, "es"));
  }, [turnosDia]);
  // Demora estimada promedio de los pacientes que están esperando en sala.
  const demoraEstimada = useMemo(() => {
    const valores = (cola ?? [])
      .filter(c => ["arribo", "en_sala"].includes(c.estado))
      .map(c => c.esperaEstimadaMinutos)
      .filter((v): v is number => typeof v === "number");
    if (valores.length === 0) return null;
    return Math.round(valores.reduce((a, b) => a + b, 0) / valores.length);
  }, [cola]);
  // Pacientes en espera por médico (cola en_sala agrupada por profesional)
  const esperaPorMedico = useMemo(() => {
    const grupos = new Map<string, number>();
    for (const c of cola ?? []) {
      // "arribo" = recién recepcionado, "en_sala" = esperando en sala: ambos cuentan.
      if (!["arribo", "en_sala"].includes(c.estado)) continue;
      const clave = c.profesionalNombre || c.turneraNombre || "Sin profesional";
      grupos.set(clave, (grupos.get(clave) ?? 0) + 1);
    }
    return [...grupos.entries()].sort((a, b) => b[1] - a[1]);
  }, [cola]);

  // Mosaico de salas de espera: una tarjeta por médico que atiende hoy, con
  // color del blanco al rojo según cuánta gente tiene esperando en sala.
  const mosaicoSalas = useMemo(() => {
    // Solo turneras activas: los turnos de agendas desactivadas no suman tarjeta.
    const nombresActivos = new Set<string>();
    for (const t of turneras ?? []) {
      nombresActivos.add(normalizar(t.nombre ?? ""));
      if (t.profesional) {
        nombresActivos.add(normalizar(`${t.profesional.apellido ?? ""}, ${t.profesional.nombre ?? ""}`.replace(/^, /, "")));
        nombresActivos.add(normalizar(`${t.profesional.nombre ?? ""} ${t.profesional.apellido ?? ""}`.trim()));
      }
    }
    const esActivo = (clave: string) => nombresActivos.has(normalizar(clave));

    const medicos = new Map<string, number>();
    // Los médicos de turneras activas con turnos hoy arrancan en 0 (blanco).
    for (const t of turnosDia ?? []) {
      if (t.estado === "cancelado") continue;
      const clave = t.profesionalNombre || t.turneraNombre || "Sin profesional";
      if (!esActivo(t.turneraNombre ?? "") && !esActivo(t.profesionalNombre ?? "")) continue;
      if (!medicos.has(clave)) medicos.set(clave, 0);
    }
    for (const [nombre, cant] of esperaPorMedico) {
      if (!medicos.has(nombre) && !esActivo(nombre)) continue;
      medicos.set(nombre, cant);
    }
    return [...medicos.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"),
    );
  }, [turnosDia, esperaPorMedico, turneras]);

  // Guardias activas de hoy con sus médicos atendiendo (demanda espontánea)
  const { data: demanda } = useGetDemandaEspontanea({ query: { refetchInterval: 60_000 } });
  const guardiasConEstado = useMemo(() => {
    const porTurnera = new Map((demanda ?? []).map(d => [d.turneraId, d.medicos]));
    return (turneras ?? [])
      .filter(t => t.esGuardia && t.activa)
      .map(t => {
        // Pastillas por guardia: cuánta gente espera y la demora estimada de ESA guardia.
        const enEspera = (cola ?? []).filter(
          c => c.turneraId === t.id && ["arribo", "en_sala"].includes(c.estado),
        );
        const estimadas = enEspera
          .map(c => c.esperaEstimadaMinutos)
          .filter((v): v is number => typeof v === "number");
        const demora = estimadas.length > 0
          ? Math.round(estimadas.reduce((a, b) => a + b, 0) / estimadas.length)
          : null;
        // Médicos de la guardia atendiendo AHORA (paciente llamado o en atención).
        const atendiendoAhora = new Set(
          (turnosDia ?? [])
            .filter(td => td.turneraNombre === t.nombre && ["llamado", "en_atencion"].includes(td.estado))
            .map(td => td.llamadoPorNombre || td.profesionalNombre || td.turneraNombre || "Sin profesional"),
        ).size;
        return {
          id: t.id,
          nombre: t.nombre ?? `Guardia ${t.id}`,
          medicos: porTurnera.get(t.id) ?? [],
          esperando: enEspera.length,
          demora,
          atendiendoAhora,
        };
      });
  }, [turneras, demanda, cola, turnosDia]);

  // Escala blanco → rojo (tope en 6+ personas esperando).
  const estiloSala = (cant: number) => {
    const nivel = Math.min(cant, 6) / 6;
    // De blanco (255,255,255) a rojo intenso (220,38,38).
    const r = Math.round(255 - (255 - 220) * nivel);
    const g = Math.round(255 - (255 - 38) * nivel);
    const b = Math.round(255 - (255 - 38) * nivel);
    return {
      backgroundColor: `rgb(${r}, ${g}, ${b})`,
      color: nivel > 0.45 ? "white" : "rgb(55, 65, 81)",
    };
  };

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] overflow-hidden">
      {/* ── Barra superior (se esconde cuando la ficha de recepción está en pantalla completa) ── */}
      <div className={`gap-2 px-4 py-2.5 border-b bg-background shrink-0 flex-col ${turnoSeleccionado ? "hidden" : "flex"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold text-foreground truncate">
              Recepción de Pacientes de Diagnosticar
            </h1>
            <p className="text-sm text-muted-foreground truncate">
              Los pacientes con turnos ya asignados aparecen en esta pantalla
            </p>
          </div>
          {/* Abre la pantalla de sala de espera (TV) de una sede en otra pestaña */}
          <SalaEsperaBoton />
        </div>

        {/* Filtros */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="w-64">
            <Combobox
              options={[
                { value: "all", label: "Todas las especialidades" },
                ...(especialidades ?? []).map(e => ({ value: String(e.id), label: e.nombre })),
              ]}
              value={especialidadId}
              onChange={setEspecialidadId}
              placeholder="Especialidad"
              testId="filtro-especialidad"
            />
          </div>
          <div className="w-72">
            <Combobox
              options={[
                { value: "all", label: "Todos los profesionales" },
                ...profesionales.map(p => ({ value: p.key, label: p.label })),
              ]}
              value={profesionalKey}
              onChange={setProfesionalKey}
              placeholder="Profesional"
              testId="filtro-profesional"
            />
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="h-8 pl-8 w-52 text-xs"
              placeholder="Buscar paciente…"
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
            />
            {busqueda && (
              <button type="button" onClick={() => setBusqueda("")}
                className="absolute right-2 top-2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-1.5">
          <Button size="sm" className="h-8 text-xs gap-1.5"
            onClick={() => setEscanearQrOpen(true)} data-testid="button-escanear-qr">
            <QrCode className="w-3.5 h-3.5" /> Escanear QR
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
            onClick={() => navigate("/recepcion/ordenes")} data-testid="button-ordenes-medicas">
            <ClipboardList className="w-3.5 h-3.5" /> Órdenes médicas
          </Button>
          <Button size="sm" className="h-8 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
            onClick={() => navigate("/recepcion/agenda-medico")} data-testid="button-agenda-por-medico">
            <CalendarDays className="w-3.5 h-3.5" /> Agenda por médico
          </Button>
        </div>
      </div>

      {/* ── Guardias: médicos atendiendo ahora (demanda espontánea prendida) ── */}
      {guardiasConEstado.length > 0 && (
        <div className={`border-b bg-amber-50 dark:bg-amber-950/30 px-4 py-2 space-y-1 shrink-0 ${turnoSeleccionado ? "hidden" : "block"}`} data-testid="panel-guardias-recepcion">
          {guardiasConEstado.map(g => (
            <div key={g.id} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-semibold text-amber-800 dark:text-amber-200">{g.nombre} · por orden de llegada:</span>
              {/* Pastillas de la guardia: médicos atendiendo ahora y demora estimada */}
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 font-medium"
                data-testid={`pastilla-guardia-atendiendo-${g.id}`}
              >
                <Stethoscope className="w-3 h-3" />
                {g.atendiendoAhora} {g.atendiendoAhora === 1 ? "médico atendiendo" : "médicos atendiendo"}
              </span>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-2 py-0.5 font-medium"
                data-testid={`pastilla-guardia-demora-${g.id}`}
              >
                <Clock className="w-3 h-3" />
                {g.demora != null
                  ? `~${g.demora}' de demora (${g.esperando} esperando)`
                  : g.esperando > 0
                    ? `${g.esperando} esperando`
                    : "sin espera"}
              </span>
              {g.medicos.length > 0 ? (
                g.medicos.map(m => (
                  <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-1.5 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {m.nombre}{m.hastaHora ? ` (hasta ${m.hastaHora.substring(0, 5)})` : ""}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">ahora no hay médicos atendiendo</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── KPIs (también se esconden en pantalla completa) ── */}
      <div className={`items-stretch border-b bg-muted/20 shrink-0 overflow-x-auto ${turnoSeleccionado ? "hidden" : "flex"}`}>
        {/* Médicos atendiendo ahora */}
        <div
          className="flex items-center gap-2 px-4 py-2 border-r whitespace-nowrap"
          data-testid="kpi-medicos-atendiendo"
          title={medicosAtendiendo.length > 0 ? `Atendiendo: ${medicosAtendiendo.join(" · ")}` : undefined}
        >
          <Stethoscope className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="text-lg font-bold leading-none text-emerald-700">{medicosAtendiendo.length}</span>
          <span className="text-xs text-muted-foreground leading-tight">
            {medicosAtendiendo.length === 1 ? "médico atendiendo" : "médicos atendiendo"}
          </span>
        </div>
        {/* Demora estimada promedio */}
        <div className="flex items-center gap-2 px-4 py-2 border-r whitespace-nowrap" data-testid="kpi-demora-estimada">
          <Clock className="w-4 h-4 text-amber-600 shrink-0" />
          {demoraEstimada != null ? (
            <>
              <span className="text-lg font-bold leading-none text-amber-700">~{demoraEstimada}&apos;</span>
              <span className="text-xs text-muted-foreground leading-tight">demora estimada</span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground leading-tight">sin espera en sala</span>
          )}
        </div>
        {/* Pacientes en espera por médico */}
        <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto" data-testid="espera-por-medico">
          {esperaPorMedico.map(([medico, cantidad]) => (
            <span key={medico}
              className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap px-2.5 py-1 rounded-full border bg-background">
              <span className="text-muted-foreground">{medico}</span>
              <span className="font-semibold text-violet-700">{cantidad}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ── Contenido principal: lista + panel ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Panel izquierdo: agenda (se oculta al recepcionar: la ficha pasa a pantalla completa) ── */}
        <div className={`flex-col border-r overflow-hidden transition-all ${turnoSeleccionado ? "hidden" : "flex flex-1"}`}>
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}
            </div>
          ) : filas.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-2 text-muted-foreground p-8">
              <Users className="w-8 h-8 opacity-40" />
              <p className="text-sm">
                {q ? "Sin pacientes que coincidan con la búsqueda" : "Sin turnos para hoy"}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto group">
              {filas.map(item => (
                <FilaAgenda
                  key={item.turnoId}
                  item={item}
                  seleccionado={turnoSeleccionado === item.turnoId}
                  onClick={() => setTurnoSeleccionado(item.turnoId)}
                  onCancelar={() => cancelar.mutate({ id: item.turnoId })}
                  onAusente={() => noAsistio.mutate({ id: item.turnoId })}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Panel derecho: recepción activa ── */}
        {turnoSeleccionado ? (
          <div className="flex-1 flex flex-col overflow-hidden bg-background">
            {/* Header del panel derecho */}
            <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 -ml-2"
                onClick={() => setTurnoSeleccionado(null)}
                data-testid="volver-agenda-recepcion">
                <ArrowLeft className="w-4 h-4" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Volver a la agenda
                </span>
              </Button>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Recepción
              </span>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                onClick={() => setTurnoSeleccionado(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden">
              <PanelRecepcionActivo
                turnoId={turnoSeleccionado}
                onCambio={invalidar}
                onCheckIn={() => {
                  invalidar();
                  // Tras recepcionar, volvemos a la agenda de recepción
                  setTurnoSeleccionado(null);
                }}
                onTokenValidado={() => {
                  invalidar();
                  // Token aceptado: volvemos a la pantalla anterior
                  setTurnoSeleccionado(null);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="hidden md:flex flex-1 flex-col overflow-y-auto p-4 gap-3">
            {mosaicoSalas.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center space-y-2">
                  <Users className="w-10 h-10 mx-auto opacity-20" />
                  <p className="text-sm">Seleccioná un paciente para recepcionar</p>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-sm font-semibold text-foreground">Salas de espera por médico</p>
                  <p className="text-xs text-muted-foreground">
                    Del blanco al rojo según cuánta gente está esperando en sala
                  </p>
                </div>
                {salaSeleccionada && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit h-7 gap-1.5"
                    onClick={() => setSalaSeleccionada(null)}
                    data-testid="quitar-filtro-sala"
                  >
                    <X className="w-3.5 h-3.5" />
                    Ver todos los turnos (filtrando: {salaSeleccionada})
                  </Button>
                )}
                <div className="grid grid-cols-2 xl:grid-cols-3 gap-2" data-testid="mosaico-salas-espera">
                  {mosaicoSalas.map(([nombre, cant]) => (
                    <button
                      key={nombre}
                      type="button"
                      className={`rounded-lg border p-2.5 flex flex-col justify-between min-h-[72px] shadow-sm text-left cursor-pointer transition-all hover:shadow-md ${
                        salaSeleccionada === nombre ? "ring-2 ring-primary ring-offset-1" : ""
                      }`}
                      style={estiloSala(cant)}
                      onClick={() => setSalaSeleccionada(prev => (prev === nombre ? null : nombre))}
                      data-testid={`sala-medico-${nombre}`}
                    >
                      <p className="text-xs font-semibold leading-tight line-clamp-2">{nombre}</p>
                      <p className="text-[11px] mt-1 opacity-90">
                        <span className="text-lg font-bold leading-none mr-1">{cant}</span>
                        en espera
                      </p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground text-center mt-auto pt-2">
                  Seleccioná un paciente de la lista para recepcionar
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      <NuevoPacienteDialog
        open={nuevoPacienteOpen}
        onOpenChange={setNuevoPacienteOpen}
        onCreated={invalidar}
      />
      <EscanearQrDialog
        open={escanearQrOpen}
        onOpenChange={setEscanearQrOpen}
        onTurnoEncontrado={(t) => {
          setTurnoSeleccionado(t.turnoId);
          if (!t.esHoy) {
            toast({
              title: "Ojo: el turno no es de hoy",
              description: `${t.pacienteApellido}, ${t.pacienteNombre} — turno del ${t.fecha} a las ${t.horaInicio.substring(0, 5)} hs.`,
            });
          } else {
            toast({ title: `${t.pacienteApellido}, ${t.pacienteNombre}`, description: "Turno encontrado, se abrió la ficha." });
          }
        }}
      />
    </div>
  );
}
