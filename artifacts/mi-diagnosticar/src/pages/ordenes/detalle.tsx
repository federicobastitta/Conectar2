import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getOrdenPractica,
  cambiarEstadoOrden,
  abrirSesionVisor,
  ETIQUETAS_ESTADO,
  COLORES_ESTADO,
  type EstadoOrden,
} from "@/api/ordenes-practicas";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Loader2,
  Monitor,
  FileText,
  Download,
  X,
  CheckCircle,
  Clock,
  Activity,
  ExternalLink,
} from "lucide-react";

// Enlace directo a la orden en DiagnostiPACS para médicos informantes
// (usuarios con cuenta propia en el PACS). No requiere llamada de API:
// se arma con el mismo order_id (ordenUuid) que enviamos al PACS.
const PACS_APP_URL = "https://medical-vision-ai.replit.app";
const urlOrdenPacs = (ordenUuid: string) => `${PACS_APP_URL}/orden/${encodeURIComponent(ordenUuid)}`;

const TRANSICIONES_VALIDAS: Record<EstadoOrden, EstadoOrden[]> = {
  creada: ["pendiente_validacion", "cancelada"],
  pendiente_validacion: ["validada", "rechazada", "cancelada"],
  validada: ["arribado", "rechazada", "cancelada"],
  arribado: ["en_realizacion", "cancelada"],
  en_realizacion: ["pendiente_informe", "cancelada"],
  pendiente_informe: ["informada"],
  informada: ["publicada"],
  publicada: [],
  rechazada: [],
  cancelada: [],
};

const LABELS_TRANSICION: Partial<Record<EstadoOrden, string>> = {
  pendiente_validacion: "Enviar a validación",
  validada: "Validar",
  arribado: "Marcar como llegado",
  en_realizacion: "Iniciar realización",
  pendiente_informe: "Marcar pendiente de informe",
  informada: "Marcar como informada",
  publicada: "Publicar",
  rechazada: "Rechazar",
  cancelada: "Cancelar",
};

export default function OrdenDetalle() {
  const [, params] = useRoute("/ordenes/:id");
  const [, nav] = useLocation();
  const qc = useQueryClient();
  const id = parseInt(params?.id ?? "0");

  const [cancelDialog, setCancelDialog] = useState<{ estado: EstadoOrden } | null>(null);
  const [motivoText, setMotivoText] = useState("");
  const [loadingVisor, setLoadingVisor] = useState(false);

  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["orden-practica", id],
    queryFn: () => getOrdenPractica(id),
    enabled: !!id,
  });

  const estadoMutation = useMutation({
    mutationFn: ({ estado, motivo }: { estado: EstadoOrden; motivo?: string }) =>
      cambiarEstadoOrden(id, estado, motivo),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orden-practica", id] });
      qc.invalidateQueries({ queryKey: ["ordenes-practicas"] });
      setCancelDialog(null);
      setMotivoText("");
      toast({ title: "Estado actualizado" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  async function handleVisor() {
    setLoadingVisor(true);
    try {
      const res = await abrirSesionVisor(id);
      const url = res.redeemUrl ?? res.viewerUrl;
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        toast({ title: "Sin URL de visor", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "Error al abrir visor", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoadingVisor(false);
    }
  }

  function handleTransicion(estado: EstadoOrden) {
    if (estado === "cancelada" || estado === "rechazada") {
      setCancelDialog({ estado });
    } else {
      estadoMutation.mutate({ estado });
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/70" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 text-center text-muted-foreground/70 py-20">
        Orden no encontrada
      </div>
    );
  }

  const { orden, practica, paciente, profesional, log } = data;
  const estado = orden.estado;
  const transiciones = TRANSICIONES_VALIDAS[estado] ?? [];
  const tieneInformeEjecutivo = !!orden.informeEjecutivoUrl;
  const tieneAnexos = !!orden.informeAnexosUrl;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => nav("/ordenes")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-foreground font-mono">{orden.numeroOrden}</h1>
            <Badge className={`text-xs font-medium ${COLORES_ESTADO[estado]}`}>
              {ETIQUETAS_ESTADO[estado]}
            </Badge>
            {orden.prioridad !== "normal" && (
              <Badge variant={orden.prioridad === "urgente" ? "destructive" : "secondary"} className="text-xs">
                {orden.prioridad.toUpperCase()}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{practica?.nombre ?? "Práctica"}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Columna principal */}
        <div className="col-span-2 space-y-5">

          {/* Práctica */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Práctica</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-blue-500" />
                <div>
                  <p className="font-semibold text-foreground">{practica?.nombre ?? "—"}</p>
                  <p className="text-xs text-muted-foreground/70">{practica?.especialidad}{practica?.modalidadDicom ? ` · ${practica.modalidadDicom}` : ""}</p>
                </div>
              </div>
              {orden.accessionNumber && (
                <p className="text-xs font-mono text-muted-foreground/70">Accession: {orden.accessionNumber}</p>
              )}
              {orden.pacsOrdenEnviada && (
                <p className="text-xs text-green-600 flex items-center gap-1">
                  <CheckCircle className="h-3.5 w-3.5" /> Enviada a DiagnosticPACS
                </p>
              )}
            </CardContent>
          </Card>

          {/* Datos clínicos */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Datos clínicos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground/70">Motivo clínico</Label>
                <p className="text-sm text-foreground">{orden.motivoClinico}</p>
              </div>
              {orden.diagnosticoCie10 && (
                <div>
                  <Label className="text-xs text-muted-foreground/70">Diagnóstico CIE-10</Label>
                  <p className="text-sm text-foreground font-mono">{orden.diagnosticoCie10}</p>
                </div>
              )}
              {orden.observaciones && (
                <div>
                  <Label className="text-xs text-muted-foreground/70">Observaciones</Label>
                  <p className="text-sm text-muted-foreground">{orden.observaciones}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground/70">Fecha de orden</Label>
                  <p className="text-sm">{orden.fechaOrden}</p>
                </div>
                {orden.fechaRealizacionEstimada && (
                  <div>
                    <Label className="text-xs text-muted-foreground/70">Fecha estimada</Label>
                    <p className="text-sm">{orden.fechaRealizacionEstimada}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Informe médico (cuando está disponible) */}
          {(tieneInformeEjecutivo || tieneAnexos || orden.informeConclusion) && (
            <Card className="border-green-200 bg-green-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-green-800 flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Informe médico
                </CardTitle>
                <CardDescription className="text-green-700 text-xs">
                  Generado y firmado por DiagnosticPACS
                  {orden.informeVersion ? ` · v${orden.informeVersion}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Conclusión */}
                {orden.informeConclusion && (
                  <div className="bg-card rounded-md border border-green-200 p-3">
                    <Label className="text-xs text-muted-foreground/70 uppercase tracking-wide">Conclusión</Label>
                    <p className="text-sm text-foreground mt-1 leading-relaxed">{orden.informeConclusion}</p>
                  </div>
                )}

                {/* Firma */}
                {orden.informeFirmanteNombre && (
                  <div className="text-xs text-muted-foreground border-t border-green-200 pt-3">
                    <span className="font-semibold text-muted-foreground">
                      {orden.informeFirmanteNombre}
                    </span>
                    {orden.informeFirmanteMatricula && ` · Mat. ${orden.informeFirmanteMatricula}`}
                    {orden.informeFirmanteEspecialidad && ` · ${orden.informeFirmanteEspecialidad}`}
                    {orden.informeFirmadoAt && (
                      <span className="block text-muted-foreground/70 mt-0.5">
                        Firmado: {new Date(orden.informeFirmadoAt).toLocaleString("es-AR")}
                      </span>
                    )}
                    {orden.informeChecksum && (
                      <span className="block font-mono text-muted-foreground/70 mt-0.5 text-[10px]">
                        SHA: {orden.informeChecksum.slice(0, 20)}…
                      </span>
                    )}
                  </div>
                )}

                {/* Descargas */}
                <div className="flex flex-wrap gap-3 pt-1">
                  {tieneInformeEjecutivo && (
                    <a
                      href={orden.informeEjecutivoUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 transition"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Informe ejecutivo (1 hoja A4)
                    </a>
                  )}
                  {tieneAnexos && (
                    <a
                      href={orden.informeAnexosUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 border border-green-400 text-green-700 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-100 transition"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Estudio completo · trazados y mediciones
                    </a>
                  )}
                </div>

                {tieneInformeEjecutivo && tieneAnexos && (
                  <p className="text-xs text-green-600">
                    El informe ejecutivo es el resumen clínico firmado (1 hoja A4).
                    El estudio completo incluye trazados, tablas y mediciones multipágina.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Historial de estados */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Historial
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {log?.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-3 text-sm">
                    <div className="mt-0.5 w-2 h-2 rounded-full bg-muted flex-shrink-0 mt-1.5" />
                    <div className="flex-1">
                      <span className="font-medium text-muted-foreground">
                        {entry.estadoAnterior ? `${ETIQUETAS_ESTADO[entry.estadoAnterior as EstadoOrden] ?? entry.estadoAnterior} → ` : ""}
                        {ETIQUETAS_ESTADO[entry.estadoNuevo as EstadoOrden] ?? entry.estadoNuevo}
                      </span>
                      {entry.motivo && (
                        <span className="text-muted-foreground/70 ml-2">— {entry.motivo}</span>
                      )}
                      <div className="text-xs text-muted-foreground/70">
                        {new Date(entry.createdAt).toLocaleString("es-AR")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Columna lateral */}
        <div className="space-y-4">
          {/* Acciones */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Acciones</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {practica?.generaDicom && orden.pacsOrdenEnviada && (
                <Button
                  className="w-full gap-2"
                  onClick={handleVisor}
                  disabled={loadingVisor}
                >
                  {loadingVisor ? <Loader2 className="h-4 w-4 animate-spin" /> : <Monitor className="h-4 w-4" />}
                  Abrir en DiagnosticPACS
                </Button>
              )}

              {orden.pacsOrdenEnviada && orden.ordenUuid && (
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  asChild
                  data-testid="orden-pacs-informante"
                >
                  <a href={urlOrdenPacs(orden.ordenUuid)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    Informar en el PACS (con mi usuario)
                  </a>
                </Button>
              )}

              {transiciones.filter((t) => t !== "cancelada" && t !== "rechazada").map((t) => (
                <Button
                  key={t}
                  variant="outline"
                  className="w-full"
                  disabled={estadoMutation.isPending}
                  onClick={() => handleTransicion(t)}
                >
                  {estadoMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  {LABELS_TRANSICION[t] ?? t}
                </Button>
              ))}

              {transiciones.includes("cancelada") && (
                <Button
                  variant="ghost"
                  className="w-full text-red-600 hover:bg-red-50"
                  onClick={() => handleTransicion("cancelada")}
                >
                  <X className="h-4 w-4 mr-2" /> Cancelar orden
                </Button>
              )}
              {transiciones.includes("rechazada") && (
                <Button
                  variant="ghost"
                  className="w-full text-red-600 hover:bg-red-50"
                  onClick={() => handleTransicion("rechazada")}
                >
                  <X className="h-4 w-4 mr-2" /> Rechazar orden
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Paciente */}
          {paciente && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Paciente</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <p className="font-medium text-foreground">
                  {(paciente as Record<string, string>).apellido}, {(paciente as Record<string, string>).nombre}
                </p>
                {(paciente as Record<string, string>).dni && (
                  <p className="text-muted-foreground">DNI {(paciente as Record<string, string>).dni}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Cobertura */}
          {orden.coberturaObra && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Cobertura</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <p className="font-medium">{orden.coberturaObra}</p>
                {orden.coberturaPlan && <p className="text-muted-foreground">Plan: {orden.coberturaPlan}</p>}
                {orden.coberturaNumeroAfiliado && <p className="text-muted-foreground">Nº {orden.coberturaNumeroAfiliado}</p>}
              </CardContent>
            </Card>
          )}

          {/* Klinicos */}
          {orden.klinicosEstado && (
            <Card className={orden.klinicosEstado === "TOKEN_ACCEPTED" ? "border-green-200 bg-green-50" : ""}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Klinicos</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <p className={`font-medium font-mono text-xs ${orden.klinicosEstado === "TOKEN_ACCEPTED" ? "text-green-700" : "text-amber-700"}`}>
                  {orden.klinicosEstado}
                </p>
                {orden.klinicosAuthorizationNumber && (
                  <p className="text-muted-foreground font-mono text-xs">Auth: {orden.klinicosAuthorizationNumber}</p>
                )}
                {orden.klinicosTokenMasked && (
                  <p className="text-muted-foreground/70 font-mono text-xs">Token: {orden.klinicosTokenMasked}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Profesional */}
          {profesional && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Solicitante</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="font-medium text-foreground">
                  Dr/a. {(profesional as Record<string, string>).apellido ?? ""}, {(profesional as Record<string, string>).nombre ?? ""}
                </p>
                {(profesional as Record<string, string>).matricula && (
                  <p className="text-muted-foreground">Mat. {(profesional as Record<string, string>).matricula}</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Dialog cancelar/rechazar */}
      <Dialog
        open={cancelDialog !== null}
        onOpenChange={(open) => { if (!open) { setCancelDialog(null); setMotivoText(""); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {cancelDialog?.estado === "cancelada" ? "Cancelar orden" : "Rechazar orden"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label>Motivo (obligatorio)</Label>
            <Textarea
              placeholder="Ingresá el motivo..."
              value={motivoText}
              onChange={(e) => setMotivoText(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelDialog(null)}>Atrás</Button>
            <Button
              variant="destructive"
              disabled={!motivoText.trim() || estadoMutation.isPending}
              onClick={() => {
                if (cancelDialog && motivoText.trim()) {
                  estadoMutation.mutate({ estado: cancelDialog.estado, motivo: motivoText.trim() });
                }
              }}
            >
              {estadoMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
