import { useState } from "react";
import { useLocation } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Loader2 } from "lucide-react";
import iconoConectar from "@/assets/icono-conectar.png";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useLogin, useGetMe } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { OlvideClaveDialog } from "@/components/olvide-clave-dialog";

// Vista de inicio según el rol/perfil del usuario.
// Recepción entra directo a "Nuevo Turno", no al dashboard.
// El administrador entra directo a la Agenda.
function destinoInicial(rol: string | undefined, perfil: string | null): string {
  if (rol === "paciente") return "/mi-turno";
  // Todos los perfiles médicos arrancan en "Mi agenda".
  if (rol === "medico") return "/recepcion/agenda-medico";
  if (rol === "recepcionista" && perfil == null) return "/turnos/nuevo";
  if (rol === "admin" || perfil === "administrador") return "/agendas";
  return "/";
}

const loginSchema = z.object({
  email: z.string().min(1, { message: "Ingresá tu email o usuario" }),
  password: z.string().min(4, { message: "Contraseña muy corta" }),
});

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [olvideAbierto, setOlvideAbierto] = useState(false);
  
  // If already logged in, redirect
  const { data: user } = useGetMe({ query: { retry: false }});
  if (user) {
    setLocation(sessionStorage.getItem("feedback_solo") === "1" ? "/feedback" : destinoInicial(user.rol, user.perfil ?? null));
  }

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const loginMutation = useLogin();

  function onSubmit(values: z.infer<typeof loginSchema>) {
    loginMutation.mutate({ data: values }, {
      onSuccess: (data) => {
        if (data?.token) {
          localStorage.setItem("auth_token", data.token);
        }
        setLocation(sessionStorage.getItem("feedback_solo") === "1" ? "/feedback" : destinoInicial(data?.user?.rol, data?.user?.perfil ?? null));
      },
      onError: () => {
        toast({
          title: "Error de autenticación",
          description: "Credenciales incorrectas",
          variant: "destructive",
        });
      }
    });
  }

  return (
    <div className="min-h-screen bg-muted/30 flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-lg border-primary/10">
        <CardHeader className="space-y-3 text-center pb-6">
          <div className="mx-auto">
            <img
              src={iconoConectar}
              alt="Conectar by Diagnosticar"
              className="w-40 h-40 mx-auto rounded-3xl shadow-lg"
              data-testid="img-logo-login"
            />
          </div>
          <p className="text-sm text-muted-foreground">Red clínica digital</p>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email o usuario</FormLabel>
                    <FormControl>
                      <Input placeholder="usuario@diagnosticar.ar" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contraseña</FormLabel>
                    <FormControl>
                      <PasswordInput placeholder="••••••••" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button 
                type="submit" 
                className="w-full mt-6" 
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Ingresar
              </Button>
            </form>
          </Form>
          
          <div className="mt-4 text-center">
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => setOlvideAbierto(true)}
              data-testid="link-olvide-clave"
            >
              ¿Olvidaste tu contraseña?
            </button>
          </div>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            <p>Acceso restringido para personal autorizado.</p>
          </div>
          <OlvideClaveDialog open={olvideAbierto} onOpenChange={setOlvideAbierto} />
        </CardContent>
      </Card>
    </div>
  );
}
