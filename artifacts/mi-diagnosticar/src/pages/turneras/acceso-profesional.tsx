import { useState } from "react";
import {
  useGetMe,
  useListUsuarios,
  useCreateUsuario,
  useUpdateUsuario,
  getListUsuariosQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Loader2 } from "lucide-react";
import { PasswordInput } from "@/components/ui/password-input";

function InputClave({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
}) {
  return (
    <div className="sm:max-w-[220px] w-full">
      <PasswordInput
        data-testid={testId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
      />
    </div>
  );
}

/**
 * Acceso del profesional desde la pantalla de turnera (solo admin).
 * Crea el login con usuario + contraseña asignados por la clínica — sin mail.
 * El usuario queda vinculado al profesional (perfil "medico").
 */
export function AccesoProfesional({
  profesionalId,
  nombreProfesional,
}: {
  profesionalId: number;
  nombreProfesional: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe({ query: { retry: false } });
  const esAdmin = me?.rol === "admin";
  const { data: usuarios } = useListUsuarios({ query: { enabled: esAdmin } });
  const create = useCreateUsuario();
  const update = useUpdateUsuario();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nuevaClave, setNuevaClave] = useState("");

  if (!esAdmin) return null;

  const vinculados = (usuarios ?? []).filter((u) => u.profesionalId === profesionalId && u.activo);
  const existente = vinculados[0];

  const invalidar = () => queryClient.invalidateQueries({ queryKey: getListUsuariosQueryKey() });

  const crear = () => {
    const usuario = username.trim().toLowerCase();
    if (usuario.length < 3 || /\s/.test(usuario)) {
      toast({ title: "El usuario debe tener al menos 3 caracteres y sin espacios", variant: "destructive" });
      return;
    }
    if (password.length < 4) {
      toast({ title: "La contraseña debe tener al menos 4 caracteres", variant: "destructive" });
      return;
    }
    create.mutate(
      {
        data: {
          email: usuario,
          nombre: nombreProfesional,
          password,
          perfil: "medico_consulta_informante",
          profesionalId,
        },
      },
      {
        onSuccess: () => {
          invalidar();
          setUsername("");
          setPassword("");
          toast({ title: `Acceso creado: el profesional ingresa con "${usuario}"` });
        },
        onError: (e) => {
          const err = e as { response?: { status?: number; data?: { error?: string } } };
          const detalle = err?.response?.data?.error;
          toast({
            title:
              detalle ??
              (err?.response?.status === 409
                ? "Ya existe un usuario con ese nombre"
                : "No se pudo crear el acceso"),
            variant: "destructive",
          });
        },
      },
    );
  };

  const cambiarClave = () => {
    if (!existente) return;
    if (nuevaClave.length < 4) {
      toast({ title: "La contraseña debe tener al menos 4 caracteres", variant: "destructive" });
      return;
    }
    update.mutate(
      { id: existente.id, data: { password: nuevaClave } },
      {
        onSuccess: () => {
          setNuevaClave("");
          toast({ title: "Contraseña actualizada" });
        },
        onError: () => toast({ title: "No se pudo cambiar la contraseña", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="rounded-lg border p-4 space-y-3" data-testid="acceso-profesional">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-primary" />
        <p className="text-sm font-medium">Acceso del profesional</p>
      </div>
      {existente ? (
        <>
          <p className="text-sm text-muted-foreground">
            Ya tiene acceso. Ingresa con el usuario{" "}
            <span className="font-mono font-medium text-foreground">{existente.email}</span>.
          </p>
          {vinculados.length > 1 && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Atención: este profesional tiene {vinculados.length} usuarios activos (
              {vinculados.map((u) => u.email).join(", ")}). El cambio de contraseña aplica a{" "}
              <span className="font-mono">{existente.email}</span>; revisá los demás en Perfiles.
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <InputClave
              testId="input-nueva-clave-profesional"
              placeholder="Nueva contraseña"
              value={nuevaClave}
              onChange={setNuevaClave}
            />
            <Button
              type="button"
              variant="outline"
              onClick={cambiarClave}
              disabled={update.isPending || nuevaClave.length === 0}
              data-testid="boton-cambiar-clave-profesional"
            >
              {update.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Cambiar contraseña
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Este profesional todavía no tiene login. Asignale un usuario y una contraseña (sin mail):
            con eso ingresa a su bandeja de informes.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              data-testid="input-usuario-profesional"
              placeholder="Usuario (ej: jperez)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="sm:max-w-[200px]"
              autoComplete="off"
            />
            <InputClave
              testId="input-clave-profesional"
              placeholder="Contraseña"
              value={password}
              onChange={setPassword}
            />
            <Button
              type="button"
              onClick={crear}
              disabled={create.isPending || username.length === 0 || password.length === 0}
              data-testid="boton-crear-acceso-profesional"
            >
              {create.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Crear acceso
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
