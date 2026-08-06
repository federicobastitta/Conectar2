import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Loader2 } from "lucide-react";

type Pedido = {
  id: number;
  identificador: string;
  createdAt: string;
  usuario: { id: number; email: string; nombre: string } | null;
};

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Aviso para el administrador: pedidos de "olvidé mi contraseña" pendientes.
 * Desde acá asigna la clave nueva o descarta el pedido.
 */
export function PedidosRecuperacionBanner() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [claves, setClaves] = useState<Record<number, string>>({});
  const [procesando, setProcesando] = useState<number | null>(null);

  const { data: pedidos } = useQuery<Pedido[]>({
    queryKey: ["pedidos-recuperacion"],
    queryFn: async () => {
      const res = await fetch("/api/auth/pedidos-recuperacion", { headers: authHeaders() });
      if (!res.ok) throw new Error("error");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (!pedidos || pedidos.length === 0) return null;

  const resolver = async (pedido: Pedido, conClave: boolean) => {
    const nuevaClave = claves[pedido.id] ?? "";
    if (conClave && nuevaClave.length < 4) {
      toast({ title: "La nueva contraseña debe tener al menos 4 caracteres", variant: "destructive" });
      return;
    }
    setProcesando(pedido.id);
    try {
      const res = await fetch(`/api/auth/pedidos-recuperacion/${pedido.id}/resolver`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(conClave ? { nuevaClave } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast({ title: body.error ?? "No se pudo resolver el pedido", variant: "destructive" });
        return;
      }
      toast({
        title: conClave
          ? `Contraseña nueva asignada a ${pedido.identificador}. Acordate de comunicársela.`
          : "Pedido descartado",
      });
      queryClient.invalidateQueries({ queryKey: ["pedidos-recuperacion"] });
    } finally {
      setProcesando(null);
    }
  };

  return (
    <>
      <div
        className="bg-amber-100 dark:bg-amber-900/40 border-b border-amber-300 dark:border-amber-700 px-4 py-2 flex items-center justify-between gap-3"
        data-testid="banner-pedidos-recuperacion"
      >
        <p className="text-sm text-amber-900 dark:text-amber-100 flex items-center gap-2">
          <KeyRound className="w-4 h-4 shrink-0" />
          {pedidos.length === 1
            ? "Hay 1 pedido de recuperación de contraseña pendiente."
            : `Hay ${pedidos.length} pedidos de recuperación de contraseña pendientes.`}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAbierto(true)} data-testid="boton-ver-pedidos">
          Ver pedidos
        </Button>
      </div>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Recuperación de contraseñas</DialogTitle>
            <DialogDescription>
              Asignales una contraseña nueva y comunicásela a cada persona.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {pedidos.map((p) => (
              <div key={p.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {p.usuario ? `${p.usuario.nombre} (${p.usuario.email})` : p.identificador}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Pedido el {new Date(p.createdAt).toLocaleString("es-AR")}
                      {!p.usuario && " — no coincide con ningún usuario"}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  {p.usuario && (
                    <>
                      <div className="sm:max-w-[200px] w-full">
                        <PasswordInput
                          data-testid={`input-clave-pedido-${p.id}`}
                          placeholder="Nueva contraseña"
                          value={claves[p.id] ?? ""}
                          onChange={(e) => setClaves((c) => ({ ...c, [p.id]: e.target.value }))}
                          autoComplete="new-password"
                        />
                      </div>
                      <Button
                        size="sm"
                        onClick={() => resolver(p, true)}
                        disabled={procesando === p.id || !(claves[p.id] ?? "").length}
                        data-testid={`boton-asignar-pedido-${p.id}`}
                      >
                        {procesando === p.id && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Asignar clave
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => resolver(p, false)}
                    disabled={procesando === p.id}
                    data-testid={`boton-descartar-pedido-${p.id}`}
                  >
                    Descartar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
