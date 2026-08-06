import { useState } from "react";
import { useGetPacsEstudios } from "@workspace/api-client-react";
import type { PacsEstudio } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScanLine, ExternalLink, Eye, FileText, ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

// Allowlist: solo embebemos visores servidos por Phir-it. Evita que una URL
// upstream manipulada cargue contenido de un host arbitrario en el iframe.
function esHostPhiritPermitido(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "phir-it.ar" || hostname.endsWith(".phir-it.ar"));
  } catch {
    return false;
  }
}

function formatFecha(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return format(d, "dd/MM/yyyy HH:mm", { locale: es });
}

// Etiquetas legibles para las modalidades DICOM más comunes.
const MODALIDADES: Record<string, string> = {
  US: "Ecografía",
  DX: "Radiografía",
  CR: "Radiografía",
  RX: "Radiografía",
  MR: "Resonancia",
  CT: "Tomografía",
  MG: "Mamografía",
  OT: "Otro",
  XA: "Angiografía",
  NM: "Medicina nuclear",
  PT: "PET",
};

function InformeBloque({ estudio }: { estudio: PacsEstudio }) {
  const [abierto, setAbierto] = useState(false);
  const conTexto = estudio.informes.filter((i) => i.descripcionInforme);
  if (conTexto.length === 0) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        data-testid={`toggle-informe-${estudio.id}`}
      >
        <FileText className="w-3.5 h-3.5" />
        {abierto ? "Ocultar informe" : "Ver informe"}
        {abierto ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {abierto && (
        <div className="mt-2 space-y-2">
          {conTexto.map((inf, idx) => (
            <div key={idx} className="rounded-md bg-muted/50 p-3 text-xs">
              {inf.estudioRealizado && <p className="font-semibold">{inf.estudioRealizado}</p>}
              <p className="whitespace-pre-wrap text-muted-foreground mt-1">{inf.descripcionInforme}</p>
              {inf.medico && <p className="mt-2 text-[11px] italic text-muted-foreground">Dr/a. {inf.medico}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PacsEstudiosCard({
  patientId,
  mostrarVacio = false,
}: {
  patientId: number;
  // En la pestaña dedicada mostramos la tarjeta aunque no haya estudios
  // (con un mensaje), en vez de ocultarla como en el resumen.
  mostrarVacio?: boolean;
}) {
  const { data, isLoading, isError } = useGetPacsEstudios(patientId, { query: {} });
  // Visor embebido: guardamos el estudio a mostrar (o null si cerrado).
  const [visor, setVisor] = useState<{ url: string; titulo: string } | null>(null);

  const estudios = data?.estudios ?? [];

  // Sin estudios y sin carga/error: no ocupamos espacio en la ficha.
  if (!mostrarVacio && !isLoading && !isError && estudios.length === 0) return null;

  return (
    <>
      <Card data-testid="card-pacs-estudios">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ScanLine className="w-4 h-4 text-primary" /> Estudios de imágenes (PACS)
          </CardTitle>
          <CardDescription>
            Imágenes de Phir-it. Abrí el visor interno para ver las imágenes DICOM sin salir de Conectar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando estudios de imágenes…</p>
          ) : isError ? (
            <p className="text-sm text-muted-foreground">No se pudieron consultar los estudios de imágenes.</p>
          ) : estudios.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="pacs-sin-estudios">
              El paciente no tiene estudios de imágenes en Phir-it.
            </p>
          ) : (
            estudios.map((e) => {
              const fecha = formatFecha(e.fecha);
              const modalidad = e.modalidad ? (MODALIDADES[e.modalidad] ?? e.modalidad) : null;
              const visorUrlRaw = e.linkVisualizadorOhif || e.linkVisualizador || e.linkVisualizadorComp;
              const visorUrl = visorUrlRaw && esHostPhiritPermitido(visorUrlRaw) ? visorUrlRaw : null;
              const titulo = e.descripcion || e.informes[0]?.estudioRealizado || `Estudio ${e.id}`;
              return (
                <div key={e.id} className="rounded-lg border p-3" data-testid={`pacs-estudio-${e.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {modalidad && <Badge variant="secondary">{modalidad}</Badge>}
                        <p className="font-medium text-sm">{titulo}</p>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {fecha ? `${fecha} hs` : "Sin fecha"}
                        {e.numSeries != null && e.numInstancias != null
                          ? ` · ${e.numSeries} serie(s), ${e.numInstancias} imagen(es)`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {visorUrl && (
                        <Button
                          size="sm"
                          onClick={() => setVisor({ url: visorUrl, titulo })}
                          data-testid={`ver-imagenes-${e.id}`}
                        >
                          <Eye className="w-3.5 h-3.5 mr-1" /> Ver imágenes
                        </Button>
                      )}
                      {e.linkPortal && (
                        <Button asChild size="sm" variant="outline">
                          <a href={e.linkPortal} target="_blank" rel="noopener noreferrer">
                            Portal <ExternalLink className="w-3.5 h-3.5 ml-1" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                  <InformeBloque estudio={e} />
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={visor !== null} onOpenChange={(open) => !open && setVisor(null)}>
        <DialogContent className="max-w-[95vw] w-[95vw] h-[90vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-4 py-3 border-b">
            <DialogTitle className="text-base">{visor?.titulo}</DialogTitle>
            <DialogDescription className="text-xs">
              Visor de imágenes Phir-it embebido. Si no carga, abrilo en el portal.
            </DialogDescription>
          </DialogHeader>
          {visor && (
            <iframe
              src={visor.url}
              title="Visor de imágenes PACS"
              className="w-full flex-1 border-0"
              allow="fullscreen"
              data-testid="iframe-visor-pacs"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
