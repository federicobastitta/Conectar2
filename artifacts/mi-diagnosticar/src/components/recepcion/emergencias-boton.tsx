import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PhoneCall } from "lucide-react";

// Datos fijos de emergencias médicas del establecimiento (pedido jul 2026).
const TELEFONO_EMERGENCIAS = "37547777";
const CODIGO_CLIENTE = "902525";

// Botón siempre visible en el header para recepción/staff: al tocarlo muestra
// el teléfono de emergencias médicas y el código de cliente, bien grandes.
export function EmergenciasBoton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-lg bg-rose-600 text-white hover:bg-rose-500 hover:text-white ring-1 ring-rose-400/60"
          title="Emergencias médicas"
          data-testid="boton-emergencias"
        >
          <PhoneCall className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <p className="text-sm font-semibold flex items-center gap-2 text-red-500">
            <PhoneCall className="w-4 h-4" /> Emergencias médicas
          </p>
          <div>
            <p className="text-xs text-muted-foreground">Teléfono</p>
            <p className="text-2xl font-bold tracking-wide" data-testid="texto-telefono-emergencias">
              {TELEFONO_EMERGENCIAS}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Código de cliente</p>
            <p className="text-xl font-semibold tracking-wide" data-testid="texto-codigo-cliente">
              {CODIGO_CLIENTE}
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
