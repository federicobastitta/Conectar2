import { useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

/**
 * "Olvidé mi contraseña" desde el login: deja un pedido que el administrador
 * ve dentro de la app, y desde ahí le asigna una clave nueva.
 */
export function OlvideClaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [usuario, setUsuario] = useState("");
  const [enviando, setEnviando] = useState(false);

  const enviar = async () => {
    if (usuario.trim().length < 3) {
      toast({ title: "Ingresá tu email o usuario", variant: "destructive" });
      return;
    }
    setEnviando(true);
    try {
      const res = await fetch("/api/auth/olvide-clave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast({ title: body.error ?? "No se pudo enviar el pedido", variant: "destructive" });
        return;
      }
      toast({
        title: "Pedido enviado",
        description: "El administrador va a asignarte una contraseña nueva y te la va a comunicar.",
      });
      setUsuario("");
      onOpenChange(false);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Recuperar contraseña</DialogTitle>
          <DialogDescription>
            Decinos tu email o usuario y le avisamos al administrador para que te asigne una
            contraseña nueva.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Email o usuario</Label>
          <Input
            data-testid="input-olvide-usuario"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            placeholder="ej: jperez"
            autoComplete="username"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            Cancelar
          </Button>
          <Button onClick={enviar} disabled={enviando || usuario.trim().length === 0} data-testid="boton-enviar-olvide">
            {enviando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Enviar pedido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
