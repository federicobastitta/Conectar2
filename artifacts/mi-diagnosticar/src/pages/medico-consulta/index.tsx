import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarDays, ScanSearch, ClipboardList, FileText, ChevronRight, TrendingUp, BookOpen, Smartphone, Video } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useAuth } from "@/hooks/use-auth";
import { AvisoRecepcionBoton, SeguridadConsultorioBoton } from "@/components/medico/aviso-recepcion";

const ACCESOS = [
  {
    titulo: "Agenda",
    descripcion: "Pacientes que tenés esperando",
    icon: CalendarDays,
    href: "/escritorio-medico",
    color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    iconBg: "bg-emerald-500/20",
  },
  {
    titulo: "Estudios",
    descripcion: "Estudios de imágenes (PACS)",
    icon: ScanSearch,
    href: "/estudios",
    color: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
    iconBg: "bg-sky-500/20",
  },
  {
    titulo: "Órdenes",
    descripcion: "Generar orden médica de baja o alta complejidad por DNI",
    icon: ClipboardList,
    href: "/ordenes/nueva",
    color: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20",
    iconBg: "bg-teal-500/20",
  },
  {
    titulo: "Mi Producción",
    descripcion: "Tu producción del mes: consultas y prácticas realizadas",
    icon: TrendingUp,
    href: "/consultorio?tab=produccion",
    color: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
    iconBg: "bg-indigo-500/20",
  },
  {
    titulo: "Consultas médicas",
    descripcion: "Asistente IA para dudas clínicas durante la consulta",
    icon: BookOpen,
    href: "/asistente-medico",
    color: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
    iconBg: "bg-rose-500/20",
  },
  {
    titulo: "Videollamada",
    descripcion: "Llamá a un paciente por video: le aparece al instante en su portal",
    icon: Video,
    href: "/videollamada",
    color: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
    iconBg: "bg-orange-500/20",
  },
  {
    titulo: "Certificados",
    descripcion: "Planilla de certificados médicos",
    icon: FileText,
    href: "/certificados",
    color: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
    iconBg: "bg-violet-500/20",
  },
];

export default function MedicoConsulta() {
  const { user } = useAuth();
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="titulo-medico-consulta">
          Consultorio{user?.nombre ? ` — ${user.nombre}` : ""}
        </h1>
        <p className="text-muted-foreground">
          {format(new Date(), "EEEE d 'de' MMMM, yyyy", { locale: es })}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {ACCESOS.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.href} href={a.href}>
              <Card
                className={`border cursor-pointer hover:shadow-md transition-all hover:-translate-y-0.5 ${a.color}`}
                data-testid={`boton-consulta-${a.titulo.toLowerCase()}`}
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className={`p-3 rounded-lg ${a.iconBg}`}>
                      <Icon className="w-7 h-7" />
                    </div>
                    <ChevronRight className="w-5 h-5 opacity-40" />
                  </div>
                  <div className="font-semibold text-lg leading-tight">{a.titulo}</div>
                  <div className="text-sm opacity-70 mt-1 leading-snug">{a.descripcion}</div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        <Link href="/mi-app">
          <Card
            className="border cursor-pointer hover:shadow-md transition-all hover:-translate-y-0.5 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20"
            data-testid="boton-consulta-mi-app"
          >
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="p-3 rounded-lg bg-cyan-500/20">
                  <Smartphone className="w-7 h-7" />
                </div>
                <ChevronRight className="w-5 h-5 opacity-40" />
              </div>
              <div className="font-semibold text-lg leading-tight">Mi App</div>
              <div className="text-sm opacity-70 mt-1 leading-snug">
                Llevá Conectar en tu celular: beneficios y QR para instalarla
              </div>
            </CardContent>
          </Card>
        </Link>
        <AvisoRecepcionBoton />
        <SeguridadConsultorioBoton />
      </div>
    </div>
  );
}
