import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAvisosMios,
  useSetRecepcionAviso,
  getListAvisosMiosQueryKey,
  getListDescansosActivosQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UserX, Clock, Hand, ChevronRight, Megaphone, Coffee, ShieldAlert } from "lucide-react";
import { PersonaConCartel } from "@/components/recepcion/descanso-boton";

// Avisos rápidos que el médico le manda a recepción. Se publican como aviso
// de texto libre (tipo "mensaje") y aparecen en el banner de avisos del staff.
// El aviso "No recibir más pacientes" se quitó a pedido del usuario (jul 2026).
const AVISOS_RAPIDOS = [
  {
    texto: "Estoy demorado, avisar a los pacientes que esperan",
    icon: Clock,
    color: "text-amber-500",
  },
  {
    texto: "Hacer pasar al próximo paciente",
    icon: ChevronRight,
    color: "text-emerald-500",
  },
  {
    texto: "Necesito asistencia en el consultorio",
    icon: Hand,
    color: "text-sky-500",
  },
];

// La infusión pide aclarar cuál: se elige con un toque y sale el aviso completo.
const INFUSIONES = ["Café", "Té", "Agua"] as const;

// Botón de seguridad del consultorio: un toque avisa a todo el staff que hace
// falta personal de seguridad; otro toque lo cancela cuando la situación está
// controlada. Mismo sistema de avisos (tipo "seguridad") que usa recepción.
export function SeguridadConsultorioBoton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: avisos } = useListAvisosMios({});
  const mutation = useSetRecepcionAviso();

  const activo = !!avisos?.some((a) => a.tipo === "seguridad");

  const alternar = () => {
    mutation.mutate(
      { data: { tipo: "seguridad", accion: activo ? "fin" : "inicio" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAvisosMiosQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListDescansosActivosQueryKey() });
          toast({
            title: activo ? "Aviso a seguridad cancelado" : "Aviso a seguridad enviado",
            description: activo
              ? "Avisamos que la situación está controlada."
              : "Avisamos que necesitás personal de seguridad en el consultorio.",
          });
        },
        onError: () => {
          queryClient.invalidateQueries({ queryKey: getListAvisosMiosQueryKey() });
          toast({ title: "No se pudo registrar", description: "Probá de nuevo.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <button
      type="button"
      onClick={alternar}
      disabled={mutation.isPending}
      className={`w-full text-left rounded-xl border p-6 cursor-pointer hover:shadow-md transition-all hover:-translate-y-0.5 disabled:opacity-60 ${
        activo
          ? "bg-red-600/20 text-red-700 dark:text-red-300 border-red-500/60 ring-2 ring-red-500/50 animate-pulse"
          : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
      }`}
      data-testid="boton-consulta-seguridad"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="p-3 rounded-lg bg-red-500/20">
          <ShieldAlert className="w-7 h-7" />
        </div>
        {mutation.isPending && <Loader2 className="w-5 h-5 animate-spin opacity-60" />}
      </div>
      <div className="font-semibold text-lg leading-tight">
        {activo ? "Cancelar aviso a seguridad" : "Personal de seguridad"}
      </div>
      <div className="text-sm opacity-70 mt-1 leading-snug">
        {activo
          ? "El aviso está activo: tocá para avisar que la situación está controlada"
          : "Un toque avisa que necesitás seguridad en el consultorio"}
      </div>
    </button>
  );
}

// variante "card": tarjeta grande en /medico-consulta. variante "header":
// botón chico de ícono para la barra superior (mismo cartel de avisos).
export function AvisoRecepcionBoton({ variante = "card" }: { variante?: "card" | "header" }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: avisos } = useListAvisosMios({});
  const mutation = useSetRecepcionAviso();
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");

  const avisoActivo = avisos?.find((a) => a.tipo === "mensaje") ?? null;

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: getListAvisosMiosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDescansosActivosQueryKey() });
  };

  const publicar = (mensaje: string) => {
    const limpio = mensaje.trim();
    if (!limpio) return;
    mutation.mutate(
      { data: { tipo: "mensaje", accion: "inicio", mensaje: limpio } },
      {
        onSuccess: () => {
          invalidar();
          setTexto("");
          setAbierto(false);
          toast({
            title: "Aviso enviado a recepción",
            description: `"${limpio}" quedó publicado para el equipo.`,
          });
        },
        onError: () => {
          invalidar();
          toast({ title: "No se pudo enviar", description: "Probá de nuevo.", variant: "destructive" });
        },
      },
    );
  };

  const quitar = () => {
    mutation.mutate(
      { data: { tipo: "mensaje", accion: "fin" } },
      {
        onSuccess: () => {
          invalidar();
          toast({ title: "Aviso quitado", description: "Recepción ya no ve tu aviso." });
        },
        onError: () => {
          invalidar();
          toast({ title: "No se pudo quitar", description: "Probá de nuevo.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <>
      {variante === "header" ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setAbierto(true)}
          className={
            avisoActivo
              ? "relative h-9 w-9 rounded-lg bg-amber-500/40 text-amber-100 hover:bg-amber-500/50 ring-2 ring-amber-400/70 animate-pulse"
              : "relative h-9 w-9 rounded-lg bg-orange-600 text-white hover:bg-orange-500 hover:text-white ring-1 ring-orange-400/60"
          }
          title={avisoActivo ? `Aviso activo: "${avisoActivo.mensaje}"` : "Avisar a recepción"}
          data-testid="boton-header-aviso-medico"
        >
          <PersonaConCartel className="w-4 h-4" />
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className={`w-full text-left rounded-xl border p-6 cursor-pointer hover:shadow-md transition-all hover:-translate-y-0.5 ${
            avisoActivo
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 ring-1 ring-amber-400/40"
              : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
          }`}
          data-testid="boton-consulta-aviso-recepcion"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 rounded-lg bg-amber-500/20">
              <PersonaConCartel className="w-7 h-7" />
            </div>
            <Megaphone className="w-5 h-5 opacity-40" />
          </div>
          <div className="font-semibold text-lg leading-tight">Avisar a recepción</div>
          <div className="text-sm opacity-70 mt-1 leading-snug">
            {avisoActivo ? `Aviso activo: "${avisoActivo.mensaje}"` : "Mandá un aviso rápido al equipo de recepción"}
          </div>
        </button>
      )}

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Aviso a recepción</DialogTitle>
            <DialogDescription>
              Elegí un aviso rápido o escribí el tuyo. Queda visible para todo el equipo hasta que lo quites.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {AVISOS_RAPIDOS.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.texto}
                  type="button"
                  onClick={() => publicar(a.texto)}
                  disabled={mutation.isPending}
                  className="w-full flex items-center gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent transition-colors disabled:opacity-50"
                  data-testid={`aviso-rapido-${a.texto.slice(0, 12).toLowerCase().replace(/\s/g, "-")}`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${a.color}`} />
                  <span>{a.texto}</span>
                </button>
              );
            })}
            <div className="w-full flex items-center gap-3 rounded-lg border p-3 text-sm">
              <Coffee className="w-4 h-4 shrink-0 text-orange-500" />
              <span className="shrink-0">Solicito una infusión:</span>
              <div className="flex gap-2 flex-wrap">
                {INFUSIONES.map((inf) => (
                  <button
                    key={inf}
                    type="button"
                    onClick={() => publicar(`Solicito una infusión: ${inf.toLowerCase()}`)}
                    disabled={mutation.isPending}
                    className="rounded-full border px-3 py-1 text-xs font-medium hover:bg-accent transition-colors disabled:opacity-50"
                    data-testid={`aviso-infusion-${inf.toLowerCase()}`}
                  >
                    {inf}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              maxLength={200}
              rows={3}
              placeholder="Otro aviso: escribí lo que necesitás de recepción…"
              data-testid="input-aviso-medico-texto"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            {avisoActivo && (
              <Button variant="outline" onClick={quitar} disabled={mutation.isPending} data-testid="boton-quitar-aviso-medico">
                Quitar aviso activo
              </Button>
            )}
            <Button
              onClick={() => publicar(texto)}
              disabled={!texto.trim() || mutation.isPending}
              data-testid="boton-enviar-aviso-medico"
            >
              {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Enviar aviso
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
