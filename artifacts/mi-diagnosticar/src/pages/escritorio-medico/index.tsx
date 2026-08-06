import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetConsultorioAgenda,
  useGetConsultorioWorkspace,
  useGetIngresoConsulta,
  useTomarTurnoGuardia,
  getGetConsultorioWorkspaceQueryKey,
  getGetConsultorioAgendaQueryKey,
  getGetHceHistoryQueryKey,
  getGetPatientStudyOrdersQueryKey,
  getGetPatientTimelineQueryKey,
  type Turno,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  CalendarDays,
  ClipboardList,
  FileImage,
  FileText,
  FlaskConical,
  HeartPulse,
  MapPin,
  Phone,
  Pill,
  Play,
  Send,
  ShieldCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Stethoscope,
  Timer,
  User,
  Video,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ConsultaActual, EvolucionesPrevias } from "@/pages/pacientes/consulta";
import { SeccionRecetas, SeccionDerivaciones, SeccionCertificados, SeccionOrdenes } from "@/pages/pacientes/resolucion";
import { PanelDerivacion, ListaSolicitudesPaciente } from "@/pages/pacientes/derivacion-panel";
import { DicomPacsCard } from "@/components/dicom-pacs";
import { useAuth } from "@/hooks/use-auth";
import { esAtendido, CHIP_ATENDIDO, FILA_ATENDIDO_BG, FILA_ATENDIDO_TEXT } from "@/lib/episodio";
import { DemandaEspontaneaSwitch } from "@/components/medico/demanda-espontanea-switch";
import { ConsultorioSelector } from "@/components/medico/consultorio-selector";
import { CaligrafiaSelector } from "@/components/medico/caligrafia-selector";

function hoyISO() {
  return new Date().toISOString().split("T")[0]!;
}

function edad(fechaNacimiento?: string | null) {
  if (!fechaNacimiento) return null;
  const nac = new Date(`${fechaNacimiento}T12:00:00`);
  if (isNaN(nac.getTime())) return null;
  const hoy = new Date();
  let a = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) a--;
  return a;
}

const ESTADO_COLORS: Record<string, string> = {
  pendiente: "bg-blue-100 text-blue-800",
  confirmado: "bg-indigo-100 text-indigo-800",
  arribo: "bg-amber-100 text-amber-800",
  en_sala: "bg-amber-100 text-amber-800",
  llamado: "bg-purple-100 text-purple-800", // se muestra como "En consulta"
  atendiendo: "bg-emerald-100 text-emerald-800",
  atendido: "bg-pink-200 text-pink-900",
  visto: "bg-pink-200 text-pink-900",
  pendiente_informe: "bg-pink-200 text-pink-900",
  cancelado: "bg-red-100 text-red-700",
  ausente: "bg-muted text-muted-foreground",
};

function minutosEsperando(t: Turno): number | null {
  if (!t.admitidoEn || t.atendidoEn) return null;
  if (!["arribo", "en_sala", "llamado"].includes(t.estado)) return null;
  const desde = new Date(t.admitidoEn).getTime();
  if (isNaN(desde)) return null;
  return Math.max(0, Math.round((Date.now() - desde) / 60000));
}

// ── Agenda del día (columna izquierda) ──────────────────────────────────────

function AgendaDelDia({
  fecha,
  setFecha,
  seleccionado,
  onAtender,
  onOcultar,
}: {
  fecha: string;
  setFecha: (f: string) => void;
  seleccionado: { pacienteId: number; turnoId: number | null } | null;
  onAtender: (pacienteId: number, turnoId: number) => void;
  onOcultar: () => void;
}) {
  const { data, isLoading, error, refetch } = useGetConsultorioAgenda(
    { fecha },
    { query: { refetchInterval: 30000 } },
  );
  const turnos: Turno[] = data?.turnos ?? [];
  const queryClient = useQueryClient();
  const tomar = useTomarTurnoGuardia({
    mutation: {
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: getGetConsultorioAgendaQueryKey({ fecha }) });
      },
    },
  });

  return (
    <Card className="h-full">
      <CardHeader className="pb-2 space-y-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-primary" /> Agenda del día
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={onOcultar}
            title="Ocultar agenda"
            data-testid="button-ocultar-agenda"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </CardTitle>
        <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value || hoyISO())} className="h-8" />
      </CardHeader>
      <CardContent className="p-2 space-y-1.5 max-h-[calc(100vh-220px)] overflow-y-auto">
        {isLoading ? (
          [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : error ? (
          <p className="text-sm text-muted-foreground text-center py-6">No se pudo cargar la agenda.</p>
        ) : turnos.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">Sin turnos para esta fecha.</p>
        ) : (
          turnos.map((t) => {
            const activo = seleccionado?.turnoId === t.id;
            const espera = minutosEsperando(t);
            const atendido = esAtendido(t.estado);
            const finalizado = atendido || ["cancelado", "ausente"].includes(t.estado);
            return (
              <div
                key={t.id}
                className={`rounded-lg border p-2.5 space-y-1.5 text-sm ${
                  atendido
                    ? `${FILA_ATENDIDO_BG} ${FILA_ATENDIDO_TEXT} border-pink-200 dark:border-pink-900`
                    : activo
                      ? "border-primary bg-primary/5"
                      : "bg-card"
                } ${finalizado && !atendido ? "opacity-60" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    title={t.esGuardia ? "Paciente de agenda grupal" : "Turno programado"}
                    className={`w-5 h-5 shrink-0 rounded flex items-center justify-center text-[10px] font-bold ${
                      t.esGuardia ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
                    }`}
                  >
                    {t.esGuardia ? "G" : "T"}
                  </span>
                  <span className="font-mono font-semibold text-xs">{t.horaInicio?.slice(0, 5)}</span>
                  {t.modalidad === "videoconsulta" ? (
                    t.videollamadaUrl ? (
                      <a
                        href={t.videollamadaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Unirse a la videollamada"
                        className="text-violet-700 dark:text-violet-300 hover:opacity-80"
                        data-testid={`link-videollamada-${t.id}`}
                      >
                        <Video className="w-3.5 h-3.5" />
                      </a>
                    ) : (
                      <Video className="w-3.5 h-3.5 text-muted-foreground" />
                    )
                  ) : (
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                  <Badge variant="secondary" className={`ml-auto border-0 capitalize text-[10px] ${atendido ? CHIP_ATENDIDO : (ESTADO_COLORS[t.estado] ?? "bg-muted text-muted-foreground")}`}>
                    {atendido ? "Atendido" : t.estado === "llamado" ? "En consulta" : t.estado.replace(/_/g, " ")}
                  </Badge>
                </div>
                <div className="font-medium leading-tight">
                  {t.paciente ? `${t.paciente.apellido ?? ""}, ${t.paciente.nombre ?? ""}` : `Paciente #${t.pacienteId}`}
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {t.motivoConsulta && <p className="line-clamp-1">{t.motivoConsulta}</p>}
                  <p>
                    {[t.turnera?.nombre, t.cobertura].filter(Boolean).join(" · ") || "—"}
                  </p>
                  {t.nroBono && (
                    <p
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 font-medium"
                      data-testid={`medico-bono-${t.id}`}
                    >
                      N° de Bono {t.nroBono}
                    </p>
                  )}
                  {espera != null && (
                    <p className="flex items-center gap-1 text-amber-700">
                      <Timer className="w-3 h-3" /> Esperando hace {espera} min
                    </p>
                  )}
                </div>
                {!finalizado &&
                  (t.esGuardia && t.profesionalId == null ? (
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs gap-1 bg-red-600 hover:bg-red-700 text-white"
                      disabled={tomar.isPending}
                      onClick={() => tomar.mutate({ id: t.id })}
                      data-testid={`button-tomar-${t.id}`}
                    >
                      <Play className="w-3 h-3" /> Tomar paciente
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={activo ? "secondary" : "default"}
                      className="w-full h-7 text-xs gap-1"
                      onClick={() => onAtender(t.pacienteId, t.id)}
                    >
                      <Play className="w-3 h-3" /> {activo ? "En atención" : "Iniciar atención"}
                    </Button>
                  ))}
              </div>
            );
          })
        )}
        <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => refetch()}>
          Actualizar
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Espacio de trabajo del paciente (centro + derecha + pestañas) ───────────

function EspacioPaciente({
  pacienteId,
  turnoId,
  onFinalizada,
}: {
  pacienteId: number;
  turnoId: number | null;
  onFinalizada: () => void;
}) {
  const queryClient = useQueryClient();
  const [contextoAbierto, setContextoAbierto] = useState(false);
  const [consultaAbierta, setConsultaAbierta] = useState(true);
  const { data, isLoading, error } = useGetConsultorioWorkspace(pacienteId, {
    query: { enabled: !!pacienteId },
  });
  // Aviso "sin bono": si la consulta en curso no tiene bono aceptado, el
  // médico probablemente no cobre esa atención (regla Federico 02/08/2026).
  const { data: ingreso } = useGetIngresoConsulta(turnoId ?? 0, {
    query: { enabled: !!turnoId },
  });

  const refrescar = () => {
    queryClient.invalidateQueries({ queryKey: getGetConsultorioWorkspaceQueryKey(pacienteId) });
    queryClient.invalidateQueries({ queryKey: getGetHceHistoryQueryKey(pacienteId) });
    queryClient.invalidateQueries({ queryKey: getGetPatientStudyOrdersQueryKey(pacienteId) });
    queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
    onFinalizada();
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <div className="grid lg:grid-cols-2 gap-3">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No se pudo cargar el paciente. Verificá tus permisos de acceso.
        </CardContent>
      </Card>
    );
  }

  const { paciente, record, encounters, ordenes } = data;
  const anios = edad(paciente.fechaNacimiento);
  const ordenesEnCurso = ordenes.filter((o) => !["entregado", "anulada"].includes(o.status ?? ""));

  return (
    <div className="space-y-3">
      {/* Cabecera del paciente — siempre visible */}
      <Card className="sticky top-0 z-10">
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex items-center gap-2 min-w-52">
              <User className="w-5 h-5 text-primary" />
              <div>
                <p className="font-semibold leading-tight">{paciente.apellido}, {paciente.nombre}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    paciente.dni ? `DNI ${paciente.dni}` : null,
                    anios != null ? `${anios} años` : null,
                    paciente.sexo ?? null,
                  ].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
            </div>
            {(paciente.cobertura || paciente.nroAfiliado) && (
              <span className="text-xs flex items-center gap-1 text-muted-foreground">
                <ShieldCheck className="w-3.5 h-3.5" />
                {[paciente.cobertura, paciente.nroAfiliado ? `Nº ${paciente.nroAfiliado}` : null].filter(Boolean).join(" · ")}
              </span>
            )}
            {paciente.telefono && (
              <span className="text-xs flex items-center gap-1 text-muted-foreground">
                <Phone className="w-3.5 h-3.5" /> {paciente.telefono}
              </span>
            )}
            {/* Pastilla "sin bono": consulta en curso sin bono aceptado — la
                clínica puede no abonar esta atención al médico. */}
            {turnoId != null && ingreso?.esConsulta && !(ingreso?.tokenEstado === "ACCEPTED" && ingreso?.nroBono) && (
              <Badge
                className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-800 hover:bg-amber-100"
                data-testid="badge-sin-bono"
              >
                Sin bono de consulta
              </Badge>
            )}
            <Link href={`/pacientes/${pacienteId}/hce`} className="ml-auto">
              <Button variant="outline" size="sm" className="h-7 text-xs">
                <ClipboardList className="w-3.5 h-3.5 mr-1" /> HCE completa
              </Button>
            </Link>
          </div>
          {(record?.allergies || record?.currentMedications || record?.chronicDiseases) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 pt-2 border-t text-xs">
              {record?.allergies && (
                <span className="flex items-center gap-1 text-red-700 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" /> Alergias: {record.allergies}
                </span>
              )}
              {record?.currentMedications && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Pill className="w-3.5 h-3.5" /> {record.currentMedications}
                </span>
              )}
              {record?.chronicDiseases && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <HeartPulse className="w-3.5 h-3.5" /> {record.chronicDiseases}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Secciones desplegables: contexto y consulta */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => setContextoAbierto((v) => !v)}
          data-testid="button-toggle-contexto"
        >
          {contextoAbierto ? (
            <ChevronUp className="w-3.5 h-3.5 mr-1" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 mr-1" />
          )}
          Atenciones anteriores{encounters.length > 0 ? ` (${encounters.length})` : ""} y estudios en curso
        </Button>
        <Button
          variant={consultaAbierta ? "outline" : "default"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setConsultaAbierta((v) => !v)}
          data-testid="button-toggle-consulta"
        >
          {consultaAbierta ? (
            <ChevronUp className="w-3.5 h-3.5 mr-1" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 mr-1" />
          )}
          Consulta actual
        </Button>
      </div>

      <div className="grid xl:grid-cols-12 gap-3 items-start">
        {contextoAbierto && (
        <div className="xl:col-span-5 space-y-3">
          {ordenesEnCurso.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-primary" /> Estudios en curso
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {ordenesEnCurso.slice(0, 6).map((o) => (
                  <div key={o.id} className="flex items-start justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words">{o.studyName}</span>
                    <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                      {(o.status ?? "").replace(/_/g, " ") || "—"}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" /> Atenciones anteriores{encounters.length > 0 ? ` (${encounters.length})` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 max-h-[420px] overflow-y-auto">
              <EvolucionesPrevias encounters={encounters} onCambio={refrescar} />
            </CardContent>
          </Card>
        </div>
        )}

        {/* Consulta actual a la derecha */}
        {consultaAbierta && (
          <div className={contextoAbierto ? "xl:col-span-7" : "xl:col-span-12"}>
            <ConsultaActual pacienteId={pacienteId} turnoId={turnoId} onFinalizada={refrescar} />
          </div>
        )}
      </div>


      {/* Pestañas inferiores */}
      <Tabs defaultValue="estudios">
        <TabsList className="grid w-full max-w-xl grid-cols-3 h-auto">
          <TabsTrigger value="estudios" className="text-xs">
            <FlaskConical className="w-3.5 h-3.5 mr-1 hidden sm:block" /> Estudios y órdenes
          </TabsTrigger>
          <TabsTrigger value="derivar" className="text-xs">
            <Send className="w-3.5 h-3.5 mr-1 hidden sm:block" /> Derivar
          </TabsTrigger>
          <TabsTrigger value="documentos" className="text-xs">
            <FileImage className="w-3.5 h-3.5 mr-1 hidden sm:block" /> Documentos
          </TabsTrigger>
        </TabsList>
        <TabsContent value="estudios" className="pt-3">
          <SeccionOrdenes pacienteId={pacienteId} />
        </TabsContent>
        <TabsContent value="derivar" className="pt-3 space-y-3">
          <PanelDerivacion pacienteId={pacienteId} />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Solicitudes del paciente</CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <ListaSolicitudesPaciente pacienteId={pacienteId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="documentos" className="pt-3">
          <Tabs defaultValue="recetas">
            <TabsList className="grid w-full max-w-md grid-cols-3 h-auto">
              <TabsTrigger value="recetas" className="text-xs">Recetas</TabsTrigger>
              <TabsTrigger value="derivaciones" className="text-xs">Derivaciones</TabsTrigger>
              <TabsTrigger value="certificados" className="text-xs">Certificados</TabsTrigger>
            </TabsList>
            <TabsContent value="recetas" className="pt-3"><SeccionRecetas pacienteId={pacienteId} /></TabsContent>
            <TabsContent value="derivaciones" className="pt-3"><SeccionDerivaciones pacienteId={pacienteId} /></TabsContent>
            <TabsContent value="certificados" className="pt-3"><SeccionCertificados pacienteId={pacienteId} /></TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

const SELECCION_KEY = "escritorio-medico-seleccion";

export default function EscritorioMedico() {
  const [fecha, setFecha] = useState(hoyISO());
  const [agendaVisible, setAgendaVisible] = useState(true);
  const [seleccionado, setSeleccionado] = useState<{ pacienteId: number; turnoId: number | null } | null>(() => {
    try {
      const raw = sessionStorage.getItem(SELECCION_KEY);
      return raw ? (JSON.parse(raw) as { pacienteId: number; turnoId: number | null }) : null;
    } catch {
      return null;
    }
  });
  const queryClient = useQueryClient();
  const { user } = useAuth();

  useEffect(() => {
    try {
      if (seleccionado) sessionStorage.setItem(SELECCION_KEY, JSON.stringify(seleccionado));
      else sessionStorage.removeItem(SELECCION_KEY);
    } catch {
      // best-effort
    }
  }, [seleccionado]);

  const onFinalizada = () => {
    queryClient.invalidateQueries({ queryKey: getGetConsultorioAgendaQueryKey({ fecha }) });
  };

  if (user && !["admin", "medico"].includes(user.rol)) {
    return (
      <Card>
        <CardContent className="py-16 text-center space-y-2">
          <ShieldCheck className="w-10 h-10 mx-auto text-muted-foreground/40" />
          <p className="font-medium">Acceso restringido</p>
          <p className="text-sm text-muted-foreground">
            El Escritorio Médico está disponible solo para profesionales médicos y administradores.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Stethoscope className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Escritorio Médico</h1>
            <p className="text-sm text-muted-foreground capitalize">
              {format(new Date(`${fecha}T12:00:00`), "EEEE d 'de' MMMM yyyy", { locale: es })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/firmas-pendientes">
            <Button variant="outline" size="sm" data-testid="link-firmas-pendientes">
              <ShieldCheck className="w-4 h-4 mr-1" />
              Firmas pendientes
            </Button>
          </Link>
          <ConsultorioSelector />
          <CaligrafiaSelector />
          <DemandaEspontaneaSwitch compacto />
        </div>
      </div>

      <div className="flex items-start gap-3">
        {agendaVisible ? (
          <div className="w-full lg:w-1/4 xl:w-1/6 shrink-0">
            <AgendaDelDia
              fecha={fecha}
              setFecha={setFecha}
              seleccionado={seleccionado}
              onAtender={(pacienteId, turnoId) => setSeleccionado({ pacienteId, turnoId })}
              onOcultar={() => setAgendaVisible(false)}
            />
          </div>
        ) : (
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 h-9 w-9"
            onClick={() => setAgendaVisible(true)}
            title="Mostrar agenda"
            data-testid="button-mostrar-agenda"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        )}
        <div className="flex-1 min-w-0">
          {seleccionado ? (
            <EspacioPaciente
              key={`${seleccionado.pacienteId}-${seleccionado.turnoId ?? "st"}`}
              pacienteId={seleccionado.pacienteId}
              turnoId={seleccionado.turnoId}
              onFinalizada={onFinalizada}
            />
          ) : (
            <Card>
              <CardContent className="py-16 text-center space-y-2">
                <Stethoscope className="w-10 h-10 mx-auto text-muted-foreground/40" />
                <p className="font-medium">Seleccioná un paciente de la agenda</p>
                <p className="text-sm text-muted-foreground">
                  Tocá "Iniciar atención" en un turno para ver la cabecera del paciente, registrar la consulta y emitir documentos, todo desde esta pantalla.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Imágenes del paciente (PACS) a todo el ancho de la pantalla */}
      {seleccionado && <DicomPacsCard patientId={seleccionado.pacienteId} mostrarVacio />}
    </div>
  );
}
