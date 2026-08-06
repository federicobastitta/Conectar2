import { useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { FaWhatsapp } from "react-icons/fa";
import { Button } from "@/components/ui/button";

// ── Whaticket embebido (mismo patrón que el visor del PACS) ────────────────
// Abre el panel de Whaticket adentro del sistema, en un overlay a pantalla
// completa. Si Whaticket algún día bloquea el iframe (queda gris/en blanco),
// está el botón "Abrir en pestaña nueva" como salida.

const WHATICKET_PANEL_URL = "https://app.whaticket.com/tickets";

export function WhaticketPanelBoton() {
  const [abierto, setAbierto] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title="Whaticket (bandeja de WhatsApp de la clínica)"
        data-testid="boton-header-whaticket"
        className="relative h-9 w-9 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 ring-1 ring-emerald-400/60 inline-flex items-center justify-center"
      >
        <FaWhatsapp className="w-4 h-4" />
        <span className="absolute -bottom-0.5 -right-0.5 text-[7px] font-bold bg-green-600 text-white rounded px-0.5 leading-tight">WT</span>
      </button>

      {abierto && (
        <div className="fixed inset-0 z-[80] bg-background flex flex-col" data-testid="overlay-whaticket">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-sidebar shrink-0">
            <span className="text-sm font-semibold text-white flex items-center gap-2">
              <FaWhatsapp className="w-4 h-4 text-green-400" /> Whaticket
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-sidebar-foreground/80 hover:text-white gap-1.5"
                onClick={() => window.open(WHATICKET_PANEL_URL, "_blank", "noopener")}
                data-testid="boton-whaticket-pestana"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Abrir en pestaña nueva
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-sidebar-foreground/80 hover:text-white"
                onClick={() => setAbierto(false)}
                data-testid="boton-whaticket-cerrar"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <iframe
            src={WHATICKET_PANEL_URL}
            title="Whaticket"
            className="flex-1 w-full border-0"
            allow="clipboard-read; clipboard-write; microphone; camera"
          />
        </div>
      )}
    </>
  );
}
