import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldCheck } from "lucide-react";

interface Props {
  abierto: boolean;
  pendiente?: boolean;
  onConfirmar: (codigo: string) => void;
  onCancelar: () => void;
}

// Diálogo para autorizar una recepción de consulta sin token validado:
// pide el código de 6 dígitos que genera el supervisor en su app authenticator.
export function DialogoCodigoSupervisor({ abierto, pendiente, onConfirmar, onCancelar }: Props) {
  const [codigo, setCodigo] = useState("");
  useEffect(() => {
    if (abierto) setCodigo("");
  }, [abierto]);

  return (
    <Dialog open={abierto} onOpenChange={(open) => { if (!open) onCancelar(); }}>
      <DialogContent className="max-w-sm" data-testid="dialogo-codigo-supervisor">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-amber-600" /> Autorización de supervisor
          </DialogTitle>
          <DialogDescription>
            Recepcionar esta consulta sin token validado requiere el código del supervisor
            (app authenticator, 6 dígitos).
          </DialogDescription>
        </DialogHeader>
        <Input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoFocus
          placeholder="Código de 6 dígitos"
          className="h-10 font-mono tracking-widest text-center"
          data-testid="input-dialogo-codigo-supervisor"
          onKeyDown={(e) => {
            if (e.key === "Enter" && codigo.length === 6 && !pendiente) onConfirmar(codigo);
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancelar} disabled={pendiente}>
            Cancelar
          </Button>
          <Button
            onClick={() => onConfirmar(codigo)}
            disabled={codigo.length !== 6 || pendiente}
            data-testid="boton-confirmar-codigo-supervisor"
          >
            {pendiente ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Autorizar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
