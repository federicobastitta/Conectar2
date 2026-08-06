import { BookOpen } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { AgentChat } from "@/components/agentes/AgentChat";

// Asistente IA de consultas médicas: página propia para el médico de
// consulta, con el chat del agente médico abierto de entrada.
export default function AsistenteMedico() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="titulo-asistente-medico">
          <BookOpen className="w-6 h-6 text-primary" /> Consultas médicas — Asistente IA
        </h1>
        <p className="text-muted-foreground">
          {format(new Date(), "EEEE d 'de' MMMM, yyyy", { locale: es })}
        </p>
      </div>
      <div className="rounded-xl border bg-muted/30 p-6 text-sm text-muted-foreground max-w-lg space-y-2">
        <p>
          El asistente médico te ayuda durante la consulta: dudas clínicas, interacciones medicamentosas,
          criterios diagnósticos, dosis y preparaciones de estudios.
        </p>
        <p>
          Es una herramienta de apoyo — la decisión clínica siempre es tuya. El chat está abierto acá abajo
          a la derecha.
        </p>
      </div>
      <AgentChat agenteForzado="medico" inicialAbierto />
    </div>
  );
}
