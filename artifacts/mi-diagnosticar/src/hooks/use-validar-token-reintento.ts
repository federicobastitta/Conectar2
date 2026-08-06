import { useEffect, useRef, useState } from "react";
import {
  useValidarTokenTurno,
  type TokenValidacionResultado,
} from "@workspace/api-client-react";

// Acuerdo con la gente del Robot (jul 2026): si la validación del token tarda
// más de ~20s, el Robot responde status "TIMEOUT" con retry_allowed:true.
// Eso NO es un rechazo — la validación sigue en curso en IOMA/Klinicos (el
// proceso completo puede tardar hasta 60s). Ante TIMEOUT hay que:
//   1. NO mostrar error al usuario: mostrar "validando…".
//   2. Reintentar la MISMA llamada (el backend reusa el mismo request_id)
//      entre 15 y 30 segundos después. El reintento es idempotente.
//   3. Tras 2-3 reintentos en TIMEOUT, recién ahí tratarlo como pendiente.
const ESPERA_REINTENTO_MS = 20_000;
const MAX_REINTENTOS = 3;

export interface ValidacionTokenEstado {
  /** Resultado final (no se setea mientras hay reintentos por TIMEOUT en curso). */
  resultado: TokenValidacionResultado | null;
  /** true mientras hay una llamada en vuelo O una espera de reintento por TIMEOUT. */
  validando: boolean;
  /** true si estamos en la espera entre reintentos por TIMEOUT. */
  esperandoReintento: boolean;
  /** Cantidad de reintentos por TIMEOUT ya disparados. */
  reintentos: number;
  /** true si se agotaron los reintentos y sigue en TIMEOUT (queda pendiente). */
  agotado: boolean;
}

export function useValidarTokenConReintento() {
  const [estado, setEstado] = useState<ValidacionTokenEstado>({
    resultado: null,
    validando: false,
    esperandoReintento: false,
    reintentos: 0,
    agotado: false,
  });
  const reintentosRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const argsRef = useRef<{ id: number; token: string } | null>(null);
  // Guard de concurrencia: cada validar()/cancelar() incrementa la operación.
  // Las respuestas en vuelo de una operación vieja (p.ej. tras cerrar el
  // dialog) se descartan para no resucitar "validando" ni pisar resultados.
  const opIdRef = useRef(0);

  const mutation = useValidarTokenTurno();

  const limpiarTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => limpiarTimer(), []);

  const disparar = () => {
    const args = argsRef.current;
    if (!args) return;
    const opId = opIdRef.current;
    mutation.mutate(
      { id: args.id, data: { token: args.token } },
      {
        onSuccess: (r) => {
          if (opId !== opIdRef.current) return; // operación cancelada/reemplazada
          if (r.estado === "TIMEOUT" && reintentosRef.current < MAX_REINTENTOS) {
            // La validación sigue en curso: reintentar la misma solicitud
            // (mismo request_id, lo maneja el backend) sin mostrar error.
            reintentosRef.current += 1;
            setEstado((e) => ({
              ...e,
              validando: true,
              esperandoReintento: true,
              reintentos: reintentosRef.current,
            }));
            limpiarTimer();
            timerRef.current = setTimeout(() => {
              if (opId !== opIdRef.current) return;
              setEstado((e) => ({ ...e, esperandoReintento: false }));
              disparar();
            }, ESPERA_REINTENTO_MS);
            return;
          }
          const agotado = r.estado === "TIMEOUT";
          setEstado({
            resultado: r,
            validando: false,
            esperandoReintento: false,
            reintentos: reintentosRef.current,
            agotado,
          });
        },
        onError: () => {
          if (opId !== opIdRef.current) return; // operación cancelada/reemplazada
          setEstado({
            resultado: {
              estado: "TECHNICAL_ERROR",
              mensaje: "No fue posible contactar al servidor",
              reintentable: true,
            } as TokenValidacionResultado,
            validando: false,
            esperandoReintento: false,
            reintentos: reintentosRef.current,
            agotado: false,
          });
        },
      },
    );
  };

  /** Inicia una validación nueva (resetea los reintentos). */
  const validar = (id: number, token: string) => {
    limpiarTimer();
    opIdRef.current += 1;
    reintentosRef.current = 0;
    argsRef.current = { id, token };
    setEstado({
      resultado: null,
      validando: true,
      esperandoReintento: false,
      reintentos: 0,
      agotado: false,
    });
    disparar();
  };

  /** Cancela cualquier espera de reintento pendiente (p.ej. al cerrar el dialog). */
  const cancelar = () => {
    limpiarTimer();
    opIdRef.current += 1; // ignora respuestas en vuelo de la operación anterior
    argsRef.current = null;
    reintentosRef.current = 0;
    setEstado({
      resultado: null,
      validando: false,
      esperandoReintento: false,
      reintentos: 0,
      agotado: false,
    });
  };

  return { ...estado, validar, cancelar };
}
