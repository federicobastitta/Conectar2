import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useValidarTokenConReintento, type ValidacionTokenEstado } from "@/hooks/use-validar-token-reintento";
import { TokenValidadoCartel } from "@/components/turnos/token-validado-cartel";

// Denegaciones reales de IOMA/Klinicos (NO errores técnicos ni contingencias):
// disparan el cartel rojo grande "TOKEN NO VÁLIDO".
export const ESTADOS_DENEGACION = [
  "TOKEN_DENIED",
  "TOKEN_EXPIRED",
  "TOKEN_ALREADY_USED",
  "PATIENT_MISMATCH",
];

// Contexto global de validación de token (pedido jul 2026): la validación
// corre en segundo plano aunque el operador cierre la ventana del token con
// "Cargar después". Cuando llega el resultado (aceptado o denegación real),
// el cartel grande salta a pantalla completa en cualquier pantalla, con un
// sonido corto. El estado vive acá arriba del router para sobrevivir a
// cierres de dialogs y cambios de página.
interface ValidacionTokenContexto extends ValidacionTokenEstado {
  /** Turno de la validación en curso o del último resultado (para que cada pantalla sepa si el resultado es "suyo"). */
  turnoIdEnCurso: number | null;
  /** Inicia una validación (pacienteFallback: nombre para el cartel si el resultado no lo trae). */
  validar: (id: number, token: string, pacienteFallback?: string | null) => void;
  /** Cancela y resetea todo (usar solo cuando el operador descarta explícitamente). */
  cancelar: () => void;
}

const Ctx = createContext<ValidacionTokenContexto | null>(null);

export function useValidacionToken() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useValidacionToken debe usarse dentro de ValidacionTokenProvider");
  return ctx;
}

export function ValidacionTokenProvider({ children }: { children: ReactNode }) {
  const hook = useValidarTokenConReintento();
  const [cartelVisto, setCartelVisto] = useState(false);
  const [turnoIdEnCurso, setTurnoIdEnCurso] = useState<number | null>(null);
  const pacienteFallbackRef = useRef<string | null>(null);

  const validar = (id: number, token: string, pacienteFallback?: string | null) => {
    pacienteFallbackRef.current = pacienteFallback ?? null;
    setCartelVisto(false);
    setTurnoIdEnCurso(id);
    hook.validar(id, token);
  };

  const cancelar = () => {
    pacienteFallbackRef.current = null;
    setCartelVisto(false);
    setTurnoIdEnCurso(null);
    hook.cancelar();
  };

  // Si el paciente quedó recepcionado automáticamente al validarse el token,
  // refrescar agenda/recepción para que se vea el cambio de estado al
  // instante, esté donde esté el operador (el dialog puede ya estar cerrado).
  const queryClient = useQueryClient();
  useEffect(() => {
    if (hook.resultado?.estado === "TOKEN_ACCEPTED" && hook.resultado.recepcionadoAutomatico) {
      void queryClient.invalidateQueries({
        predicate: (qy) => {
          const clave = String(qy.queryKey[0] ?? "");
          return clave.includes("/recepcion/") || clave.includes("/turnos");
        },
      });
    }
  }, [hook.resultado, queryClient]);

  const aceptado = hook.resultado?.estado === "TOKEN_ACCEPTED";
  const rechazado = ESTADOS_DENEGACION.includes(hook.resultado?.estado ?? "");

  return (
    <Ctx.Provider value={{ ...hook, turnoIdEnCurso, validar, cancelar }}>
      {children}
      {(aceptado || rechazado) && !cartelVisto && (
        <TokenValidadoCartel
          apellido={hook.resultado?.pacienteApellido ?? pacienteFallbackRef.current}
          nombre={hook.resultado?.pacienteApellido ? (hook.resultado?.pacienteNombre ?? null) : null}
          recepcionado={hook.resultado?.recepcionadoAutomatico}
          nroBono={hook.resultado?.nroBono ?? null}
          autorizacionDetalle={hook.resultado?.autorizacionDetalle ?? null}
          rechazado={rechazado}
          mensaje={rechazado ? hook.resultado?.mensaje : null}
          onClose={() => setCartelVisto(true)}
        />
      )}
    </Ctx.Provider>
  );
}
