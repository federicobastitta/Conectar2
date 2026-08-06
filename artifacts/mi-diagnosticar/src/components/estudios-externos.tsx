import { useListEstudiosExternos } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileImage, ExternalLink, MessageCircle, FileDown } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

function formatFechaHora(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return format(d, "dd/MM/yyyy HH:mm", { locale: es });
}

function EstadoEstudioBadge({ estado }: { estado: string }) {
  if (estado === "informado") {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Informado</Badge>;
  }
  return <Badge variant="secondary">Pendiente</Badge>;
}

function NotificacionBadge({ estado }: { estado: string | null | undefined }) {
  if (!estado) return null;
  const etiqueta =
    estado === "enviada" ? "WhatsApp enviado" : estado === "fallida" ? "WhatsApp falló" : "WhatsApp simulado";
  const clase =
    estado === "enviada"
      ? "text-emerald-700 border-emerald-300"
      : estado === "fallida"
        ? "text-red-700 border-red-300"
        : "text-blue-700 border-blue-300";
  return (
    <Badge variant="outline" className={`gap-1 ${clase}`}>
      <MessageCircle className="w-3 h-3" /> {etiqueta}
    </Badge>
  );
}

function BotonInformePdf({ estudioId }: { estudioId: number }) {
  const [descargando, setDescargando] = useState(false);

  const descargar = async () => {
    setDescargando(true);
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/integraciones/phirit/estudios/${estudioId}/informe-pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error("No se pudo descargar el informe");
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const nombre = disposition.match(/filename="([^"]+)"/)?.[1] ?? "informe.pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silencioso: el botón vuelve a estar disponible para reintentar
    } finally {
      setDescargando(false);
    }
  };

  return (
    <Button size="sm" onClick={descargar} disabled={descargando} data-testid={`button-informe-pdf-${estudioId}`}>
      <FileDown className="w-3.5 h-3.5 mr-1" />
      {descargando ? "Descargando…" : "Informe PDF"}
    </Button>
  );
}

export function EstudiosExternosCard({
  patientId,
  soloInformados = false,
  titulo = "Estudios e informes (Phir-it)",
  descripcion = "Fuente: Phir-it. Conectar refleja el estado y avisa al paciente por WhatsApp cuando el informe está disponible.",
}: {
  patientId?: number;
  soloInformados?: boolean;
  titulo?: string;
  descripcion?: string;
}) {
  const { data, isLoading } = useListEstudiosExternos(
    patientId ? { patientId } : undefined,
    { query: {} },
  );

  const estudios = (data ?? []).filter((e) => !soloInformados || e.estado === "informado");

  if (!isLoading && estudios.length === 0) return null;

  return (
    <Card data-testid="card-estudios-externos">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileImage className="w-4 h-4 text-primary" /> {titulo}
        </CardTitle>
        <CardDescription>{descripcion}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando estudios…</p>
        ) : (
          estudios.map((e) => {
            const informadoEl = formatFechaHora(e.informadoEn);
            return (
              <div
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                data-testid={`estudio-externo-${e.id}`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm">{e.descripcion || `Estudio ${e.externalId}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.estado === "informado" && informadoEl
                      ? `Informe disponible desde ${informadoEl} hs`
                      : "A la espera del informe"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <EstadoEstudioBadge estado={e.estado} />
                  <NotificacionBadge estado={e.notificacionEstado} />
                  {e.tieneInformePdf && <BotonInformePdf estudioId={e.id} />}
                  {e.estado === "informado" && e.informeUrl && (
                    <Button asChild size="sm" variant="outline">
                      <a href={e.informeUrl} target="_blank" rel="noopener noreferrer">
                        Ver informe <ExternalLink className="w-3.5 h-3.5 ml-1" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
