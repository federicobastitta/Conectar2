import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bell } from "lucide-react";

// Datos mínimos para reproducir el llamado tal como se ve en la pantalla TV.
export interface DatosLlamado {
  paciente: string;
  profesional?: string | null;
  consultorio?: string | null;
  turnera?: string | null;
}

// Cuánto dura el efecto en pantalla antes de cerrarse solo.
const DURACION_MS = 2000;

// El profesional puede venir "Apellido, Nombre": se muestra siempre como
// "Nombre Apellido", igual que en la pantalla TV.
function nombreDoctor(nombre: string | null | undefined): string {
  const crudo = (nombre ?? "").trim();
  if (!crudo) return "";
  const partes = crudo.split(",");
  if (partes.length === 2) {
    const [apellido, nombrePila] = partes.map((p) => p.trim());
    return [nombrePila, apellido].filter(Boolean).join(" ");
  }
  return crudo.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Overlay a pantalla completa que replica el llamado de la pantalla TV:
 * feedback visual de ~2 segundos al confirmar un "Llamar". Se cierra solo.
 *
 * Uso: guardar los datos del paciente en un estado al éxito de la mutación y
 * renderizar `<LlamadoOverlay llamado={datos} onCerrar={() => setDatos(null)} />`.
 */
export function LlamadoOverlay({
  llamado,
  onCerrar,
}: {
  llamado: DatosLlamado | null;
  onCerrar: () => void;
}) {
  // Pequeña transición de entrada/salida para que no aparezca de golpe.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!llamado) return;
    const tIn = requestAnimationFrame(() => setVisible(true));
    const tOut = setTimeout(() => setVisible(false), DURACION_MS - 200);
    const tFin = setTimeout(onCerrar, DURACION_MS);
    return () => {
      cancelAnimationFrame(tIn);
      clearTimeout(tOut);
      clearTimeout(tFin);
      setVisible(false);
    };
    // onCerrar puede ser una función nueva en cada render; alcanza con el llamado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llamado]);

  if (!llamado) return null;

  const destino = llamado.consultorio || llamado.turnera || null;
  const profesional = nombreDoctor(llamado.profesional);

  // Estética fija de la TV (fondo oscuro), legible igual en tema claro y oscuro.
  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 backdrop-blur-sm transition-opacity duration-200 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      role="status"
      aria-live="polite"
      data-testid="overlay-llamado"
    >
      <div
        className={`mx-6 w-full max-w-3xl rounded-3xl border-4 border-cyan-400 bg-slate-900 px-8 py-12 text-center text-white shadow-2xl transition-transform duration-200 ${
          visible ? "scale-100" : "scale-95"
        } animate-pulse`}
      >
        <div className="mb-6 flex items-center justify-center gap-3 text-2xl font-semibold uppercase tracking-widest text-cyan-400 sm:text-3xl">
          <Bell className="h-8 w-8 sm:h-9 sm:w-9" />
          Llamando a
        </div>
        <div
          className="break-words text-5xl font-extrabold leading-tight sm:text-6xl"
          data-testid="overlay-llamado-paciente"
        >
          {llamado.paciente}
        </div>
        {profesional && (
          <div className="mt-5 text-2xl text-slate-300 sm:text-3xl">Dr. {profesional}</div>
        )}
        {destino && (
          <div
            className="mt-4 text-3xl font-extrabold uppercase text-cyan-300 sm:text-4xl"
            data-testid="overlay-llamado-destino"
          >
            {destino}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
