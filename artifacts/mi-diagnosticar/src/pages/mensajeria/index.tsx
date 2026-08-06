import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useListTurneras,
  useGetTurnosAfectadosTurnera,
  useCancelarTurneraMasivo,
  useReprogramarTurno,
  useUpdatePaciente,
  useGetDisponibilidadTurnera,
} from "@workspace/api-client-react";
import {
  MessageSquare,
  CalendarX2,
  CalendarClock,
  Search,
  Send,
  Phone,
  PhoneOff,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Loader2,
} from "lucide-react";

type TurnoAfectado = {
  turnoId: number;
  fecha: string;
  horaInicio: string;
  estado: string;
  pacienteId: number;
  pacienteNombre?: string | null;
  pacienteDni?: string | null;
  telefono?: string | null;
  tieneTelefono: boolean;
};

type Preview = {
  turneraId: number;
  turneraNombre: string;
  profesionalNombre?: string | null;
  sedeNombre?: string | null;
  totalTurnos: number;
  conTelefono: number;
  sinTelefono: number;
  whaticketConfigurado: boolean;
  plantillaDefault: string;
  turnos: TurnoAfectado[];
};

type Resultado = {
  loteId: string;
  turnosCancelados: number;
  notificacionesEnviadas: number;
  notificacionesSimuladas: number;
  notificacionesFallidas: number;
  sinTelefono: number;
};

function hoyISO(offsetDias = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nombreCorto(t: TurnoAfectado): string {
  return t.pacienteNombre?.split(",").pop()?.trim() || `Paciente #${t.pacienteId}`;
}

export default function Mensajeria() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: turneras } = useListTurneras({ activa: true });

  const [turneraId, setTurneraId] = useState<string>("");
  const [fechaDesde, setFechaDesde] = useState(hoyISO());
  const [fechaHasta, setFechaHasta] = useState(hoyISO(7));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [plantilla, setPlantilla] = useState("");
  const [motivo, setMotivo] = useState("");
  const [notificar, setNotificar] = useState(true);
  const [bloquearAgenda, setBloquearAgenda] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  // Cola de pacientes sin teléfono (avisos emergentes uno por uno)
  const [colaSinTelefono, setColaSinTelefono] = useState<TurnoAfectado[]>([]);
  const [telefonoNuevo, setTelefonoNuevo] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [passwordConfirm, setPasswordConfirm] = useState("");

  // Reprogramación
  const [reproOpen, setReproOpen] = useState(false);
  const [reproFecha, setReproFecha] = useState("");
  const [reproHora, setReproHora] = useState("");
  const [reproNotificar, setReproNotificar] = useState(true);
  const [reproMotivo, setReproMotivo] = useState("");
  const [reproTelefono, setReproTelefono] = useState("");

  const previewMutation = useGetTurnosAfectadosTurnera();
  const cancelarMutation = useCancelarTurneraMasivo();
  const reprogramarMutation = useReprogramarTurno();
  const updatePaciente = useUpdatePaciente();

  const turnosSel = useMemo(
    () => (preview ? preview.turnos.filter((t) => sel.has(t.turnoId)) : []),
    [preview, sel],
  );
  const selSinTelefono = turnosSel.filter((t) => !t.tieneTelefono);
  const turnoUnico = turnosSel.length === 1 ? turnosSel[0] : null;

  const { data: slots, isLoading: loadingSlots } = useGetDisponibilidadTurnera(
    preview?.turneraId ?? 0,
    reproFecha,
    { query: { enabled: reproOpen && Boolean(preview && reproFecha) } },
  );
  const slotsLibres = (slots ?? []).filter((s) => s.disponible);

  const ejemploMensaje = useMemo(() => {
    if (!preview) return "";
    const t = turnosSel[0] ?? preview.turnos[0];
    const base = plantilla || preview.plantillaDefault;
    const vars: Record<string, string> = {
      nombre: t ? nombreCorto(t) : "Juan",
      clinica: "Diagnosticar",
      turnera: preview.turneraNombre,
      profesional: preview.profesionalNombre ?? "el profesional",
      sede: preview.sedeNombre ?? "la sede",
      fecha: t?.fecha ?? fechaDesde,
      hora: t?.horaInicio ?? "09:00",
      motivo: motivo.trim() ? ` (motivo: ${motivo.trim()})` : "",
    };
    return base.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
  }, [preview, turnosSel, plantilla, motivo, fechaDesde]);

  function buscarAfectados() {
    if (!turneraId) return;
    setResultado(null);
    previewMutation.mutate(
      { id: Number(turneraId), data: { fechaDesde, fechaHasta } },
      {
        onSuccess: (data) => {
          const p = data as unknown as Preview;
          setPreview(p);
          setSel(new Set(p.turnos.map((t) => t.turnoId)));
          if (!plantilla) setPlantilla(p.plantillaDefault);
        },
        onError: () => toast({ title: "No se pudo obtener la vista previa", variant: "destructive" }),
      },
    );
  }

  function actualizarTelefonoLocal(pacienteId: number, telefono: string) {
    setPreview((p) =>
      p
        ? {
            ...p,
            turnos: p.turnos.map((t) =>
              t.pacienteId === pacienteId ? { ...t, telefono, tieneTelefono: true } : t,
            ),
          }
        : p,
    );
  }

  // ── Flujo de cancelación ────────────────────────────────────────────────
  function iniciarCancelacion() {
    if (turnosSel.length === 0) return;
    if (notificar && selSinTelefono.length > 0) {
      setColaSinTelefono(selSinTelefono);
      setTelefonoNuevo("");
    } else {
      setConfirmOpen(true);
    }
  }

  function avanzarCola() {
    setTelefonoNuevo("");
    setColaSinTelefono((cola) => {
      const resto = cola.slice(1);
      if (resto.length === 0) setConfirmOpen(true);
      return resto;
    });
  }

  function guardarTelefonoActual() {
    const actual = colaSinTelefono[0];
    if (!actual || !telefonoNuevo.trim()) return;
    updatePaciente.mutate(
      { id: actual.pacienteId, data: { telefono: telefonoNuevo.trim() } },
      {
        onSuccess: () => {
          actualizarTelefonoLocal(actual.pacienteId, telefonoNuevo.trim());
          toast({ title: `Teléfono guardado para ${nombreCorto(actual)}` });
          avanzarCola();
        },
        onError: () => toast({ title: "No se pudo guardar el teléfono", variant: "destructive" }),
      },
    );
  }

  function confirmarCancelacion() {
    if (!preview || turnosSel.length === 0) return;
    if (!passwordConfirm.trim()) {
      toast({ title: "Ingresá tu contraseña para confirmar", variant: "destructive" });
      return;
    }
    cancelarMutation.mutate(
      {
        id: preview.turneraId,
        data: {
          password: passwordConfirm,
          fechaDesde,
          fechaHasta,
          turnoIds: turnosSel.map((t) => t.turnoId),
          motivo: motivo.trim() || undefined,
          plantilla: plantilla.trim() || undefined,
          notificar,
          bloquearAgenda,
        },
      },
      {
        onSuccess: (data) => {
          setResultado(data as unknown as Resultado);
          setPreview(null);
          setSel(new Set());
          setConfirmOpen(false);
          setPasswordConfirm("");
          toast({ title: "Turnos cancelados", description: "Los avisos por WhatsApp fueron procesados." });
        },
        onError: (error: unknown) => {
          const status = (error as { response?: { status?: number } })?.response?.status;
          if (status === 403) {
            toast({ title: "Contraseña incorrecta", description: "Verificá tu contraseña e intentá de nuevo.", variant: "destructive" });
            return;
          }
          setConfirmOpen(false);
          toast({ title: "Error al cancelar los turnos", variant: "destructive" });
        },
      },
    );
  }

  // ── Flujo de reprogramación ─────────────────────────────────────────────
  function abrirReprogramar() {
    if (!turnoUnico) return;
    setReproFecha(turnoUnico.fecha);
    setReproHora("");
    setReproNotificar(true);
    setReproMotivo("");
    setReproTelefono("");
    setReproOpen(true);
  }

  function confirmarReprogramacion() {
    if (!turnoUnico || !reproFecha || !reproHora) return;

    const ejecutar = () => {
      reprogramarMutation.mutate(
        {
          id: turnoUnico.turnoId,
          data: {
            fecha: reproFecha,
            horaInicio: reproHora,
            notificar: reproNotificar,
            motivo: reproMotivo.trim() || undefined,
          },
        },
        {
          onSuccess: () => {
            setReproOpen(false);
            toast({
              title: "Turno reprogramado",
              description: reproNotificar
                ? "Se avisó al paciente por WhatsApp."
                : "No se envió aviso al paciente.",
            });
            void queryClient.invalidateQueries();
            buscarAfectados();
          },
          onError: () =>
            toast({
              title: "No se pudo reprogramar",
              description: "Puede que el horario elegido ya esté ocupado.",
              variant: "destructive",
            }),
        },
      );
    };

    // Si quiere notificar pero el paciente no tiene teléfono y cargó uno, guardarlo primero
    if (reproNotificar && !turnoUnico.tieneTelefono && reproTelefono.trim()) {
      updatePaciente.mutate(
        { id: turnoUnico.pacienteId, data: { telefono: reproTelefono.trim() } },
        {
          onSuccess: () => {
            actualizarTelefonoLocal(turnoUnico.pacienteId, reproTelefono.trim());
            ejecutar();
          },
          onError: () => toast({ title: "No se pudo guardar el teléfono", variant: "destructive" }),
        },
      );
    } else {
      ejecutar();
    }
  }

  function toggleTodos() {
    if (!preview) return;
    setSel((s) =>
      s.size === preview.turnos.length ? new Set() : new Set(preview.turnos.map((t) => t.turnoId)),
    );
  }

  function toggleUno(id: number) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const turneraSel = turneras?.find((t) => String(t.id) === turneraId);
  const pacienteActualCola = colaSinTelefono[0] ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Mensajería</h1>
        <p className="text-muted-foreground">
          Avisos masivos por WhatsApp (Whaticket) a los pacientes de una turnera
        </p>
      </div>

      {resultado && (
        <Card className="border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="w-5 h-5" /> Proceso completado
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <span><b>{resultado.turnosCancelados}</b> turnos cancelados</span>
              <span className="text-emerald-700"><b>{resultado.notificacionesEnviadas}</b> WhatsApp enviados</span>
              {resultado.notificacionesSimuladas > 0 && (
                <span className="text-amber-700"><b>{resultado.notificacionesSimuladas}</b> simulados (Whaticket sin configurar)</span>
              )}
              {resultado.notificacionesFallidas > 0 && (
                <span className="text-red-700"><b>{resultado.notificacionesFallidas}</b> fallidos</span>
              )}
              {resultado.sinTelefono > 0 && (
                <span className="text-red-700"><b>{resultado.sinTelefono}</b> sin teléfono</span>
              )}
            </div>
            <Link href={`/notificaciones?lote=${resultado.loteId}`}>
              <Button variant="outline" size="sm">
                <ExternalLink className="w-4 h-4 mr-2" /> Ver el detalle en Notificaciones
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarX2 className="w-5 h-5 text-primary" /> Gestionar turnos de una turnera
          </CardTitle>
          <CardDescription>
            Elegí la turnera y el rango de fechas. Después seleccioná los turnos y elegí qué hacer:
            cancelar o reprogramar, con aviso por WhatsApp.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="md:col-span-2 space-y-1.5">
              <Label>Turnera</Label>
              <Select value={turneraId} onValueChange={(v) => { setTurneraId(v); setPreview(null); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar turnera..." />
                </SelectTrigger>
                <SelectContent>
                  {turneras?.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.nombre}{t.profesional ? ` — ${t.profesional.apellido}, ${t.profesional.nombre}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Desde</Label>
              <Input type="date" value={fechaDesde} onChange={(e) => { setFechaDesde(e.target.value); setPreview(null); }} />
            </div>
            <div className="space-y-1.5">
              <Label>Hasta</Label>
              <Input type="date" value={fechaHasta} onChange={(e) => { setFechaHasta(e.target.value); setPreview(null); }} />
            </div>
          </div>
          <Button onClick={buscarAfectados} disabled={!turneraId || previewMutation.isPending}>
            {previewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
            Ver turnos del rango
          </Button>
        </CardContent>
      </Card>

      {preview && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">{turnosSel.length} <span className="text-base font-normal text-muted-foreground">/ {preview.turnos.length}</span></div>
                <p className="text-sm text-muted-foreground">Turnos seleccionados</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-emerald-600 flex items-center gap-2">
                  <Phone className="w-5 h-5" /> {turnosSel.filter((t) => t.tieneTelefono).length}
                </div>
                <p className="text-sm text-muted-foreground">Con teléfono (reciben WhatsApp)</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-red-600 flex items-center gap-2">
                  <PhoneOff className="w-5 h-5" /> {selSinTelefono.length}
                </div>
                <p className="text-sm text-muted-foreground">Sin teléfono (se puede cargar antes de enviar)</p>
              </CardContent>
            </Card>
          </div>

          {!preview.whaticketConfigurado && (
            <Card className="border-amber-300 bg-amber-50/50 dark:bg-amber-950/20">
              <CardContent className="pt-4 pb-4 flex items-start gap-3 text-sm">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <b>Whaticket todavía no está conectado.</b> Los avisos se van a registrar como
                  «simulados» (queda la constancia en Notificaciones, pero no sale ningún WhatsApp real).
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base">
                    Turnos{turneraSel ? ` — ${turneraSel.nombre}` : ""}
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!turnoUnico}
                      onClick={abrirReprogramar}
                      title={turnoUnico ? "" : "Seleccioná exactamente un turno para reprogramar"}
                    >
                      <CalendarClock className="w-4 h-4 mr-1.5" /> Reprogramar
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={turnosSel.length === 0 || cancelarMutation.isPending}
                      onClick={iniciarCancelacion}
                    >
                      <CalendarX2 className="w-4 h-4 mr-1.5" /> Cancelar ({turnosSel.length})
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {preview.turnos.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No hay turnos activos en ese rango de fechas.
                  </p>
                ) : (
                  <div className="max-h-[440px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8">
                            <Checkbox
                              checked={sel.size === preview.turnos.length && preview.turnos.length > 0}
                              onCheckedChange={toggleTodos}
                              aria-label="Seleccionar todos"
                            />
                          </TableHead>
                          <TableHead>Fecha</TableHead>
                          <TableHead>Hora</TableHead>
                          <TableHead>Paciente</TableHead>
                          <TableHead>WhatsApp</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.turnos.map((t) => (
                          <TableRow
                            key={t.turnoId}
                            className={sel.has(t.turnoId) ? "bg-muted/40" : undefined}
                          >
                            <TableCell>
                              <Checkbox
                                checked={sel.has(t.turnoId)}
                                onCheckedChange={() => toggleUno(t.turnoId)}
                                aria-label={`Seleccionar turno de ${t.pacienteNombre ?? t.turnoId}`}
                              />
                            </TableCell>
                            <TableCell className="text-sm">{t.fecha}</TableCell>
                            <TableCell className="text-sm">{t.horaInicio}</TableCell>
                            <TableCell className="text-sm font-medium">
                              {t.pacienteNombre ?? "—"}
                              {t.pacienteDni && <span className="text-xs text-muted-foreground ml-1">({t.pacienteDni})</span>}
                            </TableCell>
                            <TableCell>
                              {t.tieneTelefono ? (
                                <Badge variant="outline" className="text-emerald-700 border-emerald-300">
                                  <Phone className="w-3 h-3 mr-1" /> {t.telefono}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-red-700 border-red-300">
                                  <PhoneOff className="w-3 h-3 mr-1" /> Sin teléfono
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" /> Mensaje de cancelación
                </CardTitle>
                <CardDescription>
                  Variables: {"{nombre} {clinica} {turnera} {profesional} {sede} {fecha} {hora} {motivo}"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea rows={5} value={plantilla} onChange={(e) => setPlantilla(e.target.value)} />
                <div className="space-y-1.5">
                  <Label>Motivo (opcional, se agrega al mensaje)</Label>
                  <Input placeholder="Ej: licencia del profesional" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
                </div>
                <div className="rounded-lg bg-muted p-3 text-sm">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Así lo va a recibir el paciente:</p>
                  <p className="whitespace-pre-wrap">{ejemploMensaje}</p>
                </div>
                <div className="flex flex-col gap-2 pt-1">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={notificar} onCheckedChange={(v) => setNotificar(v === true)} />
                    Enviar aviso por WhatsApp al cancelar
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={bloquearAgenda} onCheckedChange={(v) => setBloquearAgenda(v === true)} />
                    Bloquear la agenda en el rango (impide nuevas reservas)
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* Aviso emergente: paciente sin teléfono */}
      <Dialog open={Boolean(pacienteActualCola)} onOpenChange={(o) => { if (!o) setColaSinTelefono([]); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneOff className="w-5 h-5 text-red-600" />
              A {pacienteActualCola ? nombreCorto(pacienteActualCola) : ""} le falta el teléfono
            </DialogTitle>
            <DialogDescription>
              {pacienteActualCola?.pacienteNombre}
              {pacienteActualCola?.pacienteDni ? ` (DNI ${pacienteActualCola.pacienteDni})` : ""} no tiene
              teléfono cargado, así que no va a recibir el aviso por WhatsApp. Podés cargarlo ahora o continuar sin avisarle.
              {colaSinTelefono.length > 1 && ` Quedan ${colaSinTelefono.length - 1} más por revisar.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Teléfono (WhatsApp)</Label>
            <Input
              placeholder="Ej: 351 555 1234"
              value={telefonoNuevo}
              onChange={(e) => setTelefonoNuevo(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={avanzarCola}>
              Continuar sin avisar
            </Button>
            <Button onClick={guardarTelefonoActual} disabled={!telefonoNuevo.trim() || updatePaciente.isPending}>
              {updatePaciente.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Guardar teléfono
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmación de cancelación + ¿Notificar por WhatsApp? */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Confirmás la cancelación?</DialogTitle>
            <DialogDescription>
              Se van a cancelar {turnosSel.length} turnos de «{preview?.turneraNombre}». Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={notificar} onCheckedChange={(v) => setNotificar(v === true)} />
            ¿Notificar por WhatsApp? ({turnosSel.filter((t) => t.tieneTelefono).length} pacientes con teléfono)
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="password-confirmacion">Tu contraseña (código de ingreso)</Label>
            <PasswordInput
              id="password-confirmacion"
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
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setConfirmOpen(false); setPasswordConfirm(""); }}>Volver</Button>
            <Button
              variant="destructive"
              onClick={confirmarCancelacion}
              disabled={cancelarMutation.isPending || !passwordConfirm.trim()}
              data-testid="boton-confirmar-cancelacion"
            >
              {cancelarMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              Sí, cancelar{notificar ? " y avisar" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reprogramar turno */}
      <Dialog open={reproOpen} onOpenChange={setReproOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-primary" /> Reprogramar turno
            </DialogTitle>
            <DialogDescription>
              {turnoUnico
                ? `${turnoUnico.pacienteNombre ?? "Paciente"} — actualmente el ${turnoUnico.fecha} a las ${turnoUnico.horaInicio} hs`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Nueva fecha</Label>
              <Input
                type="date"
                value={reproFecha}
                onChange={(e) => { setReproFecha(e.target.value); setReproHora(""); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Horario disponible</Label>
              {loadingSlots ? (
                <p className="text-sm text-muted-foreground py-2">Buscando horarios...</p>
              ) : slotsLibres.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No hay horarios libres ese día. Probá con otra fecha.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2 max-h-36 overflow-auto">
                  {slotsLibres.map((s) => (
                    <Button
                      key={s.horaInicio}
                      size="sm"
                      variant={reproHora === s.horaInicio ? "default" : "outline"}
                      onClick={() => setReproHora(s.horaInicio)}
                    >
                      {s.horaInicio}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Motivo (opcional, se agrega al mensaje)</Label>
              <Input value={reproMotivo} onChange={(e) => setReproMotivo(e.target.value)} placeholder="Ej: pedido del profesional" />
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={reproNotificar} onCheckedChange={(v) => setReproNotificar(v === true)} />
              ¿Notificar por WhatsApp?
            </label>
            {reproNotificar && turnoUnico && !turnoUnico.tieneTelefono && (
              <div className="rounded-lg border border-amber-300 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-2">
                <p className="text-sm flex items-center gap-2">
                  <PhoneOff className="w-4 h-4 text-amber-600" />
                  Este paciente no tiene teléfono cargado. Podés cargarlo acá:
                </p>
                <Input
                  placeholder="Ej: 351 555 1234"
                  value={reproTelefono}
                  onChange={(e) => setReproTelefono(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReproOpen(false)}>Volver</Button>
            <Button
              onClick={confirmarReprogramacion}
              disabled={!reproFecha || !reproHora || reprogramarMutation.isPending || updatePaciente.isPending}
            >
              {(reprogramarMutation.isPending || updatePaciente.isPending) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Reprogramar{reproNotificar ? " y avisar" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
