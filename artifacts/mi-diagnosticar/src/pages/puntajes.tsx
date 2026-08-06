import { useState } from "react";
import { Loader2, Star, MessageSquare, ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useGetValoracionesEstadisticas,
  useGetValoracionesDeProfesional,
} from "@workspace/api-client-react";

// Vista exclusiva del desarrollador: estadísticas de puntajes que los
// pacientes dejan desde su app, por médico, con detalle de comentarios.

function Estrellas({ valor, size = 14 }: { valor: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${valor} de 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          style={{ width: size, height: size }}
          className={n <= valor ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"}
        />
      ))}
    </span>
  );
}

function fmtFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function DetalleMedico({ profesionalId, onVolver }: { profesionalId: number; onVolver: () => void }) {
  const { data, isLoading } = useGetValoracionesDeProfesional(profesionalId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onVolver} data-testid="button-volver-puntajes">
          <ChevronLeft className="h-4 w-4 mr-1" /> Volver
        </Button>
        <div>
          <h2 className="text-lg font-semibold">{data?.profesional.nombre}</h2>
          {data?.profesional.especialidad && (
            <p className="text-sm text-muted-foreground">{data.profesional.especialidad}</p>
          )}
        </div>
      </div>

      {(data?.valoraciones?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Este médico todavía no tiene calificaciones de pacientes.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data!.valoraciones.map((v) => (
            <Card key={v.id} data-testid={`card-valoracion-${v.id}`}>
              <CardContent className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{v.paciente}</span>
                  <div className="flex items-center gap-3">
                    <Estrellas valor={v.puntaje} />
                    <span className="text-xs text-muted-foreground">{fmtFecha(v.fecha)}</span>
                  </div>
                </div>
                {v.comentario && (
                  <p className="mt-2 text-sm text-muted-foreground border-l-2 border-primary/30 pl-3 italic">
                    “{v.comentario}”
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PuntajesPage() {
  const [seleccionado, setSeleccionado] = useState<number | null>(null);
  const { data: medicos, isLoading } = useGetValoracionesEstadisticas();

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      {seleccionado != null ? (
        <DetalleMedico profesionalId={seleccionado} onVolver={() => setSeleccionado(null)} />
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold">Puntajes de médicos</h1>
            <p className="text-sm text-muted-foreground">
              Calificaciones que los pacientes dejan desde su app. Hacé click en un médico para ver
              pacientes y comentarios.
            </p>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (medicos?.length ?? 0) === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                Todavía no hay valoraciones registradas.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {medicos!.map((m) => (
                <Card
                  key={m.profesionalId}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setSeleccionado(m.profesionalId)}
                  data-testid={`card-medico-${m.profesionalId}`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">{m.nombre}</CardTitle>
                      {m.especialidad && <Badge variant="secondary">{m.especialidad}</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                      <span className="flex items-center gap-2">
                        <Estrellas valor={Math.round(m.promedio ?? 0)} />
                        <span className="font-semibold">
                          {m.promedio != null ? m.promedio.toFixed(1).replace(".", ",") : "—"}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        {m.respuestas} de {m.invitaciones} calificaron
                      </span>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <MessageSquare className="h-3.5 w-3.5" /> {m.comentarios} comentarios
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      {(["5", "4", "3", "2", "1"] as const).map((n) => (
                        <span key={n} className="flex items-center gap-0.5">
                          {n}
                          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                          <span className="font-medium text-foreground">{m.distribucion?.[n] ?? 0}</span>
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
