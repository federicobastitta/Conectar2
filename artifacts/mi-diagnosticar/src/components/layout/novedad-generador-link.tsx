import { useState } from "react";
import { Link2, X } from "lucide-react";

const STORAGE_KEY = "novedad_generador_link_vista";

/**
 * Cinta de novedad que corre a lo ancho del sistema anunciando el generador
 * de link con autologin. Incluye la miniatura del botón amarillo de la barra.
 * Se puede cerrar y queda cerrada en este navegador (localStorage).
 */
export function NovedadGeneradorLinkCinta() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "1";
    } catch {
      return true;
    }
  });

  if (!visible) return null;

  const cerrar = () => {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // sin localStorage, solo se oculta en esta sesión
    }
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 bg-gradient-to-r from-yellow-500/20 via-amber-500/15 to-yellow-500/20 border-b border-yellow-500/40 text-sm"
      data-testid="cinta-novedad-generador-link"
    >
      {/* Miniatura del botón nuevo de la barra */}
      <span className="shrink-0 h-7 w-7 rounded-lg bg-yellow-500 text-white ring-1 ring-yellow-300/60 inline-flex items-center justify-center">
        <Link2 className="w-3.5 h-3.5" />
      </span>
      <p className="flex-1 min-w-0">
        <span className="font-semibold">Nueva función:</span> Generador de Link con autologin a la
        app Mi Diagnosticar — tocá el botón amarillo de la barra, cargá el DNI del paciente y
        mandale el link (o mostrale el QR) para que entre directo, sin usuario ni clave.
      </p>
      <button
        type="button"
        onClick={cerrar}
        title="Cerrar aviso"
        data-testid="cerrar-cinta-novedad-generador-link"
        className="shrink-0 h-7 w-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-yellow-500/20"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
