import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDescansosActivos,
  useConfirmarAvisoMedico,
  getListDescansosActivosQueryKey,
  type DescansoActivo,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { DoorOpen, Hand, Users, RefreshCw, MessageSquare, ShieldAlert, Check } from "lucide-react";

// Banner a lo ancho de la página: avisa a todo el staff cuando un compañero
// salió de su puesto, pidió asistencia, tiene mucha gente, necesita reemplazo
// o dejó un mensaje. Se actualiza solo.
// - Asistencia: cinta que corre constante.
// - Salió de su puesto (descanso): cinta que pasa una sola vez y desaparece.
// - El resto: banner fijo.

// Un color bien distinto por tipo de aviso, legible en tema claro y oscuro:
// amarillo=salió del puesto, rojo=asistencia, naranja=mucha gente,
// violeta=reemplazo, celeste=mensaje, bordó intenso=seguridad.
const ESTILOS: Record<string, string> = {
  descanso: "bg-yellow-200 text-yellow-900 border-yellow-400 dark:bg-yellow-500/20 dark:text-yellow-200 dark:border-yellow-500/40",
  asistencia: "bg-red-200 text-red-900 border-red-400 dark:bg-red-500/20 dark:text-red-200 dark:border-red-500/40",
  mucha_gente: "bg-orange-300 text-orange-950 border-orange-500 dark:bg-orange-500/20 dark:text-orange-200 dark:border-orange-500/40",
  reemplazo: "bg-violet-200 text-violet-900 border-violet-400 dark:bg-violet-500/20 dark:text-violet-200 dark:border-violet-500/40",
  mensaje: "bg-sky-200 text-sky-900 border-sky-400 dark:bg-sky-500/20 dark:text-sky-200 dark:border-sky-500/40",
  seguridad: "bg-red-600 text-white border-red-700 dark:bg-red-600/40 dark:text-red-100 dark:border-red-500/60 animate-pulse",
};

function Icono({ tipo }: { tipo: string }) {
  const cls = "w-4 h-4 shrink-0";
  if (tipo === "asistencia") return <Hand className={cls} />;
  if (tipo === "mucha_gente") return <Users className={cls} />;
  if (tipo === "reemplazo") return <RefreshCw className={cls} />;
  if (tipo === "mensaje") return <MessageSquare className={cls} />;
  if (tipo === "seguridad") return <ShieldAlert className={cls} />;
  return <DoorOpen className={cls} />;
}

function textoAviso(a: DescansoActivo): string {
  switch (a.tipo) {
    case "asistencia":
      return `${a.nombre} solicita asistencia en su puesto de trabajo`;
    case "mucha_gente":
      return `${a.nombre} tiene mucha gente en su puesto`;
    case "reemplazo":
      return `${a.nombre} necesita un reemplazo temporal en su puesto`;
    case "mensaje":
      return `${a.nombre}: ${a.mensaje ?? ""}`;
    case "seguridad":
      return `SEGURIDAD: ${a.nombre} necesita seguridad en su puesto`;
    default:
      return `${a.nombre} salió de su puesto de trabajo`;
  }
}

function FilaMarquee({
  aviso,
  unaVez,
  onTermino,
}: {
  aviso: DescansoActivo;
  unaVez?: boolean;
  onTermino?: () => void;
}) {
  return (
    <div className={`overflow-hidden py-1.5 text-sm font-semibold border-b ${ESTILOS[aviso.tipo] ?? ESTILOS["descanso"]}`}>
      <div
        className={unaVez ? "aviso-marquee aviso-marquee-una-vez" : "aviso-marquee"}
        onAnimationEnd={unaVez ? onTermino : undefined}
      >
        <span className="inline-flex items-center gap-2 px-4">
          <Icono tipo={aviso.tipo} />
          {textoAviso(aviso)}
        </span>
      </div>
    </div>
  );
}

export function AvisosPuestoBanner() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const esStaff = user && (user.rol === "admin" || user.rol === "recepcionista");
  const { data: avisos } = useListDescansosActivos({
    query: { enabled: !!esStaff, refetchInterval: 15_000 },
  });
  const confirmar = useConfirmarAvisoMedico({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListDescansosActivosQueryKey() });
      },
      onError: () => {
        toast({ title: "No se pudo confirmar el aviso", variant: "destructive" });
      },
    },
  });
  // Avisos de descanso ya mostrados (la cinta pasó una vez); la clave incluye
  // "desde" así una nueva salida del puesto vuelve a mostrarse.
  const [vistos, setVistos] = useState<Set<string>>(new Set());

  if (!esStaff || !avisos?.length) return null;

  // Los avisos de los médicos quedan en pantalla hasta que recepción los
  // confirma: se toca la tira entera (en cualquier lado) y se marca recibido.
  const esConfirmable = (a: DescansoActivo) => a.rol === "medico";
  const confirmarAviso = (a: DescansoActivo) => {
    if (confirmar.isPending) return;
    confirmar.mutate(
      { data: { usuarioId: a.usuarioId, tipo: a.tipo } },
      {
        onSuccess: () => {
          toast({ title: "Aviso confirmado", description: `Le avisamos a ${a.nombre} que su mensaje fue recibido.` });
        },
      },
    );
  };
  const pistaRecibido = (
    <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-current/40 bg-white/60 dark:bg-black/20 px-2.5 py-0.5 text-xs font-bold">
      <Check className="w-3.5 h-3.5" />
      Tocar para confirmar recibido
    </span>
  );

  // No mostrarse el aviso a uno mismo (ya lo ve en el botón).
  const deOtros = avisos.filter((a) => a.usuarioId !== user.id);
  const clave = (a: DescansoActivo) => `${a.usuarioId}-${a.tipo}-${a.desde}`;
  const visibles = deOtros.filter((a) => !(a.tipo === "descanso" && vistos.has(clave(a))));
  if (!visibles.length) return null;

  return (
    <div className="w-full" data-testid="banner-avisos-puesto">
      {visibles.map((a) => {
        if (a.tipo === "asistencia" || a.tipo === "seguridad") {
          // Asistencia y seguridad: banner fijo, centrado y pulsante (el
          // marquee no se pinta bien en vistas escaladas, ej. el lienzo).
          if (esConfirmable(a)) {
            return (
              <button
                key={clave(a)}
                type="button"
                onClick={() => confirmarAviso(a)}
                disabled={confirmar.isPending}
                className={`w-full flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-bold border-b animate-pulse cursor-pointer disabled:opacity-60 ${ESTILOS[a.tipo] ?? ESTILOS["descanso"]}`}
                title="Tocar para confirmar que el aviso fue recibido"
                data-testid={`button-confirmar-aviso-${a.usuarioId}-${a.tipo}`}
              >
                <Icono tipo={a.tipo} />
                <span>{textoAviso(a)}</span>
                {pistaRecibido}
              </button>
            );
          }
          return (
            <div
              key={clave(a)}
              className={`flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-bold border-b animate-pulse ${ESTILOS[a.tipo] ?? ESTILOS["descanso"]}`}
            >
              <Icono tipo={a.tipo} />
              <span>{textoAviso(a)}</span>
            </div>
          );
        }
        if (a.tipo === "descanso") {
          // "Salió de su puesto" pasa una sola vez y desaparece.
          return (
            <FilaMarquee
              key={clave(a)}
              aviso={a}
              unaVez
              onTermino={() => setVistos((prev) => new Set(prev).add(clave(a)))}
            />
          );
        }
        if (esConfirmable(a)) {
          return (
            <button
              key={clave(a)}
              type="button"
              onClick={() => confirmarAviso(a)}
              disabled={confirmar.isPending}
              className={`w-full flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-medium border-b cursor-pointer hover:brightness-95 dark:hover:brightness-110 disabled:opacity-60 ${ESTILOS[a.tipo] ?? ESTILOS["descanso"]}`}
              title="Tocar para confirmar que el aviso fue recibido"
              data-testid={`button-confirmar-aviso-${a.usuarioId}-${a.tipo}`}
            >
              <Icono tipo={a.tipo} />
              <span>{textoAviso(a)}</span>
              {pistaRecibido}
            </button>
          );
        }
        return (
          <div
            key={clave(a)}
            className={`flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-medium border-b ${ESTILOS[a.tipo] ?? ESTILOS["descanso"]}`}
          >
            <Icono tipo={a.tipo} />
            <span>{textoAviso(a)}</span>
          </div>
        );
      })}
    </div>
  );
}
