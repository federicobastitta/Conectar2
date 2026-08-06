import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, PhoneOff, Search, Video } from "lucide-react";
import {
  useCrearVideollamada,
  useGetVideollamadaActiva,
  useFinalizarVideollamada,
  useListPacientes,
  getGetVideollamadaActivaQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function VideollamadaMedico() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busqueda, setBusqueda] = useState("");
  const [consulta, setConsulta] = useState("");

  const { data: activaData, isLoading: cargandoActiva } = useGetVideollamadaActiva();
  const activa = activaData?.videollamada;

  const { data: pacientesData, isFetching: buscando } = useListPacientes(
    { q: consulta, limit: 8, soloActivos: true },
    { query: { enabled: consulta.length >= 2 } },
  );

  const crear = useCrearVideollamada();
  const finalizar = useFinalizarVideollamada();

  const refrescarActiva = () =>
    queryClient.invalidateQueries({ queryKey: getGetVideollamadaActivaQueryKey() });

  function iniciar(pacienteId: number) {
    crear.mutate(
      { data: { pacienteId } },
      {
        onSuccess: () => {
          refrescarActiva();
          toast({
            title: "Videollamada iniciada",
            description: "El paciente la va a ver en su portal y se puede unir desde ahí.",
          });
        },
        onError: () =>
          toast({ title: "No se pudo iniciar la videollamada", variant: "destructive" }),
      },
    );
  }

  function cortar() {
    if (!activa) return;
    finalizar.mutate(
      { id: activa.id },
      {
        onSuccess: () => refrescarActiva(),
        onError: () =>
          toast({ title: "No se pudo finalizar la videollamada", variant: "destructive" }),
      },
    );
  }

  if (cargandoActiva) {
    return (
      <div className="p-6 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (activa) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold" data-testid="titulo-videollamada">
              Videollamada con {activa.pacienteNombre}
            </h1>
            <p className="text-sm text-muted-foreground">
              El paciente se une desde su portal. La sala es privada de esta consulta.
            </p>
          </div>
          <Button
            variant="destructive"
            onClick={cortar}
            disabled={finalizar.isPending}
            data-testid="boton-finalizar-videollamada"
          >
            {finalizar.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <PhoneOff className="w-4 h-4 mr-2" />
            )}
            Finalizar llamada
          </Button>
        </div>
        <div className="rounded-xl overflow-hidden border bg-black aspect-video">
          <iframe
            src={activa.url}
            title="Videollamada"
            className="w-full h-full"
            allow="camera; microphone; fullscreen; display-capture; autoplay"
            data-testid="iframe-videollamada"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="titulo-videollamada">
          <Video className="w-6 h-6" />
          Videollamada
        </h1>
        <p className="text-muted-foreground">
          Buscá al paciente y arrancá la llamada. Le aparece al instante en su portal.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setConsulta(busqueda.trim());
        }}
      >
        <Input
          placeholder="Nombre, apellido o DNI del paciente"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          data-testid="input-buscar-paciente-video"
        />
        <Button type="submit" disabled={busqueda.trim().length < 2}>
          {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </Button>
      </form>

      <div className="space-y-2">
        {consulta.length >= 2 && !buscando && (pacientesData?.data?.length ?? 0) === 0 && (
          <p className="text-sm text-muted-foreground">No se encontraron pacientes.</p>
        )}
        {pacientesData?.data?.map((p) => (
          <Card key={p.id} className="border">
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">
                  {p.apellido}, {p.nombre}
                </div>
                <div className="text-sm text-muted-foreground">DNI {p.dni}</div>
              </div>
              <Button
                onClick={() => iniciar(p.id)}
                disabled={crear.isPending}
                data-testid={`boton-llamar-${p.id}`}
              >
                <Video className="w-4 h-4 mr-2" />
                Llamar
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
