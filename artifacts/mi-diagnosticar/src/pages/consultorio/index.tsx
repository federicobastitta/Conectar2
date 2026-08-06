import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetConsultorioAgenda,
  useGetConsultorioProduccion,
  useGetDoctorDashboard,
  useCreatePractica,
  useUpdatePractica,
  useTomarTurnoGuardia,
  useSetDemandaEspontanea,
  getGetDoctorDashboardQueryKey,
  getGetConsultorioAgendaQueryKey,
  getGetConsultorioProduccionQueryKey,
  PracticaInputEstado,
  PracticaUpdateEstado,
  type Turno,
  type ProduccionPractica,
  type PracticaInput,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { PacienteBuscador } from "@/components/pacientes/paciente-buscador";
import {
  CalendarDays,
  ClipboardList,
  Stethoscope,
  TrendingUp,
  Users,
  Video,
  MapPin,
  Plus,
  FileText,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  Clock,
  CheckCircle2,
  FileSignature,
  Zap,
  Send,
  Activity,
  FlaskConical,
  Star,
} from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, PieChart, Pie, Cell } from "recharts";
import { DerivacionEstadoControl } from "@/pages/pacientes/derivacion-estado";
import { format } from "date-fns";
import { es } from "date-fns/locale";

function hoyISO() {
  return new Date().toISOString().split("T")[0];
}

function formatFechaLarga(value: string) {
  const d = new Date(`${value}T12:00:00`);
  return isNaN(d.getTime()) ? value : format(d, "EEEE d 'de' MMMM yyyy", { locale: es });
}

const ESTADO_TURNO_COLORS: Record<string, string> = {
  pendiente: "bg-blue-100 text-blue-800",
  confirmado: "bg-indigo-100 text-indigo-800",
  en_sala: "bg-amber-100 text-amber-800",
  atendido: "bg-green-100 text-green-800",
  cancelado: "bg-red-100 text-red-700",
  ausente: "bg-muted text-muted-foreground",
};

const ESTADO_PRACTICA_COLORS: Record<string, string> = {
  indicada: "bg-blue-100 text-blue-800",
  autorizada: "bg-indigo-100 text-indigo-800",
  pendiente: "bg-amber-100 text-amber-800",
  realizada: "bg-green-100 text-green-800",
  cancelada: "bg-red-100 text-red-700",
};

function EstadoBadge({ estado, map }: { estado?: string | null; map: Record<string, string> }) {
  const e = estado ?? "—";
  return (
    <Badge variant="secondary" className={`${map[e] ?? "bg-muted text-muted-foreground"} border-0 capitalize`}>
      {e.replace(/_/g, " ")}
    </Badge>
  );
}

// ── Pestaña Agenda ──────────────────────────────────────────────────────────

function TabAgenda() {
  const [fecha, setFecha] = useState(hoyISO());
  const { data, isLoading, error } = useGetConsultorioAgenda({ fecha });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const tomar = useTomarTurnoGuardia({
    mutation: {
      onSuccess: () => {
        toast({ title: "Paciente tomado", description: "El paciente quedó asignado a vos." });
        queryClient.invalidateQueries({ queryKey: getGetConsultorioAgendaQueryKey({ fecha }) });
      },
      onError: (e: unknown) => {
        const status = (e as { status?: number })?.status;
        const serverError = (e as { data?: { error?: string } })?.data?.error;
        toast({
          title: status === 409 ? "Otro médico ya lo tomó" : "No se pudo tomar el paciente",
          description:
            status === 409
              ? "El paciente ya fue tomado por otro profesional."
              : (serverError ?? "Intentá de nuevo."),
          variant: "destructive",
        });
        queryClient.invalidateQueries({ queryKey: getGetConsultorioAgendaQueryKey({ fecha }) });
      },
    },
  });

  const turnos: Turno[] = data?.turnos ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="fecha-agenda" className="text-xs text-muted-foreground">
            Fecha
          </Label>
          <Input
            id="fecha-agenda"
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value || hoyISO())}
            className="w-44"
          />
        </div>
        <div className="text-sm text-muted-foreground pb-2 capitalize">{formatFechaLarga(fecha)}</div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No se pudo cargar la agenda. Verificá tu conexión o permisos.
          </CardContent>
        </Card>
      ) : turnos.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <CalendarDays className="w-8 h-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No hay turnos para esta fecha.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {turnos.map((t) => (
            <Card key={t.id}>
              <CardContent className="py-3 px-4 flex flex-wrap items-center gap-3">
                <span
                  title={t.esGuardia ? "Paciente de agenda grupal" : "Turno programado"}
                  data-testid={`indicador-origen-turno-${t.id}`}
                  className={`w-7 h-7 shrink-0 rounded-md flex items-center justify-center text-xs font-bold ${
                    t.esGuardia ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
                  }`}
                >
                  {t.esGuardia ? "G" : "T"}
                </span>
                <div className="font-mono text-sm font-semibold w-24 shrink-0">
                  {t.horaInicio ?? "--:--"}–{t.horaFin ?? "--:--"}
                </div>
                <div className="flex-1 min-w-[180px]">
                  <div className="font-medium text-sm">
                    {t.paciente ? `${t.paciente.apellido ?? ""}, ${t.paciente.nombre ?? ""}` : `Paciente #${t.pacienteId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t.paciente?.dni ? `DNI ${t.paciente.dni}` : ""}
                    {t.motivoConsulta ? ` · ${t.motivoConsulta}` : ""}
                  </div>
                </div>
                <div className="w-44 shrink-0 text-xs" data-testid={`medico-turno-${t.id}`}>
                  <div className="text-muted-foreground/70 uppercase tracking-wide text-[10px]">Médico</div>
                  <div className="font-medium truncate" title={t.profesionalNombre ?? undefined}>
                    {t.profesionalNombre ?? "Sin asignar"}
                  </div>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {t.modalidad === "videoconsulta" ? (
                    t.videollamadaUrl ? (
                      <a
                        href={t.videollamadaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-violet-700 dark:text-violet-300 font-medium hover:underline"
                        data-testid={`link-videollamada-${t.id}`}
                      >
                        <Video className="w-3.5 h-3.5" /> Videollamada
                      </a>
                    ) : (
                      <>
                        <Video className="w-3.5 h-3.5" /> Video
                      </>
                    )
                  ) : (
                    <>
                      <MapPin className="w-3.5 h-3.5" /> Presencial
                    </>
                  )}
                </div>
                <EstadoBadge estado={t.estado} map={ESTADO_TURNO_COLORS} />
                {t.esGuardia && t.profesionalId == null ? (
                  <Button
                    size="sm"
                    className="gap-1 bg-red-600 hover:bg-red-700 text-white"
                    disabled={tomar.isPending}
                    onClick={() => tomar.mutate({ id: t.id })}
                    data-testid={`button-tomar-${t.id}`}
                  >
                    <Stethoscope className="w-3.5 h-3.5" /> Tomar paciente
                  </Button>
                ) : (
                  <Link href={`/pacientes/${t.pacienteId}/consulta?turno=${t.id}`}>
                    <Button size="sm" className="gap-1">
                      <Stethoscope className="w-3.5 h-3.5" /> Atender
                    </Button>
                  </Link>
                )}
                <Link href={`/pacientes/${t.pacienteId}/hce`}>
                  <Button size="sm" variant="outline" className="gap-1">
                    <FileText className="w-3.5 h-3.5" /> HCE
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pestaña Consultorio (indicar prácticas) ─────────────────────────────────

function TabConsultorio() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<{ pacienteId: string; nombre: string; estado: string; notas: string }>({
    pacienteId: "",
    nombre: "",
    estado: "indicada",
    notas: "",
  });

  const crearPractica = useCreatePractica({
    mutation: {
      onSuccess: () => {
        toast({ title: "Práctica indicada", description: "Se registró la práctica correctamente." });
        setForm({ pacienteId: "", nombre: "", estado: "indicada", notas: "" });
        queryClient.invalidateQueries({ queryKey: getGetConsultorioProduccionQueryKey() });
      },
      onError: () => {
        toast({ title: "Error", description: "No se pudo registrar la práctica.", variant: "destructive" });
      },
    },
  });

  const submit = () => {
    const pacienteId = parseInt(form.pacienteId);
    if (!pacienteId || !form.nombre.trim()) {
      toast({ title: "Faltan datos", description: "Seleccioná un paciente y escribí el nombre de la práctica.", variant: "destructive" });
      return;
    }
    const data: PracticaInput = {
      pacienteId,
      nombre: form.nombre.trim(),
      estado: (form.estado || "indicada") as PracticaInput["estado"],
      ...(form.notas.trim() ? { notas: form.notas.trim() } : {}),
    };
    crearPractica.mutate({ data });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4" /> Indicar práctica
          </CardTitle>
          <CardDescription>Registrá una práctica o estudio para un paciente.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Paciente</Label>
            <PacienteBuscador
              placeholder="Buscar por DNI o nombre"
              data-testid="buscador-paciente-practica"
              onSelect={(p) => setForm((f) => ({ ...f, pacienteId: String(p.id) }))}
              onTexto={() => setForm((f) => ({ ...f, pacienteId: "" }))}
            />
          </div>
          <div>
            <Label className="text-xs">Práctica / estudio</Label>
            <Input
              placeholder="Ej: Ecografía abdominal, Laboratorio completo"
              value={form.nombre}
              onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            />
          </div>
          <div>
            <Label className="text-xs">Estado inicial</Label>
            <Select value={form.estado} onValueChange={(v) => setForm((f) => ({ ...f, estado: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(PracticaInputEstado).map((e) => (
                  <SelectItem key={e} value={e} className="capitalize">
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Notas (opcional)</Label>
            <Textarea
              rows={2}
              placeholder="Ej: con ayuno de 8 horas"
              value={form.notas}
              onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))}
            />
          </div>
          <Button onClick={submit} disabled={crearPractica.isPending} className="w-full">
            {crearPractica.isPending ? "Guardando..." : "Indicar práctica"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Stethoscope className="w-4 h-4" /> Atención del paciente
          </CardTitle>
          <CardDescription>Accesos rápidos del consultorio.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Para registrar una consulta completa (evolución, diagnóstico, signos vitales y recetas), abrí la HCE del
            paciente desde la pestaña <span className="font-medium">Agenda</span> o desde el listado de pacientes.
          </p>
          <Link href="/pacientes">
            <Button variant="outline" className="gap-1 mt-2">
              <Users className="w-4 h-4" /> Ir a pacientes
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Pestaña Mi Producción ───────────────────────────────────────────────────

function FilaPractica({ practica }: { practica: ProduccionPractica }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const actualizar = useUpdatePractica({
    mutation: {
      onSuccess: () => {
        toast({ title: "Práctica actualizada" });
        queryClient.invalidateQueries({ queryKey: getGetConsultorioProduccionQueryKey() });
      },
      onError: () => {
        toast({ title: "Error", description: "No se pudo actualizar la práctica.", variant: "destructive" });
      },
    },
  });

  const pacientes = practica.pacientes ?? [];

  return (
    <Card>
      <button className="w-full text-left" onClick={() => setOpen((o) => !o)}>
        <CardContent className="py-3 px-4 flex items-center gap-3">
          {open ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
          <div className="flex-1 font-medium text-sm">{practica.nombre ?? "Sin nombre"}</div>
          <div className="flex gap-2 text-xs">
            <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-0">
              {practica.indicadas ?? 0} total
            </Badge>
            <Badge variant="secondary" className="bg-green-100 text-green-800 border-0">
              {practica.realizadas ?? 0} realizadas
            </Badge>
            <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-0">
              {practica.pendientes ?? 0} pendientes
            </Badge>
          </div>
        </CardContent>
      </button>
      {open && (
        <CardContent className="pt-0 pb-3 px-4">
          <div className="border-t pt-3 space-y-2">
            {pacientes.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sin pacientes registrados.</p>
            ) : (
              pacientes.map((p) => (
                <div key={p.practicaId} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/pacientes/${p.pacienteId}/hce`} className="font-medium hover:underline">
                    {p.nombrePaciente ?? `Paciente #${p.pacienteId}`}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {p.dni ? `DNI ${p.dni} · ` : ""}
                    {p.fecha ?? ""}
                    {p.notas ? ` · ${p.notas}` : ""}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <EstadoBadge estado={p.estado} map={ESTADO_PRACTICA_COLORS} />
                    <Select
                      value={p.estado}
                      onValueChange={(v) =>
                        actualizar.mutate({
                          practicaId: p.practicaId,
                          data: { estado: v as (typeof PracticaUpdateEstado)[keyof typeof PracticaUpdateEstado] },
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(PracticaUpdateEstado).map((e) => (
                          <SelectItem key={e} value={e} className="capitalize text-xs">
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function TabProduccion() {
  const { data, isLoading, error } = useGetConsultorioProduccion();
  const [kpiSel, setKpiSel] = useState<{
    label: string;
    value: number;
    explicacion: string;
    detalle?: Array<{ pacienteId?: number; texto: string; extra?: string }>;
  } | null>(null);
  const queryClient = useQueryClient();
  const refrescarProduccion = () => queryClient.invalidateQueries({ queryKey: getGetConsultorioProduccionQueryKey() });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No se pudo cargar la producción. Verificá tu conexión o permisos.
        </CardContent>
      </Card>
    );
  }

  const practicas = data?.practicas ?? [];
  const ultimos = data?.ultimosAtendidos ?? [];
  const derivaciones = data?.derivaciones ?? [];

  // Cortes de fecha para filtrar los atendidos (mismo criterio que el servidor)
  const ahora = new Date();
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const inicioSemana = new Date(inicioHoy);
  inicioSemana.setDate(inicioHoy.getDate() - ((inicioHoy.getDay() + 6) % 7)); // lunes

  const atendidosDesde = (desde: Date) =>
    ultimos.filter((u) => u.fecha && new Date(u.fecha) >= desde);

  // Serie de consultas por día (últimos 14 días) a partir de las consultas del mes
  const serieDias = Array.from({ length: 14 }, (_, i) => {
    const dia = new Date(inicioHoy);
    dia.setDate(inicioHoy.getDate() - (13 - i));
    const sig = new Date(dia);
    sig.setDate(dia.getDate() + 1);
    return {
      dia: format(dia, "EEE d", { locale: es }),
      consultas: ultimos.filter((u) => {
        if (!u.fecha) return false;
        const f = new Date(u.fecha);
        return f >= dia && f < sig;
      }).length,
    };
  });

  // Derivaciones por estado (para el anillo)
  const ESTADOS_DERIV: Array<{ estado: string; label: string; color: string }> = [
    { estado: "pedido", label: "Pedidas", color: "#f59e0b" },
    { estado: "agendado", label: "Agendadas", color: "#3b82f6" },
    { estado: "realizado", label: "Realizadas", color: "#22c55e" },
    { estado: "informado", label: "Informadas", color: "#8b5cf6" },
    { estado: "anulada", label: "Anuladas", color: "#94a3b8" },
  ];
  const derivPorEstado = ESTADOS_DERIV
    .map((e) => ({ ...e, cantidad: derivaciones.filter((d) => d.estado === e.estado).length }))
    .filter((e) => e.cantidad > 0);

  // Totales de prácticas indicadas y del circuito de estudios
  const practicasTotales = practicas.reduce(
    (acc, p) => ({
      indicadas: acc.indicadas + (p.indicadas ?? 0),
      realizadas: acc.realizadas + (p.realizadas ?? 0),
      pendientes: acc.pendientes + (p.pendientes ?? 0),
    }),
    { indicadas: 0, realizadas: 0, pendientes: 0 },
  );
  const estRealizadas = data?.ordenesDerivadas?.realizadasMes ?? 0;
  const estPendientes = data?.ordenesDerivadas?.pendientes ?? 0;
  const estTotal = estRealizadas + estPendientes;

  // Indicadores adicionales del mes
  const pacientesUnicos = new Set(ultimos.map((u) => u.pacienteId)).size;
  const diasConConsulta = new Set(
    ultimos.filter((u) => u.fecha).map((u) => format(new Date(u.fecha!), "yyyy-MM-dd")),
  ).size;
  const promedioPorDia = diasConConsulta ? ((data?.atendidosMes ?? 0) / diasConConsulta).toFixed(1) : "0";
  const derivCerradas = derivaciones.filter((d) => ["realizado", "informado"].includes(d.estado ?? "")).length;
  const derivTotalActivas = derivaciones.filter((d) => d.estado !== "anulada").length;

  // Consultas por franja horaria (mañana/tarde/noche)
  const serieFranjas = [
    { franja: "Mañana (7–13)", desde: 7, hasta: 13, color: "#38bdf8" },
    { franja: "Tarde (13–19)", desde: 13, hasta: 19, color: "#f59e0b" },
    { franja: "Noche (19–7)", desde: 19, hasta: 31, color: "#8b5cf6" },
  ].map((f) => ({
    ...f,
    consultas: ultimos.filter((u) => {
      if (!u.fecha) return false;
      const h = new Date(u.fecha).getHours();
      const hh = h < 7 ? h + 24 : h;
      return hh >= f.desde && hh < f.hasta;
    }).length,
  }));

  // Prácticas más indicadas (top 6)
  const topPracticas = [...practicas]
    .sort((a, b) => (b.indicadas ?? 0) - (a.indicadas ?? 0))
    .slice(0, 6)
    .map((p) => ({
      nombre: p.nombre.length > 22 ? `${p.nombre.slice(0, 22)}…` : p.nombre,
      Realizadas: p.realizadas ?? 0,
      Pendientes: p.pendientes ?? 0,
    }));

  // Mix de actividad del mes
  const mixActividad = [
    { label: "Consultas", cantidad: data?.atendidosMes ?? 0, color: "#3b82f6" },
    { label: "Estudios derivados", cantidad: estTotal, color: "#22c55e" },
    { label: "Prácticas indicadas", cantidad: practicasTotales.indicadas, color: "#f59e0b" },
    { label: "Derivaciones", cantidad: derivTotalActivas, color: "#8b5cf6" },
  ].filter((m) => m.cantidad > 0);

  const kpis: Array<{
    label: string;
    value: number;
    explicacion: string;
    icon: typeof Users;
    accent: string;
    detalle?: Array<{ pacienteId?: number; texto: string; extra?: string }>;
  }> = [
    {
      label: "Atendidos hoy",
      icon: Stethoscope,
      accent: "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-500/20",
      value: data?.atendidosHoy ?? 0,
      explicacion: "Consultas que registraste hoy en el consultorio (una por cada evolución guardada).",
      detalle: atendidosDesde(inicioHoy).map((u) => ({
        pacienteId: u.pacienteId,
        texto: u.nombrePaciente ?? `Paciente #${u.pacienteId}`,
        extra: u.fecha ? format(new Date(u.fecha), "HH:mm", { locale: es }) : undefined,
      })),
    },
    {
      label: "Esta semana",
      icon: CalendarDays,
      accent: "text-indigo-600 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-500/20",
      value: data?.atendidosSemana ?? 0,
      explicacion: "Consultas registradas desde el lunes hasta hoy.",
      detalle: atendidosDesde(inicioSemana).map((u) => ({
        pacienteId: u.pacienteId,
        texto: u.nombrePaciente ?? `Paciente #${u.pacienteId}`,
        extra: u.fecha ? format(new Date(u.fecha), "EEE d · HH:mm", { locale: es }) : undefined,
      })),
    },
    {
      label: "Este mes",
      icon: TrendingUp,
      accent: "text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/20",
      value: data?.atendidosMes ?? 0,
      explicacion: "Consultas registradas desde el día 1 del mes en curso.",
      detalle: ultimos.map((u) => ({
        pacienteId: u.pacienteId,
        texto: u.nombrePaciente ?? `Paciente #${u.pacienteId}`,
        extra: u.fecha ? format(new Date(u.fecha), "d MMM · HH:mm", { locale: es }) : undefined,
      })),
    },
    {
      label: "Estudios realizados (mes)",
      icon: CheckCircle2,
      accent: "text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-500/20",
      value: estRealizadas,
      explicacion:
        "Órdenes de estudio que emitiste (RX, laboratorio, resonancia, etc.) y que ya se realizaron, informaron o entregaron durante este mes.",
    },
    {
      label: "Estudios pendientes",
      icon: Clock,
      accent: "text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20",
      value: estPendientes,
      explicacion:
        "Órdenes de estudio que emitiste y que todavía no se realizaron: están solicitadas, esperando programación, programadas o en realización. El detalle está en la ficha de cada paciente, pestaña Estudios.",
    },
  ];

  return (
    <div className="space-y-5">
      {/* Encabezado del tablero */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" /> Tablero de mando
          </h2>
          <p className="text-xs text-muted-foreground capitalize">
            {format(ahora, "EEEE d 'de' MMMM yyyy", { locale: es })} · tocá cualquier indicador para ver el detalle
          </p>
        </div>
      </div>

      {/* Indicadores principales */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {kpis.map((k) => (
          <Card
            key={k.label}
            className="cursor-pointer transition-all hover:border-primary/60 hover:shadow-md"
            onClick={() => setKpiSel(k)}
            data-testid={`kpi-${k.label}`}
          >
            <CardContent className="py-4 px-4 flex items-start justify-between gap-2">
              <div>
                <div className="text-3xl font-bold tabular-nums">{k.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5 leading-tight">{k.label}</div>
              </div>
              <div className={`p-2 rounded-lg shrink-0 ${k.accent}`}>
                <k.icon className="w-4 h-4" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Gráficos: ritmo de consultas + circuitos */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> Ritmo de consultas — últimos 14 días
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={serieDias} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
                  <XAxis dataKey="dia" tick={{ fontSize: 10 }} interval={1} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <ChartTooltip
                    cursor={{ fill: "rgba(59,130,246,0.08)" }}
                    formatter={(v: number) => [`${v} consulta${v === 1 ? "" : "s"}`, ""]}
                    labelStyle={{ textTransform: "capitalize" }}
                  />
                  <Bar dataKey="consultas" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {/* Circuito de estudios derivados */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-primary" /> Estudios derivados
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {estTotal === 0 ? (
                <p className="text-sm text-muted-foreground">Sin órdenes de estudio emitidas.</p>
              ) : (
                <>
                  <div className="flex justify-between text-xs">
                    <span className="text-green-700 dark:text-green-300 font-medium">{estRealizadas} realizados</span>
                    <span className="text-amber-700 dark:text-amber-300 font-medium">{estPendientes} pendientes</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-amber-200 dark:bg-amber-500/30 overflow-hidden">
                    <div
                      className="h-full bg-green-500 dark:bg-green-600"
                      style={{ width: `${estTotal ? Math.round((estRealizadas / estTotal) * 100) : 0}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {estTotal ? Math.round((estRealizadas / estTotal) * 100) : 0}% del circuito completado este mes
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Derivaciones por estado */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Send className="w-4 h-4 text-primary" /> Derivaciones por estado
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {derivPorEstado.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin derivaciones pedidas.</p>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="h-24 w-24 shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={derivPorEstado} dataKey="cantidad" nameKey="label" innerRadius={26} outerRadius={44} paddingAngle={2} strokeWidth={0}>
                          {derivPorEstado.map((e) => <Cell key={e.estado} fill={e.color} />)}
                        </Pie>
                        <ChartTooltip formatter={(v: number, n: string) => [v, n]} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1 text-xs">
                    {derivPorEstado.map((e) => (
                      <div key={e.estado} className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: e.color }} />
                        <span className="text-muted-foreground">{e.label}</span>
                        <span className="font-semibold tabular-nums">{e.cantidad}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Indicadores secundarios del mes */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardContent className="py-3 px-4">
            <div className="text-2xl font-bold tabular-nums">
              {data?.duracionPromedioMin != null ? `${Math.round(data.duracionPromedioMin)} min` : "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              Duración promedio de consulta
              {data?.consultasConDuracion ? ` (${data.consultasConDuracion} medidas)` : ""}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <div className="text-2xl font-bold tabular-nums">{pacientesUnicos}</div>
            <div className="text-xs text-muted-foreground">Pacientes distintos este mes</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <div className="text-2xl font-bold tabular-nums">{promedioPorDia}</div>
            <div className="text-xs text-muted-foreground">Consultas promedio por día activo</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <div className="text-2xl font-bold tabular-nums">{diasConConsulta}</div>
            <div className="text-xs text-muted-foreground">Días con actividad este mes</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <div className="text-2xl font-bold tabular-nums">
              {derivTotalActivas ? Math.round((derivCerradas / derivTotalActivas) * 100) : 0}%
            </div>
            <div className="text-xs text-muted-foreground">Derivaciones resueltas</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <div className="text-2xl font-bold tabular-nums">
              {data?.atendidosMes
                ? ((data.derivacionesMes ?? 0) / data.atendidosMes).toFixed(2).replace(".", ",")
                : "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              Derivaciones promedio por consulta
              {data?.derivacionesMes != null ? ` (${data.derivacionesMes} este mes)` : ""}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Satisfacción de los pacientes */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-500" /> Satisfacción de los pacientes
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data?.satisfaccion == null || data.satisfaccion.respuestas === 0 ? (
            <p className="text-sm text-muted-foreground">
              Todavía no hay valoraciones. Después de cada consulta se le pide al paciente, desde su app, que
              califique la atención de 1 a 5 estrellas
              {data?.satisfaccion?.invitaciones ? ` (${data.satisfaccion.invitaciones} invitaciones enviadas)` : ""}.
            </p>
          ) : (
            <div className="flex flex-col md:flex-row gap-4 md:items-start">
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-4xl font-bold tabular-nums">
                  {(data.satisfaccion.promedio ?? 0).toFixed(1)}
                </div>
                <div>
                  <div className="flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={`w-4 h-4 ${n <= Math.round(data.satisfaccion?.promedio ?? 0) ? "text-amber-500 fill-amber-500" : "text-muted-foreground/30"}`}
                      />
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {data.satisfaccion.respuestas} {data.satisfaccion.respuestas === 1 ? "respuesta" : "respuestas"} de{" "}
                    {data.satisfaccion.invitaciones} invitaciones
                  </div>
                </div>
              </div>
              {(data.satisfaccion.ultimosComentarios ?? []).length > 0 && (
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Últimos comentarios</div>
                  {(data.satisfaccion.ultimosComentarios ?? []).map((c, i) => (
                    <div key={i} className="text-xs bg-muted/50 rounded-md px-2.5 py-1.5 flex items-start gap-2">
                      <span className="flex items-center gap-0.5 shrink-0 font-medium text-amber-600 dark:text-amber-400">
                        {c.puntaje} <Star className="w-3 h-3 fill-current" />
                      </span>
                      <span className="min-w-0 break-words">{c.comentario}</span>
                      {c.fecha && (
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {new Date(c.fecha).toLocaleDateString("es-AR")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Segunda fila de gráficos */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" /> Consultas por franja horaria (mes)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {ultimos.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin consultas este mes.</p>
            ) : (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={serieFranjas} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="franja" width={92} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <ChartTooltip formatter={(v: number) => [`${v} consulta${v === 1 ? "" : "s"}`, ""]} />
                    <Bar dataKey="consultas" radius={[0, 4, 4, 0]} maxBarSize={20}>
                      {serieFranjas.map((f) => <Cell key={f.franja} fill={f.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-primary" /> Prácticas más indicadas
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {topPracticas.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no indicaste prácticas.</p>
            ) : (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topPracticas} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="nombre" width={120} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <ChartTooltip />
                    <Bar dataKey="Realizadas" stackId="a" fill="#22c55e" maxBarSize={16} />
                    <Bar dataKey="Pendientes" stackId="a" fill="#f59e0b" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" /> Mix de actividad del mes
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {mixActividad.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin actividad registrada este mes.</p>
            ) : (
              <div className="flex items-center gap-3">
                <div className="h-32 w-32 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={mixActividad} dataKey="cantidad" nameKey="label" innerRadius={34} outerRadius={58} paddingAngle={2} strokeWidth={0}>
                        {mixActividad.map((m) => <Cell key={m.label} fill={m.color} />)}
                      </Pie>
                      <ChartTooltip formatter={(v: number, n: string) => [v, n]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-1 text-xs">
                  {mixActividad.map((m) => (
                    <div key={m.label} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: m.color }} />
                      <span className="text-muted-foreground">{m.label}</span>
                      <span className="font-semibold tabular-nums">{m.cantidad}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pacientes por obra social y por edades */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" /> Pacientes del mes por obra social
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {(data?.porObraSocial ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin pacientes atendidos este mes.</p>
            ) : (
              <div style={{ height: Math.max(120, (data?.porObraSocial ?? []).slice(0, 8).length * 34) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(data?.porObraSocial ?? []).slice(0, 8).map((o) => ({
                      nombre: o.nombre.length > 22 ? `${o.nombre.slice(0, 22)}…` : o.nombre,
                      Pacientes: o.cantidad,
                    }))}
                    layout="vertical"
                    margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
                  >
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="nombre" width={140} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <ChartTooltip />
                    <Bar dataKey="Pacientes" fill="#6366f1" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" /> Pacientes del mes por edad
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={(data?.porEdad ?? []).map((e) => ({ rango: e.rango, Pacientes: e.cantidad }))}
                  margin={{ top: 4, right: 8, left: -18, bottom: 0 }}
                >
                  <XAxis dataKey="rango" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <ChartTooltip />
                  <Bar dataKey="Pacientes" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Estudios solicitados */}
      <div className="grid gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-primary" /> Estudios solicitados por tipo
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {(data?.estudiosSolicitados ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no solicitaste estudios.</p>
            ) : (
              <div style={{ height: Math.max(120, (data?.estudiosSolicitados ?? []).slice(0, 10).length * 34) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(data?.estudiosSolicitados ?? []).slice(0, 10).map((e) => ({
                      nombre: e.nombre.length > 26 ? `${e.nombre.slice(0, 26)}…` : e.nombre,
                      Realizados: e.realizados,
                      Pendientes: e.pendientes,
                    }))}
                    layout="vertical"
                    margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
                  >
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="nombre" width={150} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <ChartTooltip />
                    <Bar dataKey="Realizados" stackId="e" fill="#22c55e" maxBarSize={16} />
                    <Bar dataKey="Pendientes" stackId="e" fill="#f59e0b" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="flex gap-4 mt-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> Realizados</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> Pendientes</span>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Detalle del indicador clickeado */}
      <Dialog open={kpiSel !== null} onOpenChange={(v) => { if (!v) setKpiSel(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{kpiSel?.label}</DialogTitle>
            <DialogDescription>{kpiSel?.explicacion}</DialogDescription>
          </DialogHeader>
          {kpiSel?.detalle && (
            kpiSel.detalle.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin consultas en este período.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto divide-y">
                {kpiSel.detalle.map((d, i) => (
                  <div key={i} className="py-1.5 flex items-center gap-2 text-sm">
                    {d.pacienteId ? (
                      <Link href={`/pacientes/${d.pacienteId}/hce`} className="font-medium hover:underline">
                        {d.texto}
                      </Link>
                    ) : (
                      <span className="font-medium">{d.texto}</span>
                    )}
                    {d.extra && <span className="ml-auto text-xs text-muted-foreground capitalize">{d.extra}</span>}
                  </div>
                ))}
              </div>
            )
          )}
        </DialogContent>
      </Dialog>

      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <ClipboardList className="w-4 h-4" /> Prácticas indicadas
          {practicasTotales.indicadas > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {practicasTotales.indicadas} indicadas · {practicasTotales.realizadas} realizadas · {practicasTotales.pendientes} pendientes
            </span>
          )}
        </h3>
        {practicas.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Todavía no indicaste prácticas.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {practicas.map((p) => (
              <FilaPractica key={p.nombre} practica={p} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Send className="w-4 h-4" /> Derivaciones a servicios de la clínica
        </h3>
        {derivaciones.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Todavía no pediste derivaciones.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-2 px-4 divide-y">
              {derivaciones.map((d) => (
                <div key={d.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/pacientes/${d.pacienteId}/hce`} className="font-medium hover:underline">
                    {d.nombrePaciente}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {d.dni ? `DNI ${d.dni} · ` : ""}
                    → {d.targetSpecialty}
                    {d.createdAt ? ` · ${format(new Date(d.createdAt), "d MMM yyyy", { locale: es })}` : ""}
                  </span>
                  {d.priority === "urgente" && <Badge variant="destructive" className="text-xs">Urgente</Badge>}
                  <span className="ml-auto">
                    <DerivacionEstadoControl derivacion={{ id: d.id, status: d.estado }} onChanged={refrescarProduccion} />
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Users className="w-4 h-4" /> Últimos pacientes atendidos
        </h3>
        {ultimos.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Sin consultas registradas este mes.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-2 px-4 divide-y">
              {ultimos.slice(0, 20).map((u) => (
                <div key={u.encounterId} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/pacientes/${u.pacienteId}/hce`} className="font-medium hover:underline">
                    {u.nombrePaciente ?? `Paciente #${u.pacienteId}`}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {u.dni ? `DNI ${u.dni} · ` : ""}
                    {u.fecha ? format(new Date(u.fecha), "d MMM yyyy HH:mm", { locale: es }) : ""}
                  </span>
                  {u.diagnostico && (
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {u.diagnostico}
                    </Badge>
                  )}
                  {(u.pedidos ?? []).length > 0 && (
                    <div className="w-full flex flex-wrap items-center gap-1.5 pl-1">
                      <span className="text-[11px] text-muted-foreground">Se pidió:</span>
                      {(u.pedidos ?? []).map((p, i) => (
                        <Badge
                          key={i}
                          variant="outline"
                          className="text-[11px] font-normal text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/10"
                        >
                          {p}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Pestaña Inicio (dashboard del médico) ───────────────────────────────────

function TabInicio() {
  const { data, isLoading, error } = useGetDoctorDashboard();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const demandaMutation = useSetDemandaEspontanea();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No se pudo cargar el resumen del día. Verificá tu conexión o permisos.
        </CardContent>
      </Card>
    );
  }

  const kpis = [
    { label: "Turnos hoy", valor: data.turnosHoy, icon: CalendarDays, href: "/recepcion/agenda-medico" },
    { label: "Atendidos", valor: data.atendidosHoy, icon: CheckCircle2 },
    { label: "Pendientes", valor: data.pendientes, icon: Clock },
    { label: "Documentos emitidos", valor: data.documentosEmitidosHoy, icon: FileSignature },
  ];

  const toggleDemanda = (activo: boolean) => {
    demandaMutation.mutate(
      { data: { aceptar: activo } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDoctorDashboardQueryKey() });
          toast({
            title: activo ? "Demanda espontánea activada" : "Demanda espontánea desactivada",
            description: activo
              ? "Recepción puede cargarte pacientes sin turno en la sala."
              : "Ya no recibís pacientes sin turno.",
          });
        },
        onError: () => toast({ title: "No se pudo cambiar el estado", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-5">
      <Card className={data.aceptaDemandaEspontanea ? "border-amber-400/60" : undefined}>
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${data.aceptaDemandaEspontanea ? "bg-amber-100 dark:bg-amber-500/20" : "bg-muted"}`}>
              <Zap className={`w-5 h-5 ${data.aceptaDemandaEspontanea ? "text-amber-500" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="font-medium text-sm">Acepto demanda espontánea</p>
              <p className="text-xs text-muted-foreground">
                Recepción puede cargarte pacientes sin turno mientras esté prendido.
              </p>
            </div>
          </div>
          <Switch
            checked={!!data.aceptaDemandaEspontanea}
            onCheckedChange={toggleDemanda}
            disabled={demandaMutation.isPending}
            data-testid="switch-demanda-espontanea"
          />
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {kpis.map((k) => {
          const contenido = (
            <CardContent className="p-4 flex items-center gap-3">
              <div className="bg-primary/10 p-2 rounded-lg"><k.icon className="w-5 h-5 text-primary" /></div>
              <div>
                <p className="text-2xl font-bold">{k.valor}</p>
                <p className="text-xs text-muted-foreground">{k.label}</p>
              </div>
            </CardContent>
          );
          return k.href ? (
            <Link key={k.label} href={k.href} data-testid={`kpi-${k.label}`}>
              <Card className="cursor-pointer transition-colors hover:border-primary/60 hover:bg-accent/40 h-full">
                {contenido}
              </Card>
            </Link>
          ) : (
            <Card key={k.label}>{contenido}</Card>
          );
        })}
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Clock className="w-4 h-4" /> Próximos turnos
        </h3>
        {data.proximosTurnos.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No quedan turnos pendientes para hoy.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-2 px-4 divide-y">
              {data.proximosTurnos.map((t) => (
                <div key={t.turnoId} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{t.hora}</span>
                  {t.pacienteId ? (
                    <Link href={`/pacientes/${t.pacienteId}/hce`} className="font-medium hover:underline">
                      {t.nombrePaciente}
                    </Link>
                  ) : (
                    <span className="font-medium">{t.nombrePaciente}</span>
                  )}
                  <span className="ml-auto">
                    <EstadoBadge estado={t.estado} map={ESTADO_TURNO_COLORS} />
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {data.tareasPendientes.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <ClipboardList className="w-4 h-4" /> Tareas pendientes
          </h3>
          <Card>
            <CardContent className="py-2 px-4 divide-y">
              {data.tareasPendientes.map((t) => (
                <div key={`${t.tipo}-${t.refId}`} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline" className="text-xs capitalize">{t.tipo.replace(/_/g, " ")}</Badge>
                  <span className="flex-1">{t.descripcion}</span>
                  {t.nombrePaciente && <span className="text-xs text-muted-foreground">{t.nombrePaciente}</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

export default function ConsultorioDigital() {
  // Permite entrar directo a una pestaña con /consultorio?tab=produccion
  const search = useSearch();
  const [tabActiva, setTabActiva] = useState(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return tab && ["inicio", "agenda", "consultorio", "produccion"].includes(tab) ? tab : "inicio";
  });
  useEffect(() => {
    const tab = new URLSearchParams(search).get("tab");
    if (tab && ["inicio", "agenda", "consultorio", "produccion"].includes(tab)) {
      setTabActiva(tab);
    }
  }, [search]);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Stethoscope className="w-6 h-6 text-primary" /> Consultorio Digital
          </h1>
          <p className="text-sm text-muted-foreground">
            Tu agenda del día, indicación de prácticas y producción del mes.
          </p>
        </div>
        <Link href="/recepcion/agenda-medico">
          <Button size="sm" className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white" data-testid="button-mi-agenda-completa">
            <CalendarDays className="w-4 h-4" /> Mi agenda completa
          </Button>
        </Link>
      </div>

      <Tabs value={tabActiva} onValueChange={setTabActiva}>
        <TabsList>
          <TabsTrigger value="inicio" className="gap-1">
            <LayoutDashboard className="w-4 h-4" /> Inicio
          </TabsTrigger>
          <TabsTrigger value="agenda" className="gap-1">
            <CalendarDays className="w-4 h-4" /> Agenda
          </TabsTrigger>
          <TabsTrigger value="consultorio" className="gap-1">
            <Stethoscope className="w-4 h-4" /> Consultorio
          </TabsTrigger>
          <TabsTrigger value="produccion" className="gap-1">
            <TrendingUp className="w-4 h-4" /> Mi Producción
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inicio" className="mt-4">
          <TabInicio />
        </TabsContent>
        <TabsContent value="agenda" className="mt-4">
          <TabAgenda />
        </TabsContent>
        <TabsContent value="consultorio" className="mt-4">
          <TabConsultorio />
        </TabsContent>
        <TabsContent value="produccion" className="mt-4">
          <TabProduccion />
        </TabsContent>
      </Tabs>
    </div>
  );
}
