import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetColaSalaEspera,
  getGetColaSalaEsperaQueryKey,
  useLlamarTurno,
  useAtenderTurno,
  useMarcarNoPresentado,
  useDevolverTurnoASala,
  useDescolorearTurno,
  obtenerLinkVideollamadaTurno,
  type ColaItem,
} from "@workspace/api-client-react";
import { marcaColorFondo, marcaColorLabel } from "@/lib/marca-color";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "wouter";
import { LlamadoOverlay, type DatosLlamado } from "@/components/turnos/llamado-overlay";
import { CHECK_IN_META } from "@/lib/episodio";
import { Bell, Users, Clock, CheckCircle2, MapPin, UserX, Stethoscope, MonitorPlay, AlertTriangle, Undo2, Video } from "lucide-react";

const ESTADO_CONFIG: Record<string, { color: string; label: string }> = {
  arribo: { color: "bg-amber-100 text-amber-700 border-amber-200", label: "En espera" },
  en_sala: { color: "bg-amber-100 text-amber-700 border-amber-200", label: "En espera" },
  llamado: { color: "bg-blue-100 text-blue-700 border-blue-200", label: "En consulta" },
  en_atencion: { color: "bg-purple-100 text-purple-700 border-purple-200", label: "En atención" },
};

const EN_ESPERA = ["arribo", "en_sala"];

// Llamar ya no cambia el estado del turno: un paciente cuenta como "llamado"
// si tiene llamadoEn dentro de esta ventana (mismo criterio que la pantalla TV).
const VENTANA_LLAMADO_MS = 15 * 60 * 1000;
const fueLlamado = (it: ColaItem) =>
  it.estado === "llamado" ||
  (it.llamadoEn != null && Date.now() - new Date(it.llamadoEn).getTime() <= VENTANA_LLAMADO_MS);

// Umbral único: una turnera se considera demorada cuando la espera estimada
// del último paciente en su cola supera este valor (en minutos).
const UMBRAL_DEMORA_MINUTOS = 45;

export default function SalaEspera() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [turneraFiltro, setTurneraFiltro] = useState("todas");

  const puedeOperar = user?.rol === "admin" || user?.rol === "recepcionista";

  const { data: cola, isLoading } = useGetColaSalaEspera(undefined, {
    query: { refetchInterval: 10_000 },
  });

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getGetColaSalaEsperaQueryKey(undefined) });

  const onError = (err: unknown) => {
    const msg =
      err && typeof err === "object" && "error" in err
        ? String((err as { error: unknown }).error)
        : "No se pudo completar la acción";
    toast({ title: "Error", description: msg, variant: "destructive" });
  };

  // Efecto visual estilo TV al confirmar un llamado (se cierra solo).
  const [llamadoVisual, setLlamadoVisual] = useState<DatosLlamado | null>(null);

  const llamar = useLlamarTurno({
    mutation: {
      onSuccess: (_data, vars) => {
        invalidar();
        const it = (cola ?? []).find((i) => i.turnoId === vars.id);
        if (it) {
          setLlamadoVisual({
            paciente: `${it.pacienteApellido}, ${it.pacienteNombre}`,
            profesional: it.profesionalNombre,
            turnera: it.turneraNombre,
          });
        }
      },
      onError,
    },
  });
  const atender = useAtenderTurno({ mutation: { onSuccess: invalidar, onError } });
  const noPresentado = useMarcarNoPresentado({ mutation: { onSuccess: invalidar, onError } });
  // Destrabar a un paciente que quedó EN CONSULTA (el médico lo llamó por
  // error o se olvidó de finalizar): vuelve a la sala de espera y queda
  // disponible para cualquier médico. Queda auditado quién lo hizo.
  const devolverASala = useDevolverTurnoASala({
    mutation: {
      onSuccess: () => {
        toast({ title: "Paciente devuelto a la sala de espera", description: "Quedó disponible para ser llamado de nuevo." });
        invalidar();
      },
      onError,
    },
  });
  const descolorear = useDescolorearTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Marca de color quitada" });
        invalidar();
      },
      onError,
    },
  });
  const esAdmin = user?.rol === "admin";
  const ocupado = llamar.isPending || atender.isPending || noPresentado.isPending || devolverASala.isPending;

  const items: ColaItem[] = useMemo(() => cola ?? [], [cola]);

  const turneras = useMemo(() => {
    const map = new Map<number, string>();
    for (const it of items) map.set(it.turneraId, it.turneraNombre);
    return Array.from(map.entries());
  }, [items]);

  const filtrada = useMemo(
    () =>
      items
        .filter((it) => turneraFiltro === "todas" || String(it.turneraId) === turneraFiltro)
        .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio)),
    [items, turneraFiltro],
  );

  // Demora por turnera: máxima espera estimada entre los pacientes en espera.
  // Solo se consideran items con estimación disponible (sin datos, no hay alerta).
  const demoraPorTurnera = useMemo(() => {
    const map = new Map<number, number>();
    for (const it of items) {
      if (!EN_ESPERA.includes(it.estado) || it.esperaEstimadaMinutos == null) continue;
      const prev = map.get(it.turneraId) ?? 0;
      if (it.esperaEstimadaMinutos > prev) map.set(it.turneraId, it.esperaEstimadaMinutos);
    }
    return map;
  }, [items]);

  const turnerasDemoradas = useMemo(
    () =>
      turneras
        .map(([id, nombre]) => ({ id, nombre, demora: demoraPorTurnera.get(id) ?? 0 }))
        .filter((t) => t.demora > UMBRAL_DEMORA_MINUTOS)
        .sort((a, b) => b.demora - a.demora),
    [turneras, demoraPorTurnera],
  );

  const enEspera = items.filter((it) => EN_ESPERA.includes(it.estado) && !fueLlamado(it)).length;
  const llamados = items.filter((it) => it.estado !== "en_atencion" && fueLlamado(it)).length;
  const enAtencion = items.filter((it) => it.estado === "en_atencion").length;

  const siguiente = filtrada.find((it) => EN_ESPERA.includes(it.estado) && !fueLlamado(it));

  return (
    <div className="space-y-6">
      <LlamadoOverlay llamado={llamadoVisual} onCerrar={() => setLlamadoVisual(null)} />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sala de Espera</h1>
          <p className="text-muted-foreground">Cola en tiempo real — llamador de pacientes</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" className="gap-2" asChild>
            <a
              href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/pantalla-sala${
                turneraFiltro !== "todas" ? `?turneraId=${turneraFiltro}` : ""
              }`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MonitorPlay className="w-4 h-4" />
              Pantalla TV
            </a>
          </Button>
          {puedeOperar && (
            <Button
              onClick={() => siguiente && llamar.mutate({ id: siguiente.turnoId })}
              className="gap-2"
              disabled={!siguiente || ocupado}
            >
              <Bell className="w-4 h-4" />
              Llamar siguiente
            </Button>
          )}
        </div>
      </div>

      {turnerasDemoradas.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-red-700">
            <AlertTriangle className="w-4 h-4" />
            {turnerasDemoradas.length === 1
              ? "Turnera con demora acumulada"
              : "Turneras con demora acumulada"}
          </div>
          <div className="flex flex-wrap gap-2">
            {turnerasDemoradas.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTurneraFiltro(String(t.id))}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1 rounded-full border border-red-300 bg-card text-red-700 hover:bg-red-100 transition-colors"
              >
                {t.nombre}
                <span className="font-bold">Demorada ~{t.demora} min</span>
              </button>
            ))}
          </div>
          <p className="text-sm text-red-600">
            La espera estimada del último paciente en la cola supera los {UMBRAL_DEMORA_MINUTOS}{" "}
            minutos. Considerá avisar a los pacientes.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold text-amber-600">{enEspera}</div>
            <div className="flex items-center gap-1 mt-1">
              <Users className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">En espera</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold text-blue-600">{llamados}</div>
            <div className="flex items-center gap-1 mt-1">
              <Bell className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Llamados</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold text-purple-600">{enAtencion}</div>
            <div className="flex items-center gap-1 mt-1">
              <Stethoscope className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">En atención</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle>Cola de pacientes</CardTitle>
            <Select value={turneraFiltro} onValueChange={setTurneraFiltro}>
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder="Filtrar por turnera" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas las turneras</SelectItem>
                {turneras.map(([id, nombre]) => {
                  const demora = demoraPorTurnera.get(id) ?? 0;
                  const demorada = demora > UMBRAL_DEMORA_MINUTOS;
                  return (
                    <SelectItem key={id} value={String(id)}>
                      {nombre}
                      {demorada ? ` — Demorada ~${demora} min` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : filtrada.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground space-y-2">
              <p>No hay pacientes en la cola</p>
              {puedeOperar && (
                <p className="text-sm">
                  Los pacientes aparecen aquí luego de ser admitidos desde{" "}
                  <Link href="/admision" className="text-primary underline">
                    Admisión
                  </Link>
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filtrada.map((pac, idx) => {
                const llamado = pac.estado !== "en_atencion" && fueLlamado(pac);
                const cfg = llamado
                  ? ESTADO_CONFIG.llamado
                  : pac.checkInPrevio
                    ? {
                        color: `${CHECK_IN_META.bg} ${CHECK_IN_META.color} ${CHECK_IN_META.border}`,
                        label: CHECK_IN_META.label,
                      }
                    : ESTADO_CONFIG[pac.estado] ?? {
                        color: "bg-muted text-muted-foreground border-border",
                        label: pac.estado,
                      };
                return (
                  <div
                    key={pac.turnoId}
                    className={`flex items-center gap-4 p-4 rounded-lg border transition-all ${
                      marcaColorFondo(pac.marcaColor) ??
                      (llamado
                        ? "border-blue-300 bg-blue-50 shadow-sm"
                        : pac.estado === "en_atencion"
                          ? "opacity-60 bg-muted/30"
                          : "bg-card")
                    }`}
                    title={marcaColorLabel(pac.marcaColor) ?? undefined}
                  >
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center font-bold text-lg shrink-0">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold flex items-center gap-2 flex-wrap">
                        <span>{pac.pacienteApellido}, {pac.pacienteNombre}</span>
                        {pac.numeroHc && (
                          <span className="text-xs text-muted-foreground font-normal">
                            HC {pac.numeroHc}
                          </span>
                        )}
                        {pac.modalidad === "videoconsulta" && (
                          <span
                            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-200"
                            data-testid={`badge-video-${pac.turnoId}`}
                          >
                            <Video className="w-3 h-3" />
                            Videollamada
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground flex flex-wrap gap-x-3">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Turno {pac.horaInicio}
                        </span>
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" /> {pac.turneraNombre}
                          {pac.profesionalNombre ? ` — ${pac.profesionalNombre}` : ""}
                        </span>
                        {pac.modalidad === "videoconsulta" && (
                          <span
                            className="flex items-center gap-1 text-violet-700 dark:text-violet-300 font-medium"
                            data-testid={`videollamada-badge-${pac.turnoId}`}
                          >
                            <MonitorPlay className="w-3 h-3" /> Videollamada
                          </span>
                        )}
                        {(pac.practicas ?? []).length > 0 && (
                          <span
                            className="flex items-center gap-1 text-sky-700 dark:text-sky-400"
                            data-testid={`estudios-turno-${pac.turnoId}`}
                          >
                            {(pac.practicas ?? []).join(" + ")}
                          </span>
                        )}
                        {pac.esperaMinutos != null && (
                          <span className="flex items-center gap-1 text-amber-600">
                            Esperando {pac.esperaMinutos} min
                          </span>
                        )}
                        {pac.esperaEstimadaMinutos != null && (
                          <span className="flex items-center gap-1 text-sky-600">
                            ~{pac.esperaEstimadaMinutos} min estimados
                          </span>
                        )}
                        {pac.admitidoPor && (
                          <span className="flex items-center gap-1">
                            Recepcionado por {pac.admitidoPor}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.color}`}>
                        {cfg.label}
                      </span>
                      {puedeOperar && pac.modalidad === "videoconsulta" && (llamado || pac.estado === "en_atencion") && (
                        <Button
                          size="sm"
                          variant="default"
                          data-testid={`entrar-videollamada-${pac.turnoId}`}
                          onClick={async () => {
                            try {
                              const { url } = await obtenerLinkVideollamadaTurno(pac.turnoId);
                              window.open(url, "_blank", "noopener");
                            } catch {
                              toast({
                                title: "No se pudo abrir la videollamada",
                                description: "Reintentá en unos segundos.",
                                variant: "destructive",
                              });
                            }
                          }}
                        >
                          <MonitorPlay className="w-3.5 h-3.5 mr-1" /> Entrar a videollamada
                        </Button>
                      )}
                      {pac.marcaColor && esAdmin && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={descolorear.isPending}
                          onClick={() => descolorear.mutate({ id: pac.turnoId })}
                          data-testid={`descolorear-${pac.turnoId}`}
                        >
                          Descolorear paciente
                        </Button>
                      )}
                      {puedeOperar && EN_ESPERA.includes(pac.estado) && !llamado && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={ocupado}
                            onClick={() => llamar.mutate({ id: pac.turnoId })}
                          >
                            <Bell className="w-3.5 h-3.5 mr-1" /> Llamar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={ocupado}
                            onClick={() => noPresentado.mutate({ id: pac.turnoId })}
                          >
                            <UserX className="w-3.5 h-3.5 mr-1" /> Ausente
                          </Button>
                        </>
                      )}
                      {puedeOperar && pac.estado === "en_atencion" && (
                        <Link href={`/pacientes/${pac.pacienteId}/consulta?turno=${pac.turnoId}`}>
                          <Button size="sm" variant="default">
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Abrir consulta
                          </Button>
                        </Link>
                      )}
                      {/* Link Jitsi: visible para staff/médico cuando el turno está "en espera" o "llamado" */}
                      {pac.modalidad === "videoconsulta" && pac.videollamadaUrl && (
                        <a
                          href={pac.videollamadaUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`link-jitsi-${pac.turnoId}`}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/40"
                          >
                            <Video className="w-3.5 h-3.5" /> Unirse
                          </Button>
                        </a>
                      )}
                      {puedeOperar && llamado && (
                        <>
                          {/* El paciente llamado por un médico queda EN CONSULTA:
                              staff no puede volver a llamarlo hasta que ese médico
                              finalice la consulta. */}
                          {pac.llamadoPorProfesionalId == null && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={ocupado}
                              onClick={() => llamar.mutate({ id: pac.turnoId })}
                            >
                              <Bell className="w-3.5 h-3.5 mr-1" /> Llamar de nuevo
                            </Button>
                          )}
                          {/* Destrabar: si el médico lo llamó por error o se olvidó
                              de finalizar, recepción lo devuelve a la sala de espera
                              con un clic (queda auditado). */}
                          {pac.estado === "llamado" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={ocupado}
                              onClick={() => devolverASala.mutate({ id: pac.turnoId })}
                              data-testid={`devolver-sala-${pac.turnoId}`}
                            >
                              <Undo2 className="w-3.5 h-3.5 mr-1" /> Devolver a sala de espera
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={ocupado}
                            onClick={() => atender.mutate({ id: pac.turnoId })}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Pasó a consultorio
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={ocupado}
                            onClick={() => noPresentado.mutate({ id: pac.turnoId })}
                          >
                            <UserX className="w-3.5 h-3.5 mr-1" /> Ausente
                          </Button>
                        </>
                      )}
                      {/* El médico también puede deshacer SU propio llamado hecho
                          por error: vuelve el paciente a la sala sin computar
                          atención (el backend valida que sea su llamado). */}
                      {user?.rol === "medico" &&
                        pac.estado === "llamado" &&
                        pac.llamadoPorProfesionalId != null &&
                        pac.llamadoPorProfesionalId === user?.profesionalId && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={ocupado}
                          onClick={() => devolverASala.mutate({ id: pac.turnoId })}
                          data-testid={`devolver-sala-medico-${pac.turnoId}`}
                        >
                          <Undo2 className="w-3.5 h-3.5 mr-1" /> Volver a la sala
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
