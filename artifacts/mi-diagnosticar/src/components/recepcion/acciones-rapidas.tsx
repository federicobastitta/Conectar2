import { Link, useLocation } from "wouter";
import {
  useListTurnos,
  useGetColaSalaEspera,
  useListSolicitudes,
  useGetRecepcionOrdenesPendientes,
} from "@workspace/api-client-react";
import { ahoraArgentina } from "@/lib/agenda";
import {
  Plus, LogIn, CalendarDays, Users, Armchair, Inbox, LayoutGrid, Activity, ClipboardList,
} from "lucide-react";

type Accion = {
  href: string;
  label: string;
  icon: typeof Plus;
  destacada?: boolean;
  contador?: number;
};

export function AccionesRapidas() {
  const [location] = useLocation();
  const hoy = ahoraArgentina().fecha;

  const { data: turnosHoy } = useListTurnos(
    { fecha: hoy, limit: 1 },
    { query: { refetchInterval: 60000 } },
  );
  const { data: cola } = useGetColaSalaEspera(
    {},
    { query: { refetchInterval: 30000 } },
  );
  const { data: solicitudes } = useListSolicitudes(
    { estado: "pendiente_validacion" },
    { query: { refetchInterval: 60000 } },
  );
  // Órdenes pedidas por los médicos que todavía no tienen turno asignado.
  // Solo admin/recepcionista pueden consultarlas; si falla, no molesta.
  const { data: ordenesMedicos } = useGetRecepcionOrdenesPendientes({
    query: { refetchInterval: 60000, retry: false },
  });
  const ordenesSinTurno = ordenesMedicos?.filter((o) => o.turnoId == null).length;

  const acciones: Accion[] = [
    { href: "/turnos/nuevo", label: "Nuevo turno", icon: Plus, destacada: true },
    { href: "/recepcion", label: "Recepción", icon: LogIn, contador: turnosHoy?.total },
    { href: "/admision", label: "Sala de espera", icon: Armchair, contador: cola?.length },
    { href: "/recepcion/solicitudes", label: "Solicitudes", icon: Inbox, contador: solicitudes?.length },
    { href: "/ordenes", label: "Órdenes", icon: ClipboardList, contador: ordenesSinTurno },
    { href: "/agendas/todas", label: "Agendas", icon: CalendarDays },
    { href: "/agendas", label: "Atendiendo ahora", icon: Activity },
    { href: "/pacientes", label: "Pacientes", icon: Users },
    { href: "/turnos/tablero", label: "Tablero", icon: LayoutGrid },
  ];

  return (
    <div
      className="grid grid-cols-3 sm:grid-cols-9 gap-2"
      data-testid="acciones-rapidas"
    >
      {acciones.map(({ href, label, icon: Icon, destacada, contador }) => {
        const activa = location === href;
        return (
          <Link key={href} href={href}>
            <button
              className={`relative w-full flex flex-col items-center justify-center gap-1.5 rounded-lg border px-2 py-3 text-center transition-colors ${
                destacada
                  ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                  : activa
                    ? "bg-secondary border-primary/40"
                    : "bg-card hover:bg-muted/60"
              }`}
              data-testid={`accion-rapida-${href.replace(/\//g, "-").slice(1)}`}
            >
              {contador !== undefined && contador > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center border-2 border-background">
                  {contador > 99 ? "99+" : contador}
                </span>
              )}
              <Icon className={`w-5 h-5 ${destacada ? "" : "text-primary"}`} />
              <span className="text-[11px] font-medium leading-tight">{label}</span>
            </button>
          </Link>
        );
      })}
    </div>
  );
}
