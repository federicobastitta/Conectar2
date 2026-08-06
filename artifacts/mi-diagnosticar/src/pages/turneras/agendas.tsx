import { useMemo } from "react";
import { Link } from "wouter";
import { useListTurneras, type Turnera } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Hospital } from "lucide-react";
import { ahoraArgentina, atendiendoAhora, nombreProfesional } from "@/lib/agenda";

export default function AgendasActivas() {
  const { data: turneras, isLoading } = useListTurneras(
    {},
    { query: { refetchInterval: 60000 } },
  );

  const ahora = ahoraArgentina();
  const lista = turneras ?? [];

  const activas = useMemo(
    () =>
      lista
        .filter((t) => atendiendoAhora(t, ahora))
        .sort((a, b) => nombreProfesional(a).localeCompare(nombreProfesional(b), "es")),
    [lista, ahora.hora],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agendas activas</h1>
          <p className="text-muted-foreground">
            Profesionales atendiendo en este momento
          </p>
        </div>
        <Link href="/agendas/todas">
          <Button variant="outline" size="sm" data-testid="boton-todas-agendas">
            <Hospital className="w-4 h-4 mr-1.5" /> Todas las agendas
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-600" />
            Atendiendo ahora
            <span className="text-xs font-normal text-muted-foreground">
              ({ahora.hora} hs)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activas.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No hay profesionales atendiendo en este momento.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {activas.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-md border border-emerald-500/20 bg-black"
                  data-testid={`activa-${t.id}`}
                >
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{nombreProfesional(t)}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {t.especialidad?.nombre ?? t.nombre}
                      {t.sede?.nombre ? ` · ${t.sede.nombre}` : ""}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    hasta {t.horaFin}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
