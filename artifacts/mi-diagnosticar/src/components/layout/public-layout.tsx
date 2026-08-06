import React from "react";
import { Link, useLocation } from "wouter";
import { CalendarIcon, CalendarPlus, LogOut } from "lucide-react";
import logoConectar from "@/assets/logo-diagnosticar-recortado.png";
import { AsistenteWidget } from "@/components/asistente-widget";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

const PATIENT_NAV = [
  { label: "Mis turnos", href: "/mi-turno", icon: CalendarIcon },
  { label: "Reservar", href: "/reservar", icon: CalendarPlus },
];

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const esPaciente = user?.rol === "paciente";

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col">
      <header className="bg-primary text-primary-foreground py-4 px-6 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center">
            <div className="bg-black rounded-md px-3 py-1.5">
              <img
                src={logoConectar}
                alt="Conectar by Diagnosticar"
                className="h-10"
                data-testid="img-logo-public"
              />
            </div>
          </div>
          {esPaciente && (
            <div className="flex items-center gap-1 sm:gap-2" data-testid="nav-paciente">
              <nav className="flex items-center gap-1">
                {PATIENT_NAV.map((item) => {
                  const active =
                    location === item.href || location.startsWith(`${item.href}/`);
                  return (
                    <Link key={item.href} href={item.href}>
                      <span
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${
                          active
                            ? "bg-primary-foreground/15 font-semibold"
                            : "text-primary-foreground/80 hover:bg-primary-foreground/10 hover:text-primary-foreground"
                        }`}
                      >
                        <item.icon className="w-4 h-4" />
                        <span className="hidden sm:inline">{item.label}</span>
                      </span>
                    </Link>
                  );
                })}
              </nav>
              <span className="hidden md:inline text-sm text-primary-foreground/80 max-w-[160px] truncate ml-2">
                {user?.nombre}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                title="Cerrar sesión"
                data-testid="button-logout-paciente"
                className="text-primary-foreground/80 hover:text-primary-foreground hover:bg-primary-foreground/10"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col p-4 md:p-8">
        <div className="max-w-5xl w-full mx-auto flex-1 flex flex-col">
          {children}
        </div>
      </main>

      <footer className="bg-card border-t py-6 px-6 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} Conectar &mdash; Red Clínica Digital.</p>
      </footer>

      <AsistenteWidget />
    </div>
  );
}
