import { Link, useParams } from "wouter";
import { useGetPaciente, useGetHistoriaClinica } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Stethoscope, FileText, Pill, FileImage } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

export default function HistoriaClinica() {
  const { id } = useParams<{ id: string }>();
  const pacienteId = Number(id);

  const { data: paciente } = useGetPaciente(pacienteId, {
    query: { enabled: !!pacienteId }
  });

  const { data: historia, isLoading } = useGetHistoriaClinica(pacienteId, {
    query: { enabled: !!pacienteId }
  });

  if (isLoading) {
    return <div className="p-8 space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-screen w-full" /></div>;
  }

  // Combinar todos los eventos en una sola línea de tiempo
  let timeline: any[] = [];
  
  if (historia) {
    if (historia.evoluciones) {
      timeline = [...timeline, ...historia.evoluciones.map(e => ({ ...e, _type: 'evolucion' }))];
    }
    if (historia.diagnosticos) {
      timeline = [...timeline, ...historia.diagnosticos.map(d => ({ ...d, _type: 'diagnostico' }))];
    }
    if (historia.recetas) {
      timeline = [...timeline, ...historia.recetas.map(r => ({ ...r, _type: 'receta' }))];
    }
    if (historia.adjuntos) {
      timeline = [...timeline, ...historia.adjuntos.map(a => ({ ...a, _type: 'adjunto' }))];
    }
    
    // Ordenar de más reciente a más antiguo
    timeline.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/pacientes/${pacienteId}`}>
            <Button variant="outline" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Historia Clínica</h1>
            <p className="text-muted-foreground">{paciente?.apellido}, {paciente?.nombre} (DNI: {paciente?.dni})</p>
          </div>
        </div>
        <Button>
          <FileText className="w-4 h-4 mr-2" />
          Nueva Evolución
        </Button>
      </div>

      <div className="grid gap-6">
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-4 flex gap-8">
            <div className="space-y-1">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Alergias</span>
              <p className="text-sm font-medium text-destructive">{historia?.alergias?.length ? historia.alergias.join(", ") : "Ninguna conocida"}</p>
            </div>
            <div className="space-y-1 flex-1">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Antecedentes</span>
              <p className="text-sm font-medium">{historia?.antecedentes || "Sin antecedentes relevantes registrados"}</p>
            </div>
          </CardContent>
        </Card>

        <div className="relative pl-8 border-l-2 border-muted ml-4 space-y-8 pb-8">
          {timeline.length === 0 ? (
            <div className="text-muted-foreground py-8">No hay registros en la historia clínica.</div>
          ) : (
            timeline.map((item, index) => {
              const date = new Date(item.createdAt);
              
              if (item._type === 'evolucion') {
                return (
                  <div key={`evo-${item.id}`} className="relative">
                    <div className="absolute -left-[41px] bg-background p-1 rounded-full border-2 border-primary text-primary">
                      <FileText className="w-4 h-4" />
                    </div>
                    <Card>
                      <CardHeader className="pb-3 border-b bg-muted/20">
                        <div className="flex justify-between items-center">
                          <CardTitle className="text-base text-primary">Evolución Médica</CardTitle>
                          <span className="text-sm font-medium text-muted-foreground">
                            {format(date, "d 'de' MMMM, yyyy - HH:mm", { locale: es })}
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground flex justify-between">
                          <span>Dr. {item.profesional?.apellido}, {item.profesional?.nombre}</span>
                          {item.motivoConsulta && <span>Motivo: {item.motivoConsulta}</span>}
                        </div>
                      </CardHeader>
                      <CardContent className="pt-4 space-y-4 text-sm">
                        <div className="whitespace-pre-wrap">{item.texto}</div>
                        
                        {item.exploracion && (
                          <div>
                            <span className="font-semibold block mb-1">Exploración Física:</span>
                            <div className="bg-muted/30 p-3 rounded text-muted-foreground">{item.exploracion}</div>
                          </div>
                        )}
                        
                        {item.plan && (
                          <div>
                            <span className="font-semibold block mb-1">Plan / Indicaciones:</span>
                            <div className="bg-muted/30 p-3 rounded text-muted-foreground">{item.plan}</div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                );
              }
              
              if (item._type === 'diagnostico') {
                return (
                  <div key={`diag-${item.id}`} className="relative">
                    <div className="absolute -left-[41px] bg-background p-1 rounded-full border-2 border-amber-500 text-amber-500">
                      <Stethoscope className="w-4 h-4" />
                    </div>
                    <div className="bg-card border rounded-lg p-4 shadow-sm flex items-center justify-between">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">{format(date, "dd/MM/yyyy")} - Nuevo Diagnóstico</div>
                        <div className="font-medium text-lg flex items-center gap-2">
                          {item.descripcion}
                          <span className="bg-muted text-muted-foreground text-[10px] px-1.5 py-0.5 rounded uppercase">{item.tipo}</span>
                        </div>
                        {item.cie10 && <div className="text-xs text-muted-foreground mt-1">CIE-10: {item.cie10}</div>}
                      </div>
                    </div>
                  </div>
                );
              }

              if (item._type === 'receta') {
                return (
                  <div key={`rec-${item.id}`} className="relative">
                    <div className="absolute -left-[41px] bg-background p-1 rounded-full border-2 border-green-500 text-green-500">
                      <Pill className="w-4 h-4" />
                    </div>
                    <div className="bg-card border rounded-lg p-4 shadow-sm">
                      <div className="text-xs text-muted-foreground mb-1 flex justify-between">
                        <span>{format(date, "dd/MM/yyyy")} - Receta Médica</span>
                        <span>Dr. {item.profesional?.apellido}</span>
                      </div>
                      <div className="font-medium whitespace-pre-wrap">{item.medicamentos}</div>
                      {item.indicaciones && <div className="text-sm text-muted-foreground mt-2 border-t pt-2">{item.indicaciones}</div>}
                    </div>
                  </div>
                );
              }

              if (item._type === 'adjunto') {
                return (
                  <div key={`adj-${item.id}`} className="relative">
                    <div className="absolute -left-[41px] bg-background p-1 rounded-full border-2 border-blue-500 text-blue-500">
                      <FileImage className="w-4 h-4" />
                    </div>
                    <div className="bg-card border rounded-lg p-4 shadow-sm flex items-center justify-between">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">{format(date, "dd/MM/yyyy")} - Estudio Adjunto</div>
                        <div className="font-medium">{item.nombre}</div>
                        <div className="text-sm text-muted-foreground capitalize">{item.tipo}</div>
                      </div>
                      <Button variant="outline" size="sm">Ver Archivo</Button>
                    </div>
                  </div>
                );
              }

              return null;
            })
          )}
        </div>
      </div>
    </div>
  );
}
