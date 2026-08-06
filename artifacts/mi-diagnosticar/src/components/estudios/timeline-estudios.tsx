import { useListEstudiosExternos } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, ExternalLink, Clock, CheckCircle2, AlertCircle, XCircle, Image } from "lucide-react";

const ESTADO_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  informado: {
    label: "Informado",
    color: "bg-emerald-100 text-emerald-800 border-emerald-200",
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  realizado: {
    label: "Realizado",
    color: "bg-sky-100 text-sky-800 border-sky-200",
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  pendiente: {
    label: "Pendiente",
    color: "bg-amber-100 text-amber-800 border-amber-200",
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  en_proceso: {
    label: "En proceso",
    color: "bg-blue-100 text-blue-800 border-blue-200",
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  error: {
    label: "Error",
    color: "bg-red-100 text-red-800 border-red-200",
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
};

function estadoMeta(estado: string) {
  return ESTADO_META[estado.toLowerCase()] ?? {
    label: estado,
    color: "bg-muted text-muted-foreground border-border",
    icon: <AlertCircle className="w-3.5 h-3.5" />,
  };
}

function formatFecha(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(raw));
  } catch {
    return raw;
  }
}

export function TimelineEstudios({
  pacienteId,
  limit = 5,
}: {
  pacienteId: number;
  limit?: number;
}) {
  const { data, isLoading } = useListEstudiosExternos(
    { patientId: pacienteId },
    { query: { enabled: pacienteId > 0, staleTime: 60_000 } },
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }

  const estudios = data ?? [];
  if (estudios.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3 text-center">
        Sin estudios registrados
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {estudios.map((e) => {
        const meta = estadoMeta(e.estado);
        const fecha = formatFecha(e.informadoEn ?? e.estadoCambiadoEn ?? e.createdAt);
        return (
          <div
            key={e.id}
            className="flex items-start gap-3 p-2.5 rounded-lg border bg-card hover:bg-muted/40 transition-colors"
          >
            <div className="mt-0.5 shrink-0">
              <Image className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate">
                  {e.descripcion ?? "Estudio"}
                </span>
                <Badge
                  variant="outline"
                  className={`text-[11px] px-1.5 py-0 flex items-center gap-1 ${meta.color}`}
                >
                  {meta.icon}
                  {meta.label}
                </Badge>
                {e.origen && (
                  <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                    {e.origen}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground">{fecha}</span>
                {e.tieneInformePdf && (
                  <span className="text-xs text-emerald-700 flex items-center gap-0.5">
                    <FileText className="w-3 h-3" /> PDF disponible
                  </span>
                )}
              </div>
            </div>
            {e.informeUrl && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs shrink-0"
                onClick={() => window.open(e.informeUrl!, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink className="w-3 h-3 mr-1" /> Ver
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
