import { useEffect, useState } from "react";
import {
  useGetDicomPacsEstudios,
  useCrearDicomPacsSesionVisor,
  getDicomPacsPortalLink,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { BrainCircuit, ExternalLink, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

// El viewerUrl viene del PACS vía nuestro backend; solo aceptamos https.
function esUrlVisorValida(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function formatFecha(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return format(d, "dd/MM/yyyy", { locale: es });
}

const ESTADOS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  pending: { label: "Pendiente de análisis", variant: "outline" },
  processing: { label: "Analizando", variant: "secondary" },
  analyzed: { label: "Analizado", variant: "default" },
  signed: { label: "Firmado", variant: "default" },
  RECIBIENDO: { label: "Recibiendo imágenes", variant: "outline" },
  VERIFICANDO: { label: "Verificando", variant: "secondary" },
  VERIFICADO: { label: "Disponible", variant: "default" },
  ERROR: { label: "Error en el PACS", variant: "outline" },
  AGENDADO: { label: "Agendado", variant: "outline" },
  RECEPCIONADO: { label: "Recepcionado", variant: "secondary" },
  PENDIENTE_DE_INFORME: { label: "Pendiente de informe", variant: "secondary" },
  INFORMADO: { label: "Informado", variant: "default" },
  AUSENTE: { label: "Ausente", variant: "outline" },
};

// Acceso a los estudios de DiagnostiPACS por enlace de paciente (por DNI).
// Ya no se vinculan códigos UID a mano: pedimos al PACS un enlace fresco en
// cada apertura (instructivo DiagnostiPACS jul 2026) y el listado se consulta
// en vivo, con informes PDF y visor de imágenes incluidos.
export function DicomPacsCard({
  patientId,
  mostrarVacio = false,
}: {
  patientId: number;
  mostrarVacio?: boolean;
}) {
  const { data, isLoading, isError } = useGetDicomPacsEstudios(patientId, { query: {} });
  const sesionVisor = useCrearDicomPacsSesionVisor();
  const { toast } = useToast();
  const { user } = useAuth();
  const esStaff = user && ["admin", "medico", "recepcionista"].includes(user.rol);
  const [abriendoUid, setAbriendoUid] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [portalCargando, setPortalCargando] = useState(false);

  // Enlace fresco por paciente en cada apertura de la ficha (instructivo
  // DiagnostiPACS): el listado se incrusta acá mismo como iframe (&embed=1),
  // así el médico ve los estudios en vivo sin salir de la historia clínica.
  useEffect(() => {
    if (!esStaff) return;
    let cancelado = false;
    setPortalCargando(true);
    setPortalError(null);
    setPortalUrl(null);
    getDicomPacsPortalLink(patientId)
      .then((r) => {
        if (cancelado) return;
        if (r.url && esUrlVisorValida(r.url)) {
          setPortalUrl(r.url);
        } else {
          setPortalError("El PACS no devolvió un enlace válido al portal");
        }
      })
      .catch((err) => {
        if (cancelado) return;
        setPortalError(err instanceof Error ? err.message : "No se pudo generar el enlace");
      })
      .finally(() => {
        if (!cancelado) setPortalCargando(false);
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, Boolean(esStaff)]);

  // El mismo enlace, como página completa en otra pestaña (sin &embed=1).
  const onAbrirEnPestana = () => {
    if (portalUrl) window.open(portalUrl, "_blank", "noopener,noreferrer");
  };

  const estudios = data?.estudios ?? [];

  // Integración no configurada u oculta sin datos: no ocupamos espacio.
  if (data && !data.configurado) return null;
  if (!mostrarVacio && !isLoading && !isError && estudios.length === 0 && !esStaff) return null;

  const onAbrirVisor = (studyInstanceUid: string) => {
    setAbriendoUid(studyInstanceUid);
    sesionVisor.mutate(
      { data: { studyInstanceUid } },
      {
        onSuccess: (r) => {
          setAbriendoUid(null);
          if (r.viewerUrl && esUrlVisorValida(r.viewerUrl)) {
            window.open(r.viewerUrl, "_blank", "noopener,noreferrer");
          } else {
            toast({
              title: "Sesión creada, pero el PACS no devolvió la dirección del visor",
              description: "Falta que el PACS informe la URL del visor para sesiones contextuales.",
              variant: "destructive",
            });
          }
        },
        onError: () => {
          setAbriendoUid(null);
          toast({ title: "No se pudo abrir el visor del PACS", variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card data-testid="card-dicom-pacs">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-primary" /> DiagnostiPACS
            </CardTitle>
            <CardDescription>
              Estudios e informes del paciente en nuestro PACS, siempre actualizados.
            </CardDescription>
          </div>
          {esStaff && portalUrl && (
            <Button
              size="sm"
              variant="outline"
              onClick={onAbrirEnPestana}
              data-testid="abrir-portal-paciente-pacs"
            >
              <ExternalLink className="w-3.5 h-3.5 mr-1" />
              Abrir en otra pestaña
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {esStaff && portalCargando && (
          <p className="text-sm text-muted-foreground flex items-center gap-2" data-testid="dicom-pacs-portal-cargando">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando estudios del paciente…
          </p>
        )}
        {esStaff && portalError && (
          <p className="text-sm text-muted-foreground" data-testid="dicom-pacs-portal-error">
            No se pudieron cargar los estudios del PACS: {portalError}
          </p>
        )}
        {esStaff && portalUrl && (
          /* Full-bleed: el portal del PACS usa el ancho total de la ventana,
             aunque la página tenga una columna angosta (ej. HCE max-w-5xl). */
          <iframe
            src={`${portalUrl}${portalUrl.includes("?") ? "&" : "?"}embed=1`}
            className="relative left-1/2 -translate-x-1/2 w-[calc(100vw-2rem)] max-w-none rounded-lg border"
            style={{ height: "min(58vh, 620px)", minHeight: 380 }}
            title="Estudios del paciente en DiagnostiPACS"
            data-testid="iframe-dicom-pacs"
          />
        )}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando estudios del PACS…</p>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">No se pudieron consultar los estudios del PACS.</p>
        ) : estudios.length === 0 ? null : (
          estudios.map((e) => {
            const fecha = formatFecha(e.studyDate ?? e.createdAt);
            const estado = e.status ? (ESTADOS[e.status] ?? { label: e.status, variant: "outline" as const }) : null;
            const abriendo = abriendoUid === e.id && sesionVisor.isPending;
            return (
              <div key={e.id} className="rounded-lg border p-3" data-testid={`dicom-estudio-${e.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {e.modality && <Badge variant="secondary">{e.modality}</Badge>}
                      {estado && <Badge variant={estado.variant}>{estado.label}</Badge>}
                      <p className="font-medium text-sm">{fecha ?? "Sin fecha"}</p>
                    </div>
                    {e.impression && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{e.impression}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAbrirVisor(e.id)}
                    disabled={abriendo}
                    data-testid={`abrir-visor-${e.id}`}
                  >
                    {abriendo ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                    ) : (
                      <ExternalLink className="w-3.5 h-3.5 mr-1" />
                    )}
                    Abrir visor
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
