import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStudyOrdersPendientesFirma,
  getGetStudyOrdersPendientesFirmaQueryKey,
  useFirmarStudyOrder,
  useRechazarFirmaStudyOrder,
  useGeneratePdf,
  type OrdenFirmaPendiente,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FileText, PenLine, Undo2, ShieldCheck } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

// Página de revisión del médico prescriptor: planillas IOMA pendientes de
// aprobación. La vista previa se descarga SIN firma (marca "PENDIENTE DE
// FIRMA"); recién después de "Aprobar y firmar" el PDF sale firmado y sellado.
// El backend valida que quien firma sea el prescriptor real: acá solo se
// muestran las órdenes propias.

async function descargarPdf(downloadUrl: string, nombre: string) {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
  const res = await fetch(downloadUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`No se pudo descargar el PDF (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${nombre}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function FirmasPendientes() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetStudyOrdersPendientesFirma();
  const generar = useGeneratePdf();

  const [confirmar, setConfirmar] = useState<OrdenFirmaPendiente | null>(null);
  const [devolver, setDevolver] = useState<OrdenFirmaPendiente | null>(null);
  const [motivo, setMotivo] = useState("");
  const [descargandoId, setDescargandoId] = useState<number | null>(null);

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getGetStudyOrdersPendientesFirmaQueryKey() });

  const firmar = useFirmarStudyOrder({
    mutation: {
      onSuccess: () => {
        invalidar();
        setConfirmar(null);
        toast({ title: "Planilla firmada", description: "El PDF ya sale con tu firma y sello." });
      },
      onError: (e) => toast({ title: "No se pudo firmar", description: e.message, variant: "destructive" }),
    },
  });

  const rechazar = useRechazarFirmaStudyOrder({
    mutation: {
      onSuccess: () => {
        invalidar();
        setDevolver(null);
        setMotivo("");
        toast({ title: "Planilla devuelta para corrección" });
      },
      onError: (e) => toast({ title: "No se pudo devolver", description: e.message, variant: "destructive" }),
    },
  });

  const verPlanilla = async (item: OrdenFirmaPendiente) => {
    setDescargandoId(item.orden.id);
    try {
      const doc = await generar.mutateAsync({ data: { sourceType: "orden_estudio", sourceId: item.orden.id } });
      await descargarPdf(doc.downloadUrl, `planilla_pendiente_orden_${item.orden.id}`);
    } catch (e) {
      toast({
        title: "Error al generar la vista previa",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      });
    } finally {
      setDescargandoId(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold" data-testid="titulo-firmas-pendientes">Planillas pendientes de firma</h1>
          <p className="text-sm text-muted-foreground">
            Revisá cada planilla IOMA sin firma y aprobala solo si está todo correcto. Al firmar, el PDF
            sale con tu firma y sello, y la planilla queda inmutable: cualquier corrección genera una nueva versión.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground" data-testid="sin-pendientes">
            No tenés planillas pendientes de firma.
          </CardContent>
        </Card>
      ) : (
        data.map((item) => (
          <Card key={item.orden.id} data-testid={`pendiente-${item.orden.id}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
                <span>{item.orden.studyName}</span>
                <span className="flex items-center gap-2">
                  {(item.orden.firmaVersion ?? 1) > 1 && (
                    <Badge variant="outline">Versión {item.orden.firmaVersion}</Badge>
                  )}
                  <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    Pendiente de firma
                  </Badge>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm text-muted-foreground">
                <p>
                  Paciente: <span className="text-foreground font-medium">{item.pacienteNombre}</span>
                  {item.pacienteDni ? ` — DNI ${item.pacienteDni}` : ""}
                </p>
                <p>
                  Emitida el {format(new Date(item.orden.createdAt ?? Date.now()), "d 'de' MMMM 'de' yyyy, HH:mm", { locale: es })} hs
                  {item.orden.priority === "urgente" ? " · URGENTE" : ""}
                </p>
                {item.orden.clinicalJustification && <p>Justificación: {item.orden.clinicalJustification}</p>}
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => verPlanilla(item)}
                  disabled={descargandoId === item.orden.id}
                  data-testid={`ver-planilla-${item.orden.id}`}
                >
                  <FileText className="h-4 w-4 mr-1" />
                  {descargandoId === item.orden.id ? "Generando…" : "Ver planilla (sin firma)"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => setConfirmar(item)}
                  data-testid={`aprobar-${item.orden.id}`}
                >
                  <PenLine className="h-4 w-4 mr-1" />
                  Aprobar y firmar
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setDevolver(item); setMotivo(""); }}
                  data-testid={`devolver-${item.orden.id}`}
                >
                  <Undo2 className="h-4 w-4 mr-1" />
                  Devolver para corrección
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {/* Confirmación de firma */}
      <Dialog open={confirmar != null} onOpenChange={(o) => !o && setConfirmar(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aprobar y firmar la planilla</DialogTitle>
            <DialogDescription>
              Vas a firmar la planilla de <strong>{confirmar?.orden.studyName}</strong> para{" "}
              <strong>{confirmar?.pacienteNombre}</strong>. La firma queda registrada de forma
              inmutable con fecha, hora y usuario. Después de firmar, la planilla no se puede modificar.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmar(null)} disabled={firmar.isPending}>
              Cancelar
            </Button>
            <Button
              onClick={() => confirmar && firmar.mutate({ id: confirmar.orden.id })}
              disabled={firmar.isPending}
              data-testid="confirmar-firma"
            >
              {firmar.isPending ? "Firmando…" : "Sí, firmar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Devolución para corrección */}
      <Dialog open={devolver != null} onOpenChange={(o) => !o && setDevolver(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Devolver para corrección</DialogTitle>
            <DialogDescription>
              La planilla de <strong>{devolver?.orden.studyName}</strong> queda rechazada y habrá que
              emitir una versión corregida, que también requerirá tu aprobación.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="motivo-devolucion">Motivo (obligatorio)</Label>
            <Textarea
              id="motivo-devolucion"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ej.: falta el resumen de historia clínica actualizado"
              data-testid="motivo-devolucion"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDevolver(null)} disabled={rechazar.isPending}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => devolver && rechazar.mutate({ id: devolver.orden.id, data: { motivo: motivo.trim() } })}
              disabled={rechazar.isPending || motivo.trim().length < 5}
              data-testid="confirmar-devolucion"
            >
              {rechazar.isPending ? "Devolviendo…" : "Devolver"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
