import { useEffect, useRef } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

// Cartel grande a pantalla completa con el resultado de la validación del
// token (pedido jul 2026): el operador puede estar haciendo otras tareas
// mientras el Robot valida, y el cartel le avisa sin que tenga que mirar el
// dialog. Verde = validado; rojo = token no válido (denegación real).
// Se cierra solo a los pocos segundos o con un clic/Enter/Escape.
// Al aparecer suena un aviso corto (ver sonarAviso al final del archivo).
export function TokenValidadoCartel({
  apellido,
  nombre,
  recepcionado,
  nroBono,
  rechazado,
  mensaje,
  autorizacionDetalle,
  onClose,
}: {
  apellido?: string | null;
  nombre?: string | null;
  recepcionado?: boolean;
  /** N° de bono REAL informado por Klinicos al autorizar; null = no se muestra (nunca se inventa). */
  nroBono?: string | null;
  /** true = cartel rojo "TOKEN NO VÁLIDO" (denegación, no error técnico). */
  rechazado?: boolean;
  /** Motivo del rechazo informado por IOMA/Klinicos. */
  mensaje?: string | null;
  /** Token validado pero la prestación NO quedó autorizada en Klinicos: motivo. */
  autorizacionDetalle?: string | null;
  onClose: () => void;
}) {
  const sonoRef = useRef(false);
  useEffect(() => {
    if (!sonoRef.current) {
      sonoRef.current = true;
      sonarAviso(!!rechazado);
    }
    // El rechazo queda más tiempo en pantalla: requiere acción del operador.
    const timer = setTimeout(onClose, rechazado ? 8000 : 5000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, rechazado]);

  const nombreCompleto = [apellido, nombre].filter(Boolean).join(", ");

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm cursor-pointer"
      onClick={onClose}
      role="alertdialog"
      aria-label={rechazado ? "Token no válido" : "Token validado"}
      data-testid={rechazado ? "cartel-token-rechazado" : "cartel-token-validado"}
    >
      {rechazado ? (
        <div className="mx-4 w-full max-w-2xl rounded-2xl border-4 border-red-400 bg-red-600 px-8 py-10 text-center text-white shadow-2xl">
          <XCircle className="mx-auto mb-4 h-20 w-20 text-red-100" />
          <p className="text-2xl font-semibold uppercase tracking-wide text-red-100">
            Paciente {nombreCompleto || "—"}
          </p>
          <p className="mt-2 text-5xl font-extrabold tracking-widest">TOKEN NO VÁLIDO</p>
          {mensaje && <p className="mt-4 text-lg font-medium text-red-100">{mensaje}</p>}
          <p className="mt-6 text-xs text-red-200/80">Clic o Enter para cerrar</p>
        </div>
      ) : !nroBono ? (
        <div className="mx-4 w-full max-w-2xl rounded-2xl border-4 border-amber-400 bg-amber-500 px-8 py-10 text-center text-white shadow-2xl" data-testid="cartel-token-sin-bono">
          <XCircle className="mx-auto mb-4 h-20 w-20 text-amber-100" />
          <p className="text-2xl font-semibold uppercase tracking-wide text-amber-100">
            Paciente {nombreCompleto || "—"}
          </p>
          <p className="mt-2 text-4xl font-extrabold tracking-widest">NO AUTORIZADO EN KLINICOS</p>
          <p className="mt-4 text-lg font-semibold">
            Klinicos no autorizó la prestación: el token todavía NO está usado.
          </p>
          {autorizacionDetalle && (
            <p className="mt-2 text-base font-medium text-amber-50">{autorizacionDetalle}</p>
          )}
          <p className="mt-3 text-base font-medium text-amber-100">
            Verificá o cargá el token a mano en Klinicos.
          </p>
          <p className="mt-6 text-xs text-amber-200/80">Clic o Enter para cerrar</p>
        </div>
      ) : (
        <div className="mx-4 w-full max-w-2xl rounded-2xl border-4 border-emerald-400 bg-emerald-600 px-8 py-10 text-center text-white shadow-2xl">
          <CheckCircle2 className="mx-auto mb-4 h-20 w-20 text-emerald-100" />
          <p className="text-2xl font-semibold uppercase tracking-wide text-emerald-100">
            Paciente {nombreCompleto || "—"}
          </p>
          <p className="mt-2 text-5xl font-extrabold tracking-widest">PACIENTE VALIDADO</p>
          <p className="mt-4 text-3xl font-bold tracking-wide" data-testid="cartel-nro-bono">
            N° de Bono {nroBono}
          </p>
          {recepcionado && (
            <p className="mt-4 text-lg font-medium text-emerald-100">
              Quedó recepcionado: pasó a la sala de espera.
            </p>
          )}
          <p className="mt-6 text-xs text-emerald-200/80">Clic o Enter para cerrar</p>
        </div>
      )}
    </div>
  );
}

function sonarAviso(rechazado: boolean) {
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notas = rechazado ? [440, 294] : [523, 784];
    notas.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.start(t);
      osc.stop(t + 0.18);
    });
    setTimeout(() => void ctx.close(), 900);
  } catch {
    // sin sonido: no es crítico
  }
}
