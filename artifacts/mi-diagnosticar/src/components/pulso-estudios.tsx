import { useState } from "react";
import { useGetPulsoEstudios, useGetPulsoInforme } from "@workspace/api-client-react";
import type { PulsoEstudioItem } from "@workspace/api-client-react";
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
import { FileText, ExternalLink, Download, Stethoscope, MapPin, Loader2 } from "lucide-react";
import DOMPurify from "dompurify";

// La lista se lee de nuestra base (sincronizada desde Pulso). El contenido del
// informe y el PDF firmado se consultan en vivo a Pulso al abrir el detalle.

// El HTML del informe viene de un sistema externo (Pulso). Aunque Pulso lo
// sanitiza server-side, lo re-sanitizamos localmente con una allowlist estricta
// antes de renderizarlo (defensa en profundidad contra XSS).
function sanitizar(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li",
      "table", "thead", "tbody", "tr", "td", "th", "h1", "h2", "h3", "h4",
      "span", "div", "sub", "sup", "hr",
    ],
    ALLOWED_ATTR: ["style"],
  });
}

function formatFechaDia(value: string | null | undefined): string | null {
  if (!value) return null;
  const dia = value.split("T")[0];
  const [y, m, d] = dia.split("-");
  if (!y || !m || !d) return dia;
  return `${d}/${m}/${y}`;
}

// Estados de Pulso → color del badge.
function estadoVariant(estado: string | null | undefined): "default" | "secondary" | "outline" {
  const e = (estado ?? "").toLowerCase();
  if (e.includes("firmad") || e.includes("finaliz") || e.includes("complet")) return "default";
  if (e.includes("pendient") || e.includes("proces") || e.includes("borrador")) return "secondary";
  return "outline";
}

function InformeDialog({
  informeId,
  onClose,
}: {
  informeId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useGetPulsoInforme(informeId ?? "", {
    query: { enabled: informeId !== null },
  });
  const informe = data?.informe;

  const abrirPdf = async () => {
    if (!informeId) return;
    try {
      const res = await fetch(`/api/pulso/informes/${informeId}/pdf`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      // Liberamos el blob luego de un tiempo para permitir que la pestaña lo cargue.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      window.alert("No se pudo descargar el PDF del informe.");
    }
  };

  return (
    <Dialog open={informeId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" /> Informe médico
          </DialogTitle>
          <DialogDescription>
            {informe?.tipoEstudio || informe?.idLegible || "Contenido del informe (Pulso)"}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Cargando informe…
          </div>
        ) : isError || !informe ? (
          <p className="text-sm text-muted-foreground py-6">No se pudo consultar el informe en Pulso.</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2 items-center">
              {informe.firmado ? (
                <Badge>Firmado</Badge>
              ) : (
                <Badge variant="secondary">Sin firmar</Badge>
              )}
              {informe.fechaEstudio && (
                <span className="text-xs text-muted-foreground">
                  Estudio del {formatFechaDia(informe.fechaEstudio)}
                </span>
              )}
              {informe.sedeNombre && (
                <span className="text-xs text-muted-foreground">· {informe.sedeNombre}</span>
              )}
            </div>

            {informe.motivo && (
              <section>
                <h4 className="font-semibold text-xs uppercase text-muted-foreground mb-1">Motivo</h4>
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: sanitizar(informe.motivo) }}
                />
              </section>
            )}
            {informe.hallazgos && (
              <section>
                <h4 className="font-semibold text-xs uppercase text-muted-foreground mb-1">Hallazgos</h4>
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: sanitizar(informe.hallazgos) }}
                />
              </section>
            )}
            {informe.conclusion && (
              <section>
                <h4 className="font-semibold text-xs uppercase text-muted-foreground mb-1">Conclusión</h4>
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: sanitizar(informe.conclusion) }}
                />
              </section>
            )}
            {informe.firmadoPor && (
              <p className="text-xs italic text-muted-foreground">Firmado por Dr/a. {informe.firmadoPor}</p>
            )}

            <div className="flex flex-wrap gap-2 pt-2 border-t">
              <Button size="sm" onClick={abrirPdf} data-testid="descargar-pdf-informe">
                <Download className="w-3.5 h-3.5 mr-1" /> Descargar PDF
              </Button>
              {informe.enlacePacs && (
                <Button asChild size="sm" variant="outline">
                  <a href={informe.enlacePacs} target="_blank" rel="noopener noreferrer">
                    Ver imágenes (PACS) <ExternalLink className="w-3.5 h-3.5 ml-1" />
                  </a>
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PulsoEstudiosCard({
  patientId,
  mostrarVacio = false,
}: {
  patientId: number;
  // En la pestaña dedicada mostramos la tarjeta aunque no haya estudios
  // (con un mensaje), en vez de ocultarla como en el resumen.
  mostrarVacio?: boolean;
}) {
  const { data, isLoading, isError } = useGetPulsoEstudios(patientId, { query: {} });
  const [informeId, setInformeId] = useState<string | null>(null);

  const estudios: PulsoEstudioItem[] = data?.estudios ?? [];

  // Sin estudios y sin carga/error: no ocupamos espacio en la ficha.
  if (!mostrarVacio && !isLoading && !isError && estudios.length === 0) return null;

  return (
    <>
      <Card data-testid="card-pulso-estudios">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-primary" /> Estudios e informes (Pulso)
          </CardTitle>
          <CardDescription>
            Estudios informados de la clínica. Abrí el informe para ver hallazgos y conclusión.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando estudios…</p>
          ) : isError ? (
            <p className="text-sm text-muted-foreground">No se pudieron consultar los estudios.</p>
          ) : estudios.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="pulso-sin-estudios">
              El paciente no tiene estudios informados en Pulso.
            </p>
          ) : (
            estudios.map((e) => {
              const fecha = formatFechaDia(e.fechaEstudio);
              const titulo = e.tipoEstudio || e.idLegible || `Estudio ${e.id}`;
              return (
                <div key={e.id} className="rounded-lg border p-3" data-testid={`pulso-estudio-${e.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {e.modalidad && <Badge variant="secondary">{e.modalidad}</Badge>}
                        <p className="font-medium text-sm">{titulo}</p>
                        {e.estado && <Badge variant={estadoVariant(e.estado)}>{e.estado}</Badge>}
                        {e.informeFirmado && <Badge>Firmado</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-2">
                        <span>{fecha ?? "Sin fecha"}</span>
                        {e.sedeNombre && (
                          <span className="flex items-center gap-0.5">
                            <MapPin className="w-3 h-3" /> {e.sedeNombre}
                          </span>
                        )}
                        {e.medicoAsignado && <span>· Dr/a. {e.medicoAsignado}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {e.tieneInforme && e.informePulsoId && (
                        <Button
                          size="sm"
                          onClick={() => setInformeId(e.informePulsoId ?? null)}
                          data-testid={`ver-informe-${e.id}`}
                        >
                          <FileText className="w-3.5 h-3.5 mr-1" /> Ver informe
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <InformeDialog informeId={informeId} onClose={() => setInformeId(null)} />
    </>
  );
}
