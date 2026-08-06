// Ítem del menú de usuario para cambiar el tema (claro/oscuro/automático).
// Disponible para todos los roles; usa la misma clave localStorage "theme"
// que la tarjeta Apariencia de Configuración.
import { useState } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Sun, Moon, Monitor } from "lucide-react";

const ORDEN = ["light", "dark", "auto"] as const;

export function aplicarTema(tema: string) {
  localStorage.setItem("theme", tema);
  const dark =
    tema === "dark" ||
    (tema === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function TemaMenuItem() {
  const [tema, setTema] = useState(() => localStorage.getItem("theme") || "dark");

  const siguiente = ORDEN[(ORDEN.indexOf(tema as (typeof ORDEN)[number]) + 1) % ORDEN.length] ?? "light";

  const meta: Record<string, { label: string; Icon: typeof Sun }> = {
    light: { label: "Tema: Claro", Icon: Sun },
    dark: { label: "Tema: Oscuro", Icon: Moon },
    auto: { label: "Tema: Automático", Icon: Monitor },
  };
  const { label, Icon } = meta[tema] ?? meta.light;

  return (
    <DropdownMenuItem
      className="cursor-pointer"
      data-testid="menu-tema"
      onSelect={(e) => {
        e.preventDefault(); // no cerrar el menú: permite seguir cambiando
        setTema(siguiente);
        aplicarTema(siguiente);
      }}
    >
      <Icon className="mr-2 h-4 w-4" />
      <span>{label}</span>
    </DropdownMenuItem>
  );
}
