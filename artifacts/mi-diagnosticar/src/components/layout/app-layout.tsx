import React, { useEffect, useState } from "react";
import logoConectar from "@/assets/logo-diagnosticar-recortado.png";
import whatsappGrupalImg from "@/assets/whatsapp-grupal.png";
import { AgentChat } from "@/components/agentes/AgentChat";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import {
  LayoutDashboard, Calendar, Users, Settings, LogOut, Loader2,
  Hospital, Import, Bell, MessageSquare, UsersRound, Bot, Clock, Stethoscope,
  ChevronDown, ChevronRight, Menu, Inbox, Wallet, ArrowLeftRight, Printer,
  Repeat, MapPin, ClipboardList, UserCircle, Search, Mail, MoreHorizontal, ScanSearch, Plus,
  ListChecks, FileSearch, ExternalLink, X, Smartphone, TrendingUp, CalendarDays
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actualizarFavicon } from "@/lib/favicon";
import { FaWhatsapp } from "react-icons/fa";
import { WhatsappManualDialog } from "@/components/whatsapp-manual-dialog";
import { CambiarClaveDialog } from "@/components/layout/cambiar-clave-dialog";
import { PedidosRecuperacionBanner } from "@/components/layout/pedidos-recuperacion-banner";
import { KeyRound, FileText, Star } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { TemaMenuItem } from "@/components/layout/tema-menu-item";
import { SalaEsperaBoton } from "@/components/recepcion/sala-espera-boton";
import { FrasePersonal } from "@/components/personalizacion/personalizacion-gate";
import { VistaRolHeaderButton } from "@/components/vista-rol-switcher";
import { DescansoBoton, SeguridadBoton } from "@/components/recepcion/descanso-boton";
import { WhaticketPanelBoton } from "@/components/whaticket-embed";
import { LinkIngresoGenerador } from "@/components/pacientes/link-ingreso-generador";
import { NovedadGeneradorLinkCinta } from "@/components/layout/novedad-generador-link";
import { AvisoRecepcionBoton } from "@/components/medico/aviso-recepcion";
import { MensajesMedicoBanner } from "@/components/medico/mensajes-recibidos";
import { EmergenciasBoton } from "@/components/recepcion/emergencias-boton";
import { AvisosPuestoBanner } from "@/components/recepcion/avisos-puesto-banner";
import { ChatFlotanteProvider } from "@/components/chat/chat-flotante";
import { FeedbackBurbuja, FeedbackHeaderBoton, FeedbackAvisoDesarrollador } from "@/components/feedback/feedback-burbuja";

type NavItem = {
  label: string;
  href?: string;
  icon: React.ElementType;
  roles: string[];
  badge?: string;
  children?: { label: string; href: string; badge?: string; roles?: string[]; oculto?: boolean }[];
  oculto?: boolean;
  boxed?: boolean;
};

// Menú lateral con la misma estructura que Klinicos (ACEAPP):
// Inicio · Pacientes · Ambulatorios · Gestión de turnos · Prestaciones ·
// Órdenes y Recetas · Reportes · Mensajes · (+ secciones propias de Conectar)
const NAV_ITEMS: NavItem[] = [
  { label: "Inicio", href: "/", icon: LayoutDashboard, roles: ["admin", "recepcionista", "medico"], boxed: true, oculto: true },
  { label: "Pacientes", href: "/pacientes", icon: Users, roles: ["admin", "recepcionista"], boxed: true, oculto: true },
  { label: "Ingresos", href: "/recepcion", icon: Inbox, roles: ["admin", "recepcionista"], boxed: true },
  {
    label: "Gestión de turnos",
    icon: Calendar,
    roles: ["admin", "recepcionista", "medico"],
    children: [
      { label: "Turnos vigentes", href: "/turnos" },
      { label: "Planilla diaria", href: "/turnos/tablero" },
      // Configuración de agendas: solo staff, un médico no gestiona agendas ajenas.
      { label: "Agendas", href: "/agendas", roles: ["admin", "recepcionista"] },
      { label: "Todas las agendas", href: "/agendas/todas", roles: ["admin", "recepcionista"] },
      { label: "Turneras", href: "/turneras", roles: ["admin", "recepcionista"] },
    ],
  },
  {
    label: "Prestaciones",
    icon: ClipboardList,
    roles: ["admin", "recepcionista"],
    children: [
      { label: "Caja", href: "/caja" },
      { label: "Entrada/Salida", href: "/entrada-salida" },
    ],
  },
  {
    label: "Mensajes",
    icon: MessageSquare,
    roles: ["admin", "recepcionista", "medico"],
    children: [
      { label: "Mensajería", href: "/mensajeria" },
      { label: "Notificaciones", href: "/notificaciones" },
    ],
  },
  { label: "Estudios", href: "/estudios", icon: ScanSearch, roles: ["admin", "recepcionista", "medico"] },
  { label: "Perfiles", href: "/perfiles", icon: UsersRound, roles: ["admin"], boxed: true },
  // Puntajes de médicos: exclusivo del perfil desarrollador (se filtra abajo).
  { label: "Puntajes", href: "/puntajes", icon: Star, roles: ["admin"], boxed: true },
  // Feedback de usuarios: bandeja exclusiva del perfil desarrollador (se filtra abajo).
  { label: "Feedback", href: "/feedback", icon: MessageSquare, roles: ["admin", "recepcionista", "medico"], boxed: true },
];

const NAV_ITEMS_DIAGNORED: NavItem[] = [];

// Matriz de accesos por perfil funcional. Los perfiles que no figuran acá
// (gerente, desarrollador o usuarios sin perfil) ven el menú completo según su rol.
const NAV_POR_PERFIL: Record<string, string[]> = {
  administracion: ["/agendas/todas"],
  administrador_caja: ["/agendas/todas", "/caja"],
  tecnico: ["/agendas", "/recepcion", "/estudios"],
  medico: [], // el médico trabaja en /consultorio (agenda, HCE y Mi Producción)
  medico_consulta: [], // trabaja desde /medico-consulta (Agenda, Estudios, Órdenes, Certificados)
  medico_informante: [], // trabaja desde la worklist de informes
  medico_consulta_informante: [], // combinado: agenda/consulta + worklist de informes
};

function filtrarPorPerfil(items: NavItem[], perfil: string | null | undefined): NavItem[] {
  // Perfiles es exclusivo del administrador y el desarrollador: el gerente no lo ve.
  if (perfil === "gerente") items = items.filter((i) => i.href !== "/perfiles");
  // Puntajes y la bandeja de Feedback son exclusivos del desarrollador.
  if (perfil !== "desarrollador") items = items.filter((i) => i.href !== "/puntajes" && i.href !== "/feedback");
  // El desarrollador ve Feedback siempre, aunque su perfil restrinja el resto del menú.
  if (perfil === "desarrollador") return items;
  if (!perfil || !(perfil in NAV_POR_PERFIL)) return items;
  const permitidos = new Set(NAV_POR_PERFIL[perfil]);
  return items
    .map((item) => {
      if (item.children) {
        const children = item.children.filter((c) => permitidos.has(c.href));
        return children.length > 0 ? { ...item, children } : null;
      }
      return item.href && permitidos.has(item.href) ? item : null;
    })
    .filter((i): i is NavItem => i !== null);
}

function MobileNavLink({ item, location, userRol, setOpen }: { item: NavItem; location: string; userRol: string; setOpen: (o: boolean) => void }) {
  const isActive = item.href
    ? item.href === "/"
      ? location === "/"
      : location.startsWith(item.href)
    : item.children?.some((c) => location === c.href || location.startsWith(c.href + "/")) ?? false;

  const [expanded, setExpanded] = useState(isActive);

  if (item.children) {
    const validChildren = item.children.filter((c) => !c.oculto && (!c.roles || c.roles.includes(userRol)));
    if (validChildren.length === 0) return null;

    return (
      <div className="flex flex-col mb-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className={`flex items-center justify-between px-4 py-3 rounded-md transition-colors ${
            expanded ? "bg-sidebar-accent text-white" : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50 hover:text-white"
          }`}
        >
          <div className="flex items-center gap-3">
            <item.icon className="w-5 h-5 opacity-80" />
            <span className="font-medium text-sm">{item.label}</span>
          </div>
          {expanded ? <ChevronDown className="w-4 h-4 opacity-60" /> : <ChevronRight className="w-4 h-4 opacity-60" />}
        </button>
        {expanded && (
          <div className="pl-12 pr-4 py-1 flex flex-col gap-1 border-l-2 border-sidebar-border ml-6 mt-1 mb-2">
            {validChildren.map((child) => {
              const childActive = location === child.href || (child.href !== "/" && location.startsWith(child.href));
              return (
                <Link key={child.href} href={child.href}>
                  <span
                    onClick={() => setOpen(false)}
                    className={`block py-2 text-sm transition-colors ${
                      childActive ? "text-primary font-semibold" : "text-sidebar-foreground/70 hover:text-white"
                    }`}
                  >
                    {child.label}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <Link href={item.href!}>
      <span
        onClick={() => setOpen(false)}
        className={`flex items-center gap-3 px-4 py-3 rounded-md mb-1 transition-colors cursor-pointer ${
          isActive ? "bg-primary/10 text-primary font-semibold" : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50 hover:text-white"
        }`}
      >
        <item.icon className="w-5 h-5 opacity-80" />
        <span className="font-medium text-sm">{item.label}</span>
      </span>
    </Link>
  );
}

function TopNavLink({ item, location, userRol, setLocation }: { item: NavItem; location: string; userRol: string; setLocation: (loc: string) => void }) {
  const isActive = item.href
    ? item.href === "/"
      ? location === "/"
      : location.startsWith(item.href)
    : item.children?.some((c) => location === c.href || location.startsWith(c.href + "/")) ?? false;

  if (item.children) {
    const validChildren = item.children.filter((c) => !c.oculto && (!c.roles || c.roles.includes(userRol)));
    if (validChildren.length === 0) return null;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={`flex items-center gap-1.5 px-3 h-14 text-[13px] font-medium transition-colors border-b-2 ${
              isActive 
                ? "border-primary text-white bg-sidebar-accent/30" 
                : "border-transparent text-sidebar-foreground/80 hover:text-white hover:border-sidebar-foreground/30 hover:bg-sidebar-accent/20"
            }`}
          >
            <item.icon className="w-4 h-4" />
            <span className="hidden xl:inline">{item.label}</span>
            <ChevronDown className="w-3 h-3 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="bg-sidebar border-sidebar-border text-sidebar-foreground min-w-[200px] shadow-lg">
          {validChildren.map((child) => {
            const childActive = location === child.href || (child.href !== "/" && location.startsWith(child.href));
            return (
              <DropdownMenuItem 
                key={child.href} 
                onClick={() => setLocation(child.href)}
                className={`cursor-pointer py-2 ${childActive ? 'bg-sidebar-accent font-semibold text-white' : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-white'}`}
              >
                {child.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Link href={item.href!}>
      <span
        className={`flex items-center gap-1.5 px-3 h-14 text-[13px] font-medium transition-colors border-b-2 cursor-pointer ${
          isActive 
            ? "border-primary text-white bg-sidebar-accent/30" 
            : "border-transparent text-sidebar-foreground/80 hover:text-white hover:border-sidebar-foreground/30 hover:bg-sidebar-accent/20"
        }`}
      >
        <item.icon className="w-4 h-4" />
        <span className="hidden xl:inline">{item.label}</span>
      </span>
    </Link>
  );
}

function TopDropdownNav({ item, location, userRol, setLocation }: { item: NavItem; location: string; userRol: string; setLocation: (loc: string) => void }) {
  if (item.children) {
    const validChildren = item.children.filter((c) => !c.oculto && (!c.roles || c.roles.includes(userRol)));
    if (validChildren.length === 0) return null;
    return (
      <div className="px-1 py-1">
        <div className="text-[10px] font-semibold text-sidebar-foreground/50 uppercase tracking-wider mb-1 px-2 pt-2">{item.label}</div>
        {validChildren.map((child) => {
          const childActive = location === child.href || (child.href !== "/" && location.startsWith(child.href));
          return (
            <DropdownMenuItem 
              key={child.href} 
              onClick={() => setLocation(child.href)} 
              className={`cursor-pointer py-2 ${childActive ? 'bg-sidebar-accent font-semibold text-white' : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-white'}`}
            >
              {child.label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator className="bg-sidebar-border" />
      </div>
    );
  }

  const isActive = item.href === "/" ? location === "/" : location.startsWith(item.href!);
  return (
    <>
      <DropdownMenuItem 
        onClick={() => setLocation(item.href!)} 
        className={`cursor-pointer py-2 mx-1 ${isActive ? 'bg-sidebar-accent font-semibold text-white' : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-white'}`}
      >
        <item.icon className="w-4 h-4 mr-2 opacity-70" />
        {item.label}
      </DropdownMenuItem>
      <DropdownMenuSeparator className="bg-sidebar-border" />
    </>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [whatsappAbierto, setWhatsappAbierto] = useState(false);
  const [asistenteAbierto, setAsistenteAbierto] = useState(false);
  const [cambiarClaveAbierto, setCambiarClaveAbierto] = useState(false);
  const [pixelWorklistAbierto, setPixelWorklistAbierto] = useState(false);
  const [pixelWorklistUrl, setPixelWorklistUrl] = useState<string | null>(null);
  const [pixelWorklistError, setPixelWorklistError] = useState<string | null>(null);

  // Al abrir el panel pedimos un enlace firmado fresco (entra sin login de Pixel).
  useEffect(() => {
    if (!pixelWorklistAbierto) return;
    let cancelado = false;
    setPixelWorklistUrl(null);
    setPixelWorklistError(null);
    fetch("/api/pacs/worklist-portal-link", {
      headers: { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` },
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? "No se pudo generar el enlace a la worklist");
        if (!cancelado) setPixelWorklistUrl(body.url as string);
      })
      .catch((e: unknown) => {
        if (!cancelado) setPixelWorklistError(e instanceof Error ? e.message : "Error al pedir el enlace");
      });
    return () => {
      cancelado = true;
    };
  }, [pixelWorklistAbierto]);

  // Si el usuario navega a otra pantalla (cualquier botón del menú), el panel
  // de la worklist se cierra solo; si no, tapa la pantalla nueva.
  useEffect(() => {
    setPixelWorklistAbierto(false);
  }, [location]);

  useEffect(() => {
    if (!isLoading && user?.rol === "paciente") {
      setLocation("/mi-turno");
    }
    // Recepcionista (sin perfil funcional especial): arranca en la agenda por médico
    if (!isLoading && user?.rol === "recepcionista" && !user?.perfil && location === "/") {
      setLocation("/recepcion/agenda-medico");
    }
    // Todos los perfiles médicos arrancan en "Mi agenda".
    if (!isLoading && user?.rol === "medico" && location === "/") {
      setLocation("/recepcion/agenda-medico");
    }
  }, [user, isLoading, location, setLocation]);

  // Favicon según el tipo de usuario logueado (médico blanco, recepción verde, desarrollador rojo).
  useEffect(() => {
    actualizarFavicon(user?.rol, (user as { perfil?: string | null } | undefined)?.perfil ?? null);
  }, [user]);

  // PWA instalada + perfil desarrollador = app "solo chat de Feedback":
  // no importa desde qué pantalla se haya agregado el ícono ni el start_url.
  // OJO: este efecto debe declararse ANTES de cualquier return temprano
  // (reglas de hooks de React); si no, la app entera queda en blanco.
  const perfilUsuario = (user as { perfil?: string | null } | undefined)?.perfil ?? null;
  const esStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  useEffect(() => {
    if (esStandalone && perfilUsuario === "desarrollador" && location !== "/feedback") {
      sessionStorage.setItem("feedback_solo", "1");
      setLocation("/feedback");
    }
  }, [esStandalone, perfilUsuario, location, setLocation]);

  if (isLoading || user?.rol === "paciente" || !user) {
    return (
      <div className="h-[100dvh] w-full flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const perfil = (user as { perfil?: string | null }).perfil ?? null;
  const perfilRestringido = perfil !== null && perfil in NAV_POR_PERFIL;
  const visibleItems = filtrarPorPerfil(
    NAV_ITEMS.filter((item) => !item.oculto && item.roles.includes(user.rol)),
    perfil,
  );
  
  // Dividimos ítems: hasta 6 en la barra principal, resto en menú "Más"
  const mainNavItems = visibleItems.slice(0, 6);
  const overflowNavItems = visibleItems.slice(6);

  return (
    <ChatFlotanteProvider>
      <div className="min-h-[100dvh] w-full flex flex-col bg-background">
        {/* Top Bar Header */}
        <header className="sticky top-0 h-14 bg-sidebar border-b border-sidebar-border flex items-center justify-between px-3 md:px-6 shrink-0 z-30">
          <div className="flex items-center h-full min-w-0 overflow-hidden">
            {/* Mobile Menu */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className={`lg:hidden text-sidebar-foreground hover:bg-sidebar-accent mr-2 ${user.rol === "recepcionista" ? "hidden" : ""}`}>
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 bg-sidebar border-sidebar-border p-0 flex flex-col">
                <SheetTitle className="sr-only">Navegación</SheetTitle>
                <div className="h-14 flex items-center px-6 bg-sidebar-accent/50 shrink-0 border-b border-sidebar-border">
                  <div className="flex flex-col leading-none">
                    <span className="text-lg font-bold tracking-wide text-white">CONECTAR</span>
                    <span className="text-[10px] text-sidebar-foreground/60 tracking-widest mt-0.5">by Diagnosticar</span>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto py-4 px-3">
                  {visibleItems.map((item) => (
                    <MobileNavLink key={item.label} item={item} location={location} userRol={user.rol} setOpen={setMobileOpen} />
                  ))}
                </div>
              </SheetContent>
            </Sheet>

            {/* Logo */}
            <Link href="/">
              <div className="flex items-center cursor-pointer hover:opacity-80 transition-opacity mr-6 md:mr-10">
                <div className="bg-black rounded-md px-3 py-1.5">
                  <img
                    src={logoConectar}
                    alt="Conectar by Diagnosticar"
                    className="h-10"
                    data-testid="img-logo-header"
                  />
                </div>
              </div>
            </Link>

            {/* Desktop Nav — recepción trabaja solo con los accesos rápidos de colores */}
            <nav className={`hidden ${user.rol === "recepcionista" ? "" : "lg:flex"} items-center h-full`}>
              {mainNavItems.map((item) => (
                <TopNavLink key={item.label} item={item} location={location} userRol={user.rol} setLocation={setLocation} />
              ))}
              
              {overflowNavItems.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1.5 px-3 h-14 text-[13px] font-medium transition-colors border-b-2 border-transparent text-sidebar-foreground/80 hover:text-white hover:border-sidebar-foreground/30 hover:bg-sidebar-accent/20">
                      <MoreHorizontal className="w-4 h-4" />
                      <span>Más</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-sidebar border-sidebar-border text-sidebar-foreground min-w-[220px] shadow-lg max-h-[calc(100vh-4rem)] overflow-y-auto">
                    {overflowNavItems.map((item, i) => (
                      <TopDropdownNav key={item.label} item={item} location={location} userRol={user.rol} setLocation={setLocation} />
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </nav>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-1 md:gap-2 shrink-0">
            <FrasePersonal />
            <VistaRolHeaderButton />
            {/* Botón "+" (nuevo turno) oculto para todos los usuarios a pedido
                del usuario (jul 2026). Para volver a mostrarlo, cambiar
                `false &&` por la condición original. */}
            {false && (user?.rol === "admin" || user?.rol === "recepcionista") && perfil !== "tecnico" && (
              <Link href="/turnos/nuevo">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/30 hover:text-emerald-200 ring-1 ring-emerald-400/30"
                  title="Cargar nuevo turno"
                  data-testid="boton-header-nuevo-turno"
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </Link>
            )}
            {/* Botón de Recepción (bandeja violeta) oculto para todos los usuarios
                a pedido del usuario (jul 2026). Para volver a mostrarlo,
                cambiar `false &&` por la condición original. */}
            {false && (user?.rol === "admin" || user?.rol === "recepcionista") && perfil !== "tecnico" && (
              <Link href="/recepcion">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 rounded-lg bg-violet-500/15 text-violet-300 hover:bg-violet-500/30 hover:text-violet-200 ring-1 ring-violet-400/30"
                  title="Recepción de pacientes"
                  data-testid="boton-header-recepcion"
                >
                  <Inbox className="w-4 h-4" />
                </Button>
              </Link>
            )}
            {(user.rol === "admin" || user.rol === "recepcionista" || user.rol === "medico") && perfil !== "tecnico" && perfil !== "medico_informante" && (
              <Link href="/recepcion/agenda-medico">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 hover:text-white ring-1 ring-indigo-400/60"
                  title="Agenda por médico"
                  data-testid="boton-header-agenda-por-medico"
                >
                  <CalendarDays className="w-4 h-4" />
                </Button>
              </Link>
            )}
            {/* Botón de worklist del PACS (Pixel) oculto para todos los usuarios
                a pedido del usuario (jul 2026). Para volver a mostrarlo,
                descomentar este bloque. */}
            {false && (
              <Button
                variant="ghost"
                size="icon"
                className="relative h-9 w-9 rounded-lg bg-fuchsia-500/15 text-fuchsia-300 hover:bg-fuchsia-500/30 hover:text-fuchsia-200 ring-1 ring-fuchsia-400/30"
                title="Worklist del PACS (Pixel)"
                data-testid="boton-header-pixel-worklist"
                onClick={() => setPixelWorklistAbierto((v) => !v)}
              >
                <ListChecks className="w-4 h-4" />
              </Button>
            )}
            {(
              <a
                href="https://medical-vision-ai.replit.app/"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 hover:text-white ring-1 ring-cyan-400/60"
                  title="Informes y estudios del PACS (Pixel)"
                  data-testid="boton-header-pixel-informes"
                >
                  <FileSearch className="w-4 h-4" />
                </Button>
              </a>
            )}
            {/* Órdenes médicas: también para el perfil Técnico (pedido jul 2026,
                para que puedan asignar turnos a las órdenes). */}
            {(user.rol === "admin" || user.rol === "recepcionista") && (
              <Link href="/ordenes">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 rounded-lg bg-teal-600 text-white hover:bg-teal-500 hover:text-white ring-1 ring-teal-400/60"
                  title="Órdenes médicas"
                  data-testid="boton-header-ordenes"
                >
                  <ClipboardList className="w-4 h-4" />
                </Button>
              </Link>
            )}
            {/* Botón del asistente IA oculto a pedido del usuario (jul 2026):
                el chat no funcionaba bien. Para restaurarlo, quitar `false &&`. */}
            {false && perfil !== "medico_informante" && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "relative h-9 w-9 rounded-lg ring-1 transition-colors",
                  asistenteAbierto
                    ? "bg-violet-500/30 text-violet-100 ring-violet-300/50"
                    : "bg-violet-500/15 text-violet-300 hover:bg-violet-500/30 hover:text-violet-200 ring-violet-400/30",
                )}
                title="Asistente IA"
                data-testid="boton-header-asistente"
                onClick={() => setAsistenteAbierto((v) => !v)}
              >
                <Bot className="w-4 h-4" />
              </Button>
            )}
            {/* Acceso directo a Pacientes para todos (pedido del usuario) */}
            <Link href="/pacientes">
              <Button
                variant="ghost"
                size="icon"
                className="relative h-9 w-9 rounded-lg bg-amber-500 text-white hover:bg-amber-400 hover:text-white ring-1 ring-amber-300/60"
                title="Pacientes"
                data-testid="boton-header-pacientes"
              >
                <Users className="w-4 h-4" />
              </Button>
            </Link>
            {perfil !== "medico_informante" && (
              <Button
                variant="ghost"
                size="icon"
                className="relative h-9 w-9 rounded-lg bg-green-600 text-white hover:bg-green-500 hover:text-white ring-1 ring-green-400/60"
                title="Enviar WhatsApp a un paciente"
                data-testid="boton-header-notificaciones"
                onClick={() => setWhatsappAbierto(true)}
              >
                <FaWhatsapp className="w-4 h-4" />
              </Button>
            )}
            {(user.rol === "admin" || user.rol === "recepcionista") && perfil !== "tecnico" && (
              <Link href="/mensajeria">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 rounded-lg overflow-hidden p-0 ring-1 ring-green-400/60 hover:opacity-90"
                  title="Notificaciones grupales"
                  data-testid="boton-header-notificaciones-grupales"
                >
                  {/* Imagen elegida por el usuario para el WhatsApp grupal (ago 2026) */}
                  <img src={whatsappGrupalImg} alt="WhatsApp grupal" className="h-full w-full object-cover" />
                </Button>
              </Link>
            )}
            {(user.rol === "admin" || user.rol === "recepcionista") && perfil !== "tecnico" && (
              <SalaEsperaBoton modo="icono" />
            )}
            {user.rol === "admin" && !perfilRestringido && (
              <Link href="/consultorio">
                <Button variant="ghost" size="icon" className="relative h-9 w-9 rounded-lg bg-blue-600 text-white hover:bg-blue-500 hover:text-white ring-1 ring-blue-400/60" title="Consultorio">
                  <Stethoscope className="w-4 h-4" />
                </Button>
              </Link>
            )}
            {user.rol === "admin" && !perfilRestringido && (
              <Link href="/configuracion">
                <Button variant="ghost" size="icon" className="relative h-9 w-9 rounded-lg bg-purple-600 text-white hover:bg-purple-500 hover:text-white ring-1 ring-purple-400/60 hidden sm:inline-flex" title="Configuración">
                  <Settings className="w-4 h-4" />
                </Button>
              </Link>
            )}
            {(user.rol === "admin" || user.rol === "recepcionista") && perfil !== "tecnico" && (
              <>
                <LinkIngresoGenerador variante="header" />
                <WhaticketPanelBoton />
                <DescansoBoton />
                <SeguridadBoton />
                <EmergenciasBoton />
              </>
            )}
            {perfil === "tecnico" && (
              <>
                <Link href="/estudios">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative h-9 w-9 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 hover:text-white ring-1 ring-cyan-400/60"
                    title="Estudios (estados y carga de informes)"
                    data-testid="boton-header-estudios-tecnico"
                  >
                    <ScanSearch className="w-4 h-4" />
                  </Button>
                </Link>
                <AvisoRecepcionBoton variante="header" />
                <SeguridadBoton />
              </>
            )}
            {user.rol === "medico" && perfil !== "tecnico" && (
              <>
                {perfil !== "medico_informante" && (
                  <Link href="/consultorio">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative h-9 w-9 rounded-lg bg-sky-600 text-white hover:bg-sky-500 hover:text-white ring-1 ring-sky-400/60"
                      title="Mi agenda del día (pacientes en espera)"
                      data-testid="boton-header-agenda-medico"
                    >
                      <Calendar className="w-4 h-4" />
                    </Button>
                  </Link>
                )}
                {perfil === "medico_consulta_informante" && (
                  <Link href="/worklist">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative h-9 w-9 rounded-lg bg-teal-600 text-white hover:bg-teal-500 hover:text-white ring-1 ring-teal-400/60"
                      title="Worklist de informes"
                      data-testid="boton-header-worklist"
                    >
                      <FileText className="w-4 h-4" />
                    </Button>
                  </Link>
                )}
                <Link href="/consultorio?tab=produccion">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative h-9 w-9 rounded-lg bg-violet-600 text-white hover:bg-violet-500 hover:text-white ring-1 ring-violet-400/60"
                    title="Mi Producción (consultas, pedidos y sus estados)"
                    data-testid="boton-header-mi-produccion"
                  >
                    <TrendingUp className="w-4 h-4" />
                  </Button>
                </Link>
                <Link href="/mi-app">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative h-9 w-9 rounded-lg bg-green-600 text-white hover:bg-green-500 hover:text-white ring-1 ring-green-400/60"
                    title="Conectar en tu celular (instalar la app)"
                    data-testid="boton-header-mi-app"
                  >
                    <Smartphone className="w-4 h-4" />
                  </Button>
                </Link>
                <AvisoRecepcionBoton variante="header" />
                <SeguridadBoton />
              </>
            )}
            {user.rol !== "recepcionista" && user.rol !== "medico" && (
              <>
                <Button variant="ghost" size="icon" className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-white h-9 w-9 hidden sm:inline-flex">
                  <Search className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-white h-9 w-9">
                  <Bell className="w-4 h-4" />
                </Button>
              </>
            )}
            {/* Asistencia: mensaje directo al desarrollador (todos menos él) */}
            {perfil !== "desarrollador" && <FeedbackHeaderBoton />}

            <div className="h-6 w-px bg-sidebar-border mx-1 md:mx-2 hidden sm:block"></div>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 pl-2 pr-1 py-1 hover:bg-sidebar-accent/50 rounded-md transition-colors ml-1">
                  <div className="hidden sm:block text-right leading-none max-w-[140px]">
                    <div className="text-[13px] font-medium text-white truncate">{user.nombre}</div>
                    <div className="text-[11px] text-sidebar-foreground/60 capitalize mt-0.5">{user.rol}</div>
                  </div>
                  <UserCircle className="w-8 h-8 text-sidebar-foreground/70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="flex items-center justify-start gap-2 p-2 sm:hidden">
                  <div className="flex flex-col space-y-1 leading-none">
                    <p className="font-medium text-sm">{user.nombre}</p>
                    <p className="text-xs text-muted-foreground capitalize">{user.rol}</p>
                  </div>
                </div>
                <DropdownMenuSeparator className="sm:hidden" />
                <DropdownMenuItem className="cursor-pointer">
                  <UserCircle className="mr-2 h-4 w-4" />
                  <span>Mi Perfil</span>
                </DropdownMenuItem>
                <TemaMenuItem />
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => setCambiarClaveAbierto(true)}
                  data-testid="menu-cambiar-clave"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  <span>Cambiar contraseña</span>
                </DropdownMenuItem>
                {(user.rol === "admin" || user.rol === "recepcionista") && !perfilRestringido && (
                  <DropdownMenuItem className="cursor-pointer sm:hidden" onClick={() => setLocation("/configuracion")}>
                    <Settings className="mr-2 h-4 w-4" />
                    <span>Configuración</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-red-500 focus:text-red-500 cursor-pointer">
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Cerrar Sesión</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <CambiarClaveDialog open={cambiarClaveAbierto} onOpenChange={setCambiarClaveAbierto} />
          </div>
        </header>

        {/* Cinta de novedad: generador de link con autologin (admin y recepción) */}
        {(user.rol === "admin" || user.rol === "recepcionista") && <NovedadGeneradorLinkCinta />}

        {/* Pedidos de "olvidé mi contraseña" (solo admin) */}
        {user.rol === "admin" && <PedidosRecuperacionBanner />}

        {/* Avisos de puesto (descansos / asistencia) para todo el staff */}
        <AvisosPuestoBanner />

        {/* Mensajes dirigidos de recepción/administración al médico */}
        {user.rol === "medico" && <MensajesMedicoBanner />}

        {/* Main Content Area */}
        <main className="flex-1 bg-background">
          <div className="mx-auto max-w-[1600px] w-full p-4 md:p-6 lg:p-8 min-h-full">
            {children}
          </div>
        </main>
      </div>
      {/* Asistente IA: se abre desde el botón del header (sin botón flotante). */}
      {asistenteAbierto && (
        <AgentChat
          frasesGraciosas={user.rol === "medico"}
          inicialAbierto
          onCerrar={() => setAsistenteAbierto(false)}
        />
      )}
      <WhatsappManualDialog open={whatsappAbierto} onOpenChange={setWhatsappAbierto} />
      {/* Panel embebido de la worklist de Pixel: se abre debajo del header,
          así el menú de Conectar queda siempre visible. */}
      {pixelWorklistAbierto && (
        <div className="fixed inset-x-0 top-14 bottom-0 z-40 bg-background flex flex-col" data-testid="panel-pixel-worklist">
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/50">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ListChecks className="w-4 h-4 text-fuchsia-500" />
              Worklist del PACS (Pixel)
            </div>
            <div className="flex items-center gap-1">
              {pixelWorklistUrl && (
                <a href={pixelWorklistUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="sm" className="h-8 gap-1.5" data-testid="boton-pixel-worklist-pestana">
                    <ExternalLink className="w-3.5 h-3.5" />
                    Abrir en pestaña nueva
                  </Button>
                </a>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="Cerrar"
                data-testid="boton-cerrar-pixel-worklist"
                onClick={() => setPixelWorklistAbierto(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
          {pixelWorklistUrl ? (
            <iframe
              src={pixelWorklistUrl}
              title="Worklist del PACS (Pixel)"
              className="flex-1 w-full border-0"
              data-testid="iframe-pixel-worklist"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              {pixelWorklistError ?? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generando acceso a la worklist…
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {/* Burbuja roja de feedback: todos los usuarios hablan directo con
          desarrollo; el desarrollador tiene su bandeja en el menú (/feedback). */}
      {perfil !== "desarrollador" && <FeedbackBurbuja />}
      {/* Pop-up para el desarrollador cada vez que le llega un mensaje nuevo */}
      {perfil === "desarrollador" && (
        <FeedbackAvisoDesarrollador onIrABandeja={() => setLocation("/feedback")} />
      )}
    </ChatFlotanteProvider>
  );
}
