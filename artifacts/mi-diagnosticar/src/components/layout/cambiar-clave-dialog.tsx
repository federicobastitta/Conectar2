import { useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

/**
 * Diálogo para que cualquier usuario logueado (médicos incluidos) cambie
 * su propia contraseña. Usa POST /api/auth/cambiar-clave.
 */
export function CambiarClaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repetir, setRepetir] = useState("");
  const [enviando, setEnviando] = useState(false);

  const limpiar = () => {
    setActual("");
    setNueva("");
    setRepetir("");
  };

  const guardar = async () => {
    if (nueva.length < 4) {
      toast({ title: "La nueva contraseña debe tener al menos 4 caracteres", variant: "destructive" });
      return;
    }
    if (nueva !== repetir) {
      toast({ title: "Las contraseñas nuevas no coinciden", variant: "destructive" });
      return;
    }
    setEnviando(true);
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch("/api/auth/cambiar-clave", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ claveActual: actual, claveNueva: nueva }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast({ title: body.error ?? "No se pudo cambiar la contraseña", variant: "destructive" });
        return;
      }
      toast({ title: "Contraseña actualizada" });
      limpiar();
      onOpenChange(false);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) limpiar();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Cambiar mi contraseña</DialogTitle>
          <DialogDescription>
            Ingresá tu contraseña actual y la nueva que querés usar.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Contraseña actual</Label>
            <PasswordInput
              data-testid="input-clave-actual"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Nueva contraseña</Label>
            <PasswordInput
              data-testid="input-clave-nueva"
              value={nueva}
              onChange={(e) => setNueva(e.target.value)}
              autoComplete="new-password"
              placeholder="Mínimo 4 caracteres"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Repetir nueva contraseña</Label>
            <PasswordInput
              data-testid="input-clave-repetir"
              value={repetir}
              onChange={(e) => setRepetir(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            Cancelar
          </Button>
          <Button
            onClick={guardar}
            disabled={enviando || !actual || !nueva || !repetir}
            data-testid="boton-guardar-clave"
          >
            {enviando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
