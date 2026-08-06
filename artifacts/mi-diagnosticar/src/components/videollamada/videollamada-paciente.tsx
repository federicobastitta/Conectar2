import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Video, PhoneOff } from "lucide-react";
import { useGetVideollamadaPaciente } from "@workspace/api-client-react";

// Banner del portal del paciente: aparece cuando el médico inició una
// videollamada. Se actualiza solo (polling cada 10 segundos).
export function VideollamadaPacienteBanner() {
  const [enLlamada, setEnLlamada] = useState(false);
  const { data } = useGetVideollamadaPaciente({
    query: { refetchInterval: 10000, refetchIntervalInBackground: true },
  });
  const activa = data?.videollamada;

  useEffect(() => {
    if (!activa) setEnLlamada(false);
  }, [activa]);

  if (!activa) {
    return null;
  }

  if (enLlamada) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 bg-black/90">
          <div className="text-white text-sm font-medium">
            Videollamada con {activa.medicoNombre}
          </div>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setEnLlamada(false)}
            data-testid="boton-salir-videollamada"
          >
            <PhoneOff className="w-4 h-4 mr-1.5" />
            Salir
          </Button>
        </div>
        <iframe
          src={activa.url}
          title="Videollamada"
          className="flex-1 w-full"
          allow="camera; microphone; fullscreen; display-capture; autoplay"
          data-testid="iframe-videollamada-paciente"
        />
      </div>
    );
  }

  return (
    <Card className="border-2 border-emerald-500/50 bg-emerald-500/10 animate-pulse">
      <CardContent className="p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <Video className="w-6 h-6" />
          </div>
          <div>
            <div className="font-semibold">
              {activa.medicoNombre} te está llamando
            </div>
            <div className="text-sm text-muted-foreground">
              Videollamada médica en curso
            </div>
          </div>
        </div>
        <Button
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
          onClick={() => setEnLlamada(true)}
          data-testid="boton-unirse-videollamada"
        >
          <Video className="w-4 h-4 mr-2" />
          Unirme
        </Button>
      </CardContent>
    </Card>
  );
}
