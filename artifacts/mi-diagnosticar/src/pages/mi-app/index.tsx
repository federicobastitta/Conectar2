import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent } from "@/components/ui/card";
import {
  CalendarDays,
  BellRing,
  ShieldAlert,
  TrendingUp,
  Video,
  Wifi,
  Zap,
  Smartphone,
  Share,
  MoreVertical,
} from "lucide-react";
import iconoConectar from "@/assets/icono-conectar.png";

const URL_APP = "https://clinic-core-suite.replit.app/login";

const BENEFICIOS = [
  {
    icon: CalendarDays,
    titulo: "Tu agenda en el bolsillo",
    detalle: "Ves los pacientes que tenés esperando en tiempo real, estés donde estés.",
    color: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/15",
  },
  {
    icon: BellRing,
    titulo: "Avisos a recepción con un toque",
    detalle: "Pedí una pausa, hacé pasar al próximo o pedí tu café sin levantar el teléfono.",
    color: "text-amber-600 dark:text-amber-400 bg-amber-500/15",
  },
  {
    icon: ShieldAlert,
    titulo: "Botón de seguridad siempre a mano",
    detalle: "Alerta silenciosa a recepción y seguridad desde el celular.",
    color: "text-red-600 dark:text-red-400 bg-red-500/15",
  },
  {
    icon: TrendingUp,
    titulo: "Mi Producción al día",
    detalle: "Consultas y prácticas del mes, sin esperar a fin de mes ni pedir reportes.",
    color: "text-indigo-600 dark:text-indigo-400 bg-indigo-500/15",
  },
  {
    icon: Zap,
    titulo: "Pantalla completa, como una app",
    detalle: "Se instala con su propio ícono, sin barra del navegador. Un toque y adentro.",
    color: "text-cyan-600 dark:text-cyan-400 bg-cyan-500/15",
  },
  {
    icon: Video,
    titulo: "Videollamadas con tus pacientes",
    detalle: "Atendé consultas a distancia por videollamada, directo desde la app.",
    color: "text-violet-600 dark:text-violet-400 bg-violet-500/15",
  },
  {
    icon: Wifi,
    titulo: "Abre aunque se corte internet",
    detalle: "Si se cae la conexión, la app abre igual con lo último cargado.",
    color: "text-sky-600 dark:text-sky-400 bg-sky-500/15",
  },
];

export default function MiApp() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <div className="flex items-center gap-4">
        <img
          src={iconoConectar}
          alt="Conectar"
          className="w-16 h-16 rounded-2xl shadow-md"
        />
        <div>
          <h1 className="text-2xl font-bold" data-testid="titulo-mi-app">
            Conectar en tu celular
          </h1>
          <p className="text-muted-foreground">
            Tu consultorio te acompaña a donde vayas
          </p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-2 content-start">
          {BENEFICIOS.map((b) => {
            const Icon = b.icon;
            return (
              <Card key={b.titulo} className="border">
                <CardContent className="p-4 flex gap-3">
                  <div className={`p-2.5 rounded-lg h-fit ${b.color}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-semibold leading-tight">{b.titulo}</div>
                    <div className="text-sm text-muted-foreground mt-0.5 leading-snug">
                      {b.detalle}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card className="border-2 border-primary/30 h-fit md:sticky md:top-6">
          <CardContent className="p-6 flex flex-col items-center text-center gap-4">
            <div className="font-semibold text-lg flex items-center gap-2">
              <Smartphone className="w-5 h-5" />
              Escaneá y entrá
            </div>
            <div className="bg-white p-4 rounded-xl">
              <QRCodeSVG value={URL_APP} size={200} level="M" data-testid="qr-mi-app" />
            </div>
            <p className="text-sm text-muted-foreground max-w-[240px]">
              Apuntá la cámara del teléfono al código: te lleva directo al login de Conectar.
            </p>
            <div className="text-xs text-muted-foreground space-y-1.5 text-left w-full border-t pt-3">
              <p className="flex items-start gap-1.5">
                <MoreVertical className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">Android:</span> tocá
                  "Instalar app" o "Agregar a pantalla de inicio".
                </span>
              </p>
              <p className="flex items-start gap-1.5">
                <Share className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">iPhone:</span> botón
                  compartir → "Agregar a inicio".
                </span>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
