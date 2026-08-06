import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  useListTurneras,
  listTurnos,
  getListTurnosQueryKey,
  useCancelarTurneraMasivo,
  useUpdatePaciente,
  useGetDemandaEspontanea,
  type Turnera,
  type Turno,
} from "@workspace/api-client-react";
import { useQueryClient, useQueries } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { BuscadorRapidoIA } from "@/components/agentes/BuscadorRapidoIA";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/hooks/use-toast";
import { CargarTurnoInline } from "@/components/turnos/cargar-turno-inline";
import { FichaRecepcionDialog } from "@/components/recepcion/ficha-recepcion-dialog";
import { getEstadoMacro, ESTADO_MACRO_META, type EstadoMacro } from "@/lib/episodio";
import {
  ahoraArgentina, nombreProfesional, diasLegibles, DIAS_CORTOS,
} from "@/lib/agenda";
import {
  ChevronRight, ChevronLeft, Clock, CalendarDays, Users,
  CalendarX2, Loader2, PhoneOff, Search, X,
} from "lucide-react";

// Búsqueda insensible a acentos y mayúsculas
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Mini calendario ────────────────────────────────────────────────────────
function MiniCalendario({
  diasAtencion, hoy, seleccionada, onSelectDia,
}: {
  diasAtencion: number[];
  hoy: string;
  seleccionada: string;
  onSelectDia: (fecha: string) => void;
}) {
  const [offsetMes, setOffsetMes] = useState(0);
  const base = new Date(`${hoy}T00:00:00`);
  const mes = new Date(base.getFullYear(), base.getMonth() + offsetMes, 1);
  const nombreMes = format(mes, "MMMM yyyy", { locale: es });
  const primerDiaSemana = mes.getDay();
  const diasEnMes = new Date(mes.getFullYear(), mes.getMonth() + 1, 0).getDate();

  const celdas: (number | null)[] = [
    ...Array<null>(primerDiaSemana).fill(null),
    ...Array.from({ length: diasEnMes }, (_, i) => i + 1),
  ];

  return (
    <div className="w-full max-w-[300px]">
      <div className="flex items-center justify-between mb-2">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOffsetMes(offsetMes - 1)} data-testid="cal-mes-anterior">
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>
        <span className="text-sm font-medium capitalize">{nombreMes}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOffsetMes(offsetMes + 1)} data-testid="cal-mes-siguiente">
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="secondary" size="sm" className="h-6 px-2 text-xs"
            onClick={() => { setOffsetMes(0); onSelectDia(hoy); }}
            data-testid="cal-hoy"
          >
            Hoy
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DIAS_CORTOS.map((d, i) => (
          <div key={i} className="text-[10px] font-medium text-muted-foreground py-0.5">{d}</div>
        ))}
        {celdas.map((dia, i) => {
          if (dia === null) return <div key={`v${i}`} />;
          const fecha = new Date(mes.getFullYear(), mes.getMonth(), dia);
          const fechaStr = format(fecha, "yyyy-MM-dd");
          const atiende = diasAtencion.includes(fecha.getDay());
          const esHoy = fechaStr === hoy;
          const esSel = fechaStr === seleccionada;
          return (
            <button
              key={dia}
              onClick={() => onSelectDia(fechaStr)}
              className={`text-xs rounded-md py-1 transition-colors cursor-pointer ${
                esSel
                  ? "bg-primary text-primary-foreground font-semibold"
                  : atiende
                    ? "bg-primary/15 text-primary font-semibold hover:bg-primary/30"
                    : "text-muted-foreground/60 hover:bg-muted"
              } ${esHoy && !esSel ? "ring-2 ring-primary" : ""}`}
              data-testid={`cal-dia-${fechaStr}`}
            >
              {dia}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2 text-[11px] text-muted-foreground">
        <span className="inline-block w-3 h-3 rounded bg-primary/15" /> Días de atención
      </div>
    </div>
  );
}

// Una "agenda" agrupa todas las turneras de un mismo profesional+especialidad
type GrupoAgenda = {
  key: string;
  label: string;
  turneras: Turnera[];
  dias: number[];
  esGuardia: boolean;
};

// Las guardias sin especialidad asignada se listan con su propio nombre
// (ej. "Guardia Clinica") para que no queden escondidas en "Sin especialidad".
function especialidadDe(t: Turnera): string {
  return t.especialidad?.nombre ?? (t.esGuardia && t.nombre.trim() ? t.nombre.trim() : "Sin especialidad");
}

function agruparAgendas(lista: Turnera[]): GrupoAgenda[] {
  const grupos = new Map<string, GrupoAgenda>();
  for (const t of lista) {
    const esp = especialidadDe(t);
    const key = t.profesionalId
      ? `p${t.profesionalId}-${esp}`
      : `t${t.id}`;
    const g = grupos.get(key);
    if (g) {
      g.turneras.push(t);
      for (const d of t.diasAtencion ?? []) if (!g.dias.includes(d)) g.dias.push(d);
    } else {
      grupos.set(key, {
        key,
        label: t.esGuardia
          ? `AGENDA GRUPAL — ${t.nombre.toUpperCase()}`
          : `${nombreProfesional(t).toUpperCase()} [${esp.toUpperCase()}]`,
        turneras: [t],
        dias: [...(t.diasAtencion ?? [])],
        esGuardia: !!t.esGuardia,
      });
    }
  }
  // Las guardias siempre van primero en la lista de agendas
  return [...grupos.values()].sort(
    (a, b) => Number(b.esGuardia) - Number(a.esGuardia) || a.label.localeCompare(b.label, "es"),
  );
}

// ── Médicos atendiendo ahora en la agenda grupal (solo lectura) ─────────────
// La participación ya no la maneja recepción: cada médico prende "acepto
// demanda espontánea" desde su consultorio, y acá recepción ve quiénes están
// atendiendo y hasta qué hora (fin de su agenda de hoy).
function AtendiendoAhoraGrupal({ turneras }: { turneras: Turnera[] }) {
  const { data: demanda } = useGetDemandaEspontanea({});
  const ids = new Set(turneras.map((t) => t.id));
  const medicos = (demanda ?? [])
    .filter((d) => ids.has(d.turneraId))
    .flatMap((d) => d.medicos);

  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid="panel-atendiendo-ahora">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Atendiendo ahora</span>
        {medicos.length > 0 && (
          <Badge variant="secondary" className="text-xs">{medicos.length}</Badge>
        )}
      </div>
      {medicos.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Ahora mismo ningún médico tiene prendida la demanda espontánea para esta agenda.
          Cada profesional la activa desde su consultorio.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {medicos.map((m) => (
            <Badge key={m.id} variant="secondary" className="font-normal gap-1" data-testid={`atendiendo-${m.id}`}>
              {m.nombre}
              {m.hastaHora && (
                <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                  <Clock className="w-3 h-3" /> hasta {m.hastaHora}
                </span>
              )}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Página ─────────────────────────────────────────────────────────────────
export default function TodasLasAgendas() {
  const queryClient = useQueryClient();
  const ahora = ahoraArgentina();
  const { data: turneras, isLoading } = useListTurneras({});
  const [busqueda, setBusqueda] = useState<string>(() => {
    // Permite llegar con la búsqueda precargada, ej. /agendas/todas?buscar=Pérez
    const params = new URLSearchParams(window.location.search);
    return params.get("buscar") ?? "";
  });
  const [sedeSel, setSedeSel] = useState<string>("todas");
  const [especialidadSel, setEspecialidadSel] = useState<string>("todas");
  const [turneraSel, setTurneraSel] = useState<string>("");
  const [fecha, setFecha] = useState<string>(ahora.fecha);
  const [turnoSeleccionado, setTurnoSeleccionado] = useState<number | null>(null);
  const { toast } = useToast();

  // ── Selección múltiple + acciones masivas ────────────────────────────────
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [notificar, setNotificar] = useState(true);
  const [motivo, setMotivo] = useState("");
  const [colaSinTelefono, setColaSinTelefono] = useState<Turno[]>([]);
  const [telefonoNuevo, setTelefonoNuevo] = useState("");

  const cancelarMutation = useCancelarTurneraMasivo();
  const updatePaciente = useUpdatePaciente();

  const lista = turneras ?? [];

  const sedes = useMemo(() => {
    const set = new Map<string, string>();
    for (const t of lista) {
      const nombre = t.sede?.nombre ?? "Sin sede";
      set.set(nombre, nombre);
    }
    return [...set.keys()].sort((a, b) => a.localeCompare(b, "es"));
  }, [lista]);

  const listaPorSede = useMemo(
    () => (sedeSel === "todas" ? lista : lista.filter((t) => (t.sede?.nombre ?? "Sin sede") === sedeSel)),
    [lista, sedeSel],
  );

  // Frecuencia de uso de cada especialidad (guardada en el navegador):
  // las más elegidas por recepción aparecen primero en el desplegable.
  const [frecuenciaEsp, setFrecuenciaEsp] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("frecuencia_especialidades") ?? "{}");
    } catch {
      return {};
    }
  });

  const registrarUsoEspecialidad = (nombre: string) => {
    setFrecuenciaEsp((prev) => {
      const next = { ...prev, [nombre]: (prev[nombre] ?? 0) + 1 };
      try {
        localStorage.setItem("frecuencia_especialidades", JSON.stringify(next));
      } catch {
        // sin espacio en localStorage: se sigue igual, solo pierde persistencia
      }
      return next;
    });
  };

  const especialidades = useMemo(() => {
    const set = new Map<string, string>();
    for (const t of listaPorSede) {
      const nombre = especialidadDe(t);
      set.set(nombre, nombre);
    }
    // Orden por frecuencia de selección (más usadas primero); a igual
    // frecuencia, orden alfabético como desempate estable.
    return [...set.keys()].sort(
      (a, b) =>
        (frecuenciaEsp[b] ?? 0) - (frecuenciaEsp[a] ?? 0) || a.localeCompare(b, "es"),
    );
  }, [listaPorSede, frecuenciaEsp]);

  const agendasFiltradas = useMemo(() => {
    let filtradas = especialidadSel === "todas"
      ? listaPorSede
      : listaPorSede.filter((t) => especialidadDe(t) === especialidadSel);
    const q = normalizar(busqueda.trim());
    if (q) {
      filtradas = filtradas.filter((t) => {
        const texto = normalizar(
          `${t.nombre} ${nombreProfesional(t)} ${t.especialidad?.nombre ?? ""} ${t.sede?.nombre ?? ""}`,
        );
        return q.split(/\s+/).every((palabra) => texto.includes(palabra));
      });
    }
    return agruparAgendas(filtradas);
  }, [listaPorSede, especialidadSel, busqueda]);

  // Si la búsqueda deja una sola agenda, se selecciona sola
  useEffect(() => {
    if (!busqueda.trim()) return;
    if (agendasFiltradas.length === 1 && turneraSel !== agendasFiltradas[0].key) {
      setTurneraSel(agendasFiltradas[0].key);
    }
  }, [agendasFiltradas, busqueda, turneraSel]);

  const grupo = useMemo(
    () => agendasFiltradas.find((g) => g.key === turneraSel) ?? null,
    [agendasFiltradas, turneraSel],
  );

  // Guardias grupales: al elegir una especialidad de guardia no hace falta
  // elegir profesional — se selecciona sola la agenda de guardia.
  useEffect(() => {
    if (turneraSel || especialidadSel === "todas") return;
    const guardia = agendasFiltradas.find((g) => g.esGuardia);
    if (guardia) setTurneraSel(guardia.key);
  }, [agendasFiltradas, especialidadSel, turneraSel]);

  // Guardia: siempre se trabaja sobre el día de hoy (sin calendario).
  useEffect(() => {
    if (grupo?.esGuardia && fecha !== ahora.fecha) setFecha(ahora.fecha);
  }, [grupo, fecha, ahora.fecha]);

  const consultas = useQueries({
    queries: (grupo?.turneras ?? []).map((t) => ({
      queryKey: getListTurnosQueryKey({ fecha, turneraId: t.id, limit: 200 }),
      queryFn: () => listTurnos({ fecha, turneraId: t.id, limit: 200 }),
      refetchInterval: 30000,
    })),
  });
  const cargandoTurnos = consultas.some((c) => c.isLoading);
  const turnosData = useMemo(
    () => consultas.flatMap((c) => c.data?.data ?? []),
    [consultas.map((c) => c.dataUpdatedAt).join(","), grupo?.key],
  );

  const turnos = useMemo(() => {
    const sinCancelados = turnosData.filter((t: Turno) => t.estado !== "cancelado");
    return [...sinCancelados].sort((a, b) => (a.horaInicio ?? "").localeCompare(b.horaInicio ?? ""));
  }, [turnosData]);

  const recepcionados = turnos.filter((t) => {
    const macro = getEstadoMacro(t.estado);
    return macro === "recepcionado" || macro === "pendiente_informe" || macro === "informado" || macro === "entregado";
  }).length;

  const turnosSel = useMemo(() => turnos.filter((t) => sel.has(t.id)), [turnos, sel]);
  const selSinTelefono = turnosSel.filter((t) => !t.paciente?.telefono);

  const toggleTodos = () => {
    setSel((s) => (s.size === turnos.length ? new Set() : new Set(turnos.map((t) => t.id))));
  };
  const toggleUno = (id: number) => {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const nombrePaciente = (t: Turno) =>
    t.paciente ? `${t.paciente.apellido ?? ""}, ${t.paciente.nombre ?? ""}` : `Turno #${t.id}`;

  function iniciarCancelacion() {
    if (turnosSel.length === 0) return;
    setMotivo("");
    setNotificar(true);
    if (selSinTelefono.length > 0) {
      setColaSinTelefono(selSinTelefono);
      setTelefonoNuevo("");
    } else {
      setConfirmCancelOpen(true);
    }
  }

  function avanzarCola() {
    setTelefonoNuevo("");
    setColaSinTelefono((cola) => {
      const resto = cola.slice(1);
      if (resto.length === 0) setConfirmCancelOpen(true);
      return resto;
    });
  }

  function guardarTelefonoActual() {
    const actual = colaSinTelefono[0];
    if (!actual?.paciente || !telefonoNuevo.trim()) return;
    updatePaciente.mutate(
      { id: actual.pacienteId, data: { telefono: telefonoNuevo.trim() } },
      {
        onSuccess: () => {
          toast({ title: `Teléfono guardado para ${nombrePaciente(actual)}` });
          avanzarCola();
          invalidarTurnosGrupo();
        },
        onError: () => toast({ title: "No se pudo guardar el teléfono", variant: "destructive" }),
      },
    );
  }

  async function confirmarCancelacion() {
    if (turnosSel.length === 0) return;
    if (!passwordConfirm.trim()) {
      toast({ title: "Ingresá tu contraseña para confirmar", variant: "destructive" });
      return;
    }
    // Los turnos del día pueden pertenecer a más de una turnera del mismo profesional
    const porTurnera = new Map<number, number[]>();
    for (const t of turnosSel) {
      const ids = porTurnera.get(t.turneraId) ?? [];
      ids.push(t.id);
      porTurnera.set(t.turneraId, ids);
    }
    try {
      for (const [tid, turnoIds] of porTurnera) {
        await cancelarMutation.mutateAsync({
          id: tid,
          data: {
            password: passwordConfirm,
            fechaDesde: fecha,
            fechaHasta: fecha,
            turnoIds,
            notificar,
            motivo: motivo.trim() || undefined,
          },
        });
      }
      toast({
        title: `${turnosSel.length === 1 ? "Turno cancelado" : `${turnosSel.length} turnos cancelados`}`,
        description: notificar ? "Los avisos por WhatsApp fueron procesados." : "No se enviaron avisos.",
      });
      setSel(new Set());
      setConfirmCancelOpen(false);
      setPasswordConfirm("");
      invalidarTurnosGrupo();
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        toast({ title: "Contraseña incorrecta", description: "Verificá tu contraseña e intentá de nuevo.", variant: "destructive" });
        return;
      }
      setConfirmCancelOpen(false);
      toast({ title: "Error al cancelar los turnos", variant: "destructive" });
    }
  }

  const pacienteActualCola = colaSinTelefono[0] ?? null;

  const invalidarTurnosGrupo = () => {
    for (const t of grupo?.turneras ?? []) {
      void queryClient.invalidateQueries({
        queryKey: getListTurnosQueryKey({ fecha, turneraId: t.id, limit: 200 }),
      });
    }
  };

  // Al elegir un turno desde el buscador rápido: selecciona esa agenda y fecha.
  const seleccionarSlotBuscador = (slot: { turneraId: number; fecha: string }) => {
    const t = lista.find((x) => x.id === slot.turneraId);
    if (!t) return;
    const esp = especialidadDe(t);
    const key = t.profesionalId ? `p${t.profesionalId}-${esp}` : `t${t.id}`;
    setSedeSel("todas");
    setEspecialidadSel("todas");
    setBusqueda("");
    setTurneraSel(key);
    setFecha(slot.fecha);
  };

  const seleccionarSede = (v: string) => {
    setSedeSel(v);
    setEspecialidadSel("todas");
    setTurneraSel("");
  };

  const seleccionarEspecialidad = (v: string) => {
    setEspecialidadSel(v);
    setTurneraSel("");
    if (v !== "todas") registrarUsoEspecialidad(v);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const fechaLegible = format(new Date(`${fecha}T00:00:00`), "EEEE d 'de' MMMM yyyy", { locale: es });

  return (
    <div className="space-y-4 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Agendas</h1>
        <p className="text-muted-foreground">
          Elegí especialidad y profesional para ver la planilla del día
        </p>
      </div>

      {/* Panel superior: selección + calendario */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">SEDE</label>
              <Select value={sedeSel} onValueChange={seleccionarSede}>
                <SelectTrigger data-testid="select-sede">
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas">TODAS</SelectItem>
                  {sedes.map((s) => (
                    <SelectItem key={s} value={s}>{s.toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">ESPECIALIDAD</label>
              <Combobox
                testId="select-especialidad"
                value={especialidadSel}
                onChange={seleccionarEspecialidad}
                placeholder="Todas"
                options={[
                  { value: "todas", label: "TODAS" },
                  ...especialidades.map((e) => ({ value: e, label: e.toUpperCase() })),
                ]}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">PROFESIONAL</label>
              <Combobox
                testId="select-agenda"
                value={turneraSel}
                onChange={setTurneraSel}
                placeholder="Elegir profesional…"
                options={agendasFiltradas.map((g) => ({ value: g.key, label: g.label }))}
              />
            </div>
            {grupo && (
              <div className="text-base font-medium space-y-1.5 pt-1">
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-primary" /> {diasLegibles(grupo.dias)}
                </div>
                {grupo.esGuardia ? (
                  <>
                    <p className="text-sm text-muted-foreground" data-testid="texto-guardia-grupal">
                      Agenda grupal: atención por orden de llegada, sin horarios fijos.
                    </p>
                    <AtendiendoAhoraGrupal turneras={grupo.turneras} />
                  </>
                ) : (
                  grupo.turneras.map((t) => (
                    <div key={t.id} className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-primary" />
                      {diasLegibles(t.diasAtencion ?? [])}: {t.horaInicio}–{t.horaFin} hs · {t.duracionMinutos} min
                    </div>
                  ))
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 flex flex-col items-center gap-3">
            {grupo && !grupo.esGuardia && (
              <MiniCalendario
                diasAtencion={grupo.dias}
                hoy={ahora.fecha}
                seleccionada={fecha}
                onSelectDia={setFecha}
              />
            )}
            {grupo?.esGuardia && (
              <div className="w-full rounded-md border border-primary/30 bg-primary/5 p-4 text-sm text-center" data-testid="aviso-guardia-hoy">
                <span className="capitalize font-medium">{fechaLegible}</span>
                <p className="text-muted-foreground mt-1">La guardia se atiende solo el día de hoy, por orden de llegada.</p>
              </div>
            )}
            {/* El buscador queda siempre: si el usuario se equivocó de turno
                puede buscar y asignar otro sin perder los resultados. */}
            <div className="w-full self-stretch overflow-hidden">
              <BuscadorRapidoIA
                mensaje="Elegí una agenda para ver el calendario"
                onSelectSlot={seleccionarSlotBuscador}
                mostrarMunieco={!grupo}
              />
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Cargar turno: asistente completo integrado en esta pantalla */}
      <Card className="border-primary/40">
        <CardContent className="pt-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              Cargar turno
            </h2>
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <CalendarDays className="w-3.5 h-3.5" />
              <span className="capitalize">{fechaLegible}</span>
            </span>
          </div>
          <CargarTurnoInline turneras={grupo?.turneras ?? []} fecha={fecha} onCreado={invalidarTurnosGrupo} />
        </CardContent>
      </Card>

      {/* Planilla del día */}
      <Card>
        <CardContent className="pt-4">
          {!grupo ? (
            <div className="text-sm text-muted-foreground py-10 text-center space-y-2">
              <Users className="w-8 h-8 mx-auto opacity-40" />
              <p>Elegí una especialidad y una agenda para ver los turnos del día.</p>
            </div>
          ) : cargandoTurnos ? (
            <div className="space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[32px_64px_1fr_110px_120px_140px_90px] gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground border-b items-center">
                <Checkbox
                  checked={turnos.length > 0 && sel.size === turnos.length}
                  onCheckedChange={toggleTodos}
                  aria-label="Seleccionar todos"
                  data-testid="planilla-sel-todos"
                />
                {turnosSel.length > 0 ? (
                  <div className="col-span-6 flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium">{turnosSel.length} seleccionado{turnosSel.length > 1 ? "s" : ""}</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7"
                      disabled={cancelarMutation.isPending}
                      onClick={iniciarCancelacion}
                      data-testid="planilla-btn-cancelar"
                    >
                      <CalendarX2 className="w-3.5 h-3.5 mr-1.5" /> Cancelar ({turnosSel.length})
                    </Button>
                  </div>
                ) : (
                  <>
                    <span>Hora</span><span>Paciente</span><span>Doc.</span><span>Tel.</span><span>O.S.</span><span>Estado</span>
                  </>
                )}
              </div>
              {turnos.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No hay turnos para este día.
                </p>
              ) : (
                turnos.map((t) => {
                  const macro = ESTADO_MACRO_META[getEstadoMacro(t.estado)];
                  return (
                    <div
                      key={t.id}
                      className={`grid grid-cols-[32px_64px_1fr_110px_120px_140px_90px] gap-2 px-3 border-b last:border-0 transition-colors items-center ${sel.has(t.id) ? "bg-muted/40" : "hover:bg-muted/50"}`}
                    >
                      <Checkbox
                        checked={sel.has(t.id)}
                        onCheckedChange={() => toggleUno(t.id)}
                        aria-label={`Seleccionar turno de las ${t.horaInicio}`}
                        data-testid={`planilla-sel-${t.id}`}
                      />
                      <button
                        onClick={() => setTurnoSeleccionado(t.id)}
                        className="col-span-6 grid grid-cols-subgrid py-2.5 text-left text-sm items-center cursor-pointer"
                        data-testid={`planilla-turno-${t.id}`}
                      >
                        <span className="font-semibold tabular-nums">{t.horaInicio}</span>
                        <span className="font-medium truncate">
                          {t.paciente ? `${t.paciente.apellido ?? ""}, ${t.paciente.nombre ?? ""}` : "Sin paciente"}
                        </span>
                        <span className="text-muted-foreground truncate">{t.paciente?.dni ?? "—"}</span>
                        <span className="text-muted-foreground truncate">{t.paciente?.telefono ?? "—"}</span>
                        <span className="text-muted-foreground truncate">{t.paciente?.cobertura ?? "—"}</span>
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border justify-self-start ${macro.bg} ${macro.color} ${macro.border}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${macro.dot}`} />
                          {macro.label}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
              <div className="pt-3 text-xs text-muted-foreground" data-testid="contador-turnos">
                Cantidad de turnos dados: {turnos.length} [Recepcionados: {recepcionados}]
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <FichaRecepcionDialog
        turnoId={turnoSeleccionado}
        abierto={turnoSeleccionado !== null}
        onClose={() => setTurnoSeleccionado(null)}
        onCambio={invalidarTurnosGrupo}
      />

      {/* Aviso emergente: paciente sin teléfono */}
      <Dialog open={Boolean(pacienteActualCola)} onOpenChange={(o) => { if (!o) setColaSinTelefono([]); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneOff className="w-5 h-5 text-red-600" /> Paciente sin teléfono
            </DialogTitle>
            <DialogDescription>
              {pacienteActualCola && (
                <>
                  <b>{nombrePaciente(pacienteActualCola)}</b> (turno de las {pacienteActualCola.horaInicio}) no tiene
                  teléfono cargado, así que no va a recibir el aviso por WhatsApp. Podés cargarlo ahora o continuar sin avisarle.
                  {colaSinTelefono.length > 1 && (
                    <span className="block mt-1 text-xs">Quedan {colaSinTelefono.length - 1} paciente(s) más sin teléfono.</span>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Celular (WhatsApp)</Label>
            <Input
              placeholder="Ej: 1155551234"
              value={telefonoNuevo}
              onChange={(e) => setTelefonoNuevo(e.target.value)}
              data-testid="input-telefono-cola"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={avanzarCola} data-testid="btn-continuar-sin-avisar">
              Continuar sin avisar
            </Button>
            <Button
              onClick={guardarTelefonoActual}
              disabled={!telefonoNuevo.trim() || updatePaciente.isPending}
              data-testid="btn-guardar-telefono"
            >
              {updatePaciente.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Guardar y seguir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmar cancelación */}
      <Dialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarX2 className="w-5 h-5 text-destructive" /> Cancelar {turnosSel.length === 1 ? "el turno" : `${turnosSel.length} turnos`}
            </DialogTitle>
            <DialogDescription>
              Esta acción cancela {turnosSel.length === 1 ? "el turno seleccionado" : "los turnos seleccionados"} del{" "}
              {fechaLegibleCorta(fecha)}. No se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Motivo (opcional, se agrega al mensaje)</Label>
              <Input
                placeholder="Ej: licencia del profesional"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                data-testid="input-motivo-cancelacion"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notificar} onCheckedChange={(v) => setNotificar(v === true)} data-testid="check-notificar-cancelacion" />
              ¿Notificar por WhatsApp a los pacientes?
            </label>
            <div className="space-y-1.5">
              <Label>Tu contraseña (código de ingreso)</Label>
              <PasswordInput
                autoComplete="current-password"
                placeholder="Ingresá tu contraseña para confirmar"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                data-testid="input-password-confirmacion"
              />
              <p className="text-xs text-muted-foreground">
                La acción queda registrada con tu nombre, fecha y detalle de lo cancelado.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setConfirmCancelOpen(false); setPasswordConfirm(""); }}>Volver</Button>
            <Button
              variant="destructive"
              onClick={() => void confirmarCancelacion()}
              disabled={cancelarMutation.isPending || !passwordConfirm.trim()}
              data-testid="btn-confirmar-cancelacion"
            >
              {cancelarMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Cancelar turnos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function fechaLegibleCorta(f: string): string {
  try {
    return format(new Date(`${f}T00:00:00`), "EEEE d 'de' MMMM", { locale: es });
  } catch {
    return f;
  }
}
