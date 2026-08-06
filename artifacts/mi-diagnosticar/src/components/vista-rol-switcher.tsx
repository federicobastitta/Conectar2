// ── Modo "ver como" (solo desarrolladores/admins) ─────────────────────────────
// El admin puede simular la vista de cualquier rol o perfil funcional sin
// cerrar sesión. Se ofrece en dos formatos:
//   - VistaRolHeaderButton: botón en el header (al lado del PACS)
//   - VistaRolSwitcher: pill flotante, visible solo cuando hay una vista
//     activa, para poder volver al perfil real desde cualquier pantalla
//     (incluida la vista paciente, que no tiene header).
import { useState } from "react";
import { useLocation } from "wouter";
import { useGetMe, useCambiarVistaRol } from "@workspace/api-client-react";
import type { VistaRolInputRol } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, X, Loader2, UserCog } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type VistaValor = Exclude<VistaRolInputRol, null>;

const VISTAS: { valor: VistaValor; label: string; emoji: string; grupo: "rol" | "perfil" }[] = [
  { valor: "medico", label: "Médico", emoji: "🩺", grupo: "rol" },
  { valor: "recepcionista", label: "Recepción", emoji: "🗂️", grupo: "rol" },
  { valor: "paciente", label: "Paciente", emoji: "📱", grupo: "rol" },
  { valor: "administracion", label: "Administración", emoji: "🗄️", grupo: "perfil" },
  { valor: "administrador_caja", label: "Administración + Caja", emoji: "💵", grupo: "perfil" },
  { valor: "tecnico", label: "Técnico", emoji: "🔧", grupo: "perfil" },
  { valor: "medico_consulta", label: "Médico de consulta", emoji: "🩺", grupo: "perfil" },
  { valor: "medico_informante", label: "Médico informante", emoji: "📝", grupo: "perfil" },
  { valor: "medico_consulta_informante", label: "Médico consulta + informante", emoji: "🩺", grupo: "perfil" },
  { valor: "gerente", label: "Gerente", emoji: "📊", grupo: "perfil" },
  { valor: "desarrollador", label: "Desarrollador", emoji: "💻", grupo: "perfil" },
];

const RUTAS_EXCLUIDAS = ["/login", "/pantalla-sala"];

function useCambiarVista() {
  const queryClient = useQueryClient();
  const [cambiando, setCambiando] = useState(false);
  const cambiarVista = useCambiarVistaRol();
  const { toast } = useToast();

  const cambiar = (rol: VistaRolInputRol, vistaActiva: string | null) => {
    if (rol === vistaActiva) return;
    setCambiando(true);
    cambiarVista.mutate(
      { data: { rol } },
      {
        onSuccess: (nuevo) => {
          if (rol !== null && nuevo.vistaRol !== rol) {
            // El backend no encontró un usuario con ese rol/perfil: avisamos.
            setCambiando(false);
            const v = VISTAS.find((x) => x.valor === rol);
            toast({
              title: `No hay ningún usuario activo con el perfil ${v?.label ?? rol}`,
              description: "Creá uno en la sección Perfiles para poder simular esa vista.",
              variant: "destructive",
            });
            return;
          }
          queryClient.clear();
          // Recargar en el inicio: cada rol tiene su home (paciente → /mi-turno vía redirect)
          window.location.href = import.meta.env.BASE_URL;
        },
        onError: () => setCambiando(false),
      },
    );
  };

  return { cambiar, cambiando };
}

function OpcionesVista({
  vistaActiva,
  cambiar,
}: {
  vistaActiva: string | null;
  cambiar: (rol: VistaRolInputRol, vistaActiva: string | null) => void;
}) {
  const roles = VISTAS.filter((v) => v.grupo === "rol");
  const perfiles = VISTAS.filter((v) => v.grupo === "perfil");
  const item = (v: (typeof VISTAS)[number]) => (
    <DropdownMenuItem
      key={v.valor}
      onClick={() => cambiar(v.valor, vistaActiva)}
      className={vistaActiva === v.valor ? "bg-accent font-medium" : ""}
      data-testid={`item-vista-${v.valor}`}
    >
      <span className="mr-2">{v.emoji}</span> {v.label}
      {vistaActiva === v.valor && <span className="ml-auto text-xs">activo</span>}
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenuLabel>Ver el sistema como…</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {roles.map(item)}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs text-muted-foreground">Perfiles funcionales</DropdownMenuLabel>
      {perfiles.map(item)}
      {vistaActiva && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => cambiar(null, vistaActiva)} data-testid="item-vista-volver">
            <X className="mr-2 h-4 w-4" /> Volver a mi perfil (admin)
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

// Botón para el header, al lado del acceso al PACS.
export function VistaRolHeaderButton() {
  const { data: me } = useGetMe({ query: { retry: false } });
  const { cambiar, cambiando } = useCambiarVista();

  if (!me?.puedeCambiarVista) return null;
  const vistaActiva = me.vistaRol ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`relative h-9 w-9 rounded-lg ring-1 ${
            vistaActiva
              ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/35 hover:text-amber-200 ring-amber-400/40"
              : "bg-violet-500/15 text-violet-300 hover:bg-violet-500/30 hover:text-violet-200 ring-violet-400/30"
          }`}
          title="Cambiar de sesión (ver como…)"
          data-testid="boton-header-vista-rol"
          disabled={cambiando}
        >
          {cambiando ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCog className="w-4 h-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <OpcionesVista vistaActiva={vistaActiva} cambiar={cambiar} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Pill flotante: solo cuando hay una vista activa, para volver siempre al
// perfil real aunque la pantalla no tenga header (ej: vista paciente).
export function VistaRolSwitcher() {
  const [location] = useLocation();
  const { data: me } = useGetMe({ query: { retry: false } });
  const { cambiar, cambiando } = useCambiarVista();

  if (!me?.puedeCambiarVista) return null;
  if (RUTAS_EXCLUIDAS.some((r) => location.startsWith(r))) return null;

  const vistaActiva = me.vistaRol ?? null;
  if (!vistaActiva) return null;
  const vista = VISTAS.find((r) => r.valor === vistaActiva);

  return (
    <div className="fixed bottom-4 right-4 z-[100]" data-testid="vista-rol-switcher">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg border transition-colors bg-amber-500 text-white border-amber-600 hover:bg-amber-600"
            data-testid="button-vista-rol"
            disabled={cambiando}
          >
            {cambiando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            {`Viendo como ${vista?.emoji ?? ""} ${vista?.label ?? vistaActiva}`}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-60">
          <OpcionesVista vistaActiva={vistaActiva} cambiar={cambiar} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
