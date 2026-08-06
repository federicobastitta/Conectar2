import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Loader2, AlertTriangle } from "lucide-react";
import { useIngresoMagico } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import iconoConectar from "@/assets/icono-conectar.png";

/**
 * Ingreso del paciente por link mágico (autologin desde WhatsApp).
 * Consume el token de un solo uso, guarda la sesión y redirige al inicio.
 */
export default function IngresoMagico() {
  const [, params] = useRoute("/ingreso/:token");
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const consumido = useRef(false);

  const ingreso = useIngresoMagico({
    mutation: {
      onSuccess: (data) => {
        if (data?.token) localStorage.setItem("auth_token", data.token);
        setLocation("/mi-turno");
      },
      onError: (e: unknown) => {
        const msg =
          e && typeof e === "object" && "error" in e
            ? String((e as { error: unknown }).error)
            : "No se pudo validar el link de ingreso.";
        setError(msg);
      },
    },
  });

  const token = params?.token ?? "";

  useEffect(() => {
    // El token es de un solo uso: consumirlo una única vez aunque React
    // vuelva a montar el efecto (StrictMode, re-render).
    if (!token || consumido.current) return;
    consumido.current = true;
    ingreso.mutate({ data: { token } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6 flex flex-col items-center gap-4 text-center">
          <img src={iconoConectar} alt="Mi Diagnosticar" className="w-16 h-16" />
          {!error ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin text-primary" data-testid="ingreso-cargando" />
              <p className="text-sm text-muted-foreground">Ingresando a la app…</p>
            </>
          ) : (
            <>
              <AlertTriangle className="w-6 h-6 text-amber-500" />
              <p className="text-sm" data-testid="ingreso-error">
                {error}
              </p>
              <Button className="w-full" onClick={() => setLocation("/login")} data-testid="ingreso-ir-login">
                Ingresar con usuario y clave
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
