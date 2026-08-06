import { useState, useEffect } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Stethoscope, FileText, Users, Clock, CheckCircle, RefreshCcw, LogIn,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getEstadoMeta } from "@/lib/episodio";
import { useGetMe } from "@workspace/api-client-react";

type EpisodioRow = {
  id: number;
  horaInicio: string;
  estado: string;
  motivoConsulta?: string | null;
  paciente?: { id: number; nombre: string; apellido: string; dni?: string | null } | null;
  profesional?: { nombre: string; apellido: string } | null;
  informe?: {
    id: number;
    estado: string;
    firmadoEn?: string | null;
  } | null;
};

async function fetchEpisodios(url: string): Promise<EpisodioRow[]> {
  const r = await fetch(url, {
    credentials: "include",
    headers: { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` },
  });
  if (!r.ok) return [];
  return r.json() as Promise<EpisodioRow[]>;
}

export default function Worklist() {
  const { toast } = useToast();
  const hoy = format(new Date(), "yyyy-MM-dd");
  const [loading, setLoading] = useState(true);
  const [espera, setEspera] = useState<EpisodioRow[]>([]);
  const [bandeja, setBandeja] = useState<EpisodioRow[]>([]);
  const [cambiando, setCambiando] = useState<number | null>(null);
  const [vista, setVista] = useState<"asignados" | "modalidad">("asignados");
  const { data: me } = useGetMe({ query: { retry: false } });
  const esMedico = me?.rol === "medico";

  const cargar = async (vistaActual: "asignados" | "modalidad" = vista) => {
    setLoading(true);
    try {
      const vistaParam = vistaActual === "modalidad" ? "&vista=modalidad" : "";
      const [turnosHoy, bandejaData] = await Promise.all([
        fetchEpisodios(`/api/turnos?fecha=${hoy}&limit=100`),
        fetchEpisodios(`/api/informes/bandeja?fecha=${hoy}${vistaParam}`),
      ]);
      const enEspera = (
        Array.isArray(turnosHoy)
          ? turnosHoy
          : (turnosHoy as { data?: EpisodioRow[] }).data ?? []
      ).filter((t) => ["arribo", "llamado"].includes(t.estado));
      setEspera(enEspera.sort((a, b) => a.horaInicio.localeCompare(b.horaInicio)));
      setBandeja(bandejaData.sort((a, b) => a.horaInicio.localeCompare(b.horaInicio)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void cargar(); }, []);

  const cambiarEstado = async (turnoId: number, nuevoEstado: string) => {
    setCambiando(turnoId);
    try {
      const r = await fetch(`/api/turnos/${turnoId}/estado`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
        },
        credentials: "include",
        body: JSON.stringify({ estado: nuevoEstado }),
      });
      if (!r.ok) {
        const err = await r.json() as { error?: string };
        toast({ title: "Error", description: err.error, variant: "destructive" });
        return;
      }
      await cargar();
    } finally {
      setCambiando(null);
    }
  };

  const fechaLabel = format(new Date(hoy + "T00:00:00"), "EEEE d 'de' MMMM", { locale: es });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Stethoscope className="w-6 h-6 text-primary" />
            Worklist
          </h1>
          <p className="text-muted-foreground text-sm capitalize">{fechaLabel}</p>
        </div>
        <Button variant="outline" onClick={() => void cargar()} size="sm">
          <RefreshCcw className="w-4 h-4 mr-1" /> Actualizar
        </Button>
      </div>

      <Tabs defaultValue="espera">
        <TabsList>
          <TabsTrigger value="espera" className="flex items-center gap-1.5">
            <Users className="w-4 h-4" />
            Sala de espera
            {espera.length > 0 && (
              <Badge className="ml-1 h-5 w-5 p-0 text-xs flex items-center justify-center">
                {espera.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="bandeja" className="flex items-center gap-1.5">
            <FileText className="w-4 h-4" />
            Bandeja de informes
            {bandeja.length > 0 && (
              <Badge variant="destructive" className="ml-1 h-5 w-5 p-0 text-xs flex items-center justify-center">
                {bandeja.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Sala de espera ── */}
        <TabsContent value="espera" className="mt-4">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : espera.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground border rounded-lg">
              <Users className="w-10 h-10 opacity-20" />
              <p>No hay pacientes esperando ahora</p>
            </div>
          ) : (
            <div className="space-y-2">
              {espera.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-4 border rounded-lg bg-amber-50/50 border-amber-200 hover:bg-amber-50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="text-center min-w-[48px]">
                      <div className="font-mono font-bold text-base">{t.horaInicio.substring(0, 5)}</div>
                      <div className="text-[10px] text-muted-foreground">hora</div>
                    </div>
                    <div className="w-px h-10 bg-amber-200" />
                    <div>
                      <div className="font-semibold text-base leading-tight">
                        {t.paciente
                          ? `${t.paciente.apellido}, ${t.paciente.nombre}`
                          : "Paciente desconocido"}
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2">
                        {t.paciente?.dni && <span>DNI {t.paciente.dni}</span>}
                        {t.motivoConsulta && <span>· {t.motivoConsulta}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge estado={t.estado} />
                    <Button
                      size="sm"
                      disabled={cambiando === t.id}
                      onClick={() => void cambiarEstado(t.id, "en_atencion")}
                    >
                      <Stethoscope className="w-4 h-4 mr-1" />
                      Iniciar atención
                    </Button>
                    {t.paciente && (
                      <Link href={`/pacientes/${t.paciente.id}`}>
                        <Button variant="outline" size="sm">
                          Ver ficha
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Bandeja de informes ── */}
        <TabsContent value="bandeja" className="mt-4 space-y-3">
          {esMedico && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant={vista === "asignados" ? "default" : "outline"}
                data-testid="btn-vista-asignados"
                onClick={() => { setVista("asignados"); void cargar("asignados"); }}
              >
                Mis estudios asignados
              </Button>
              <Button
                size="sm"
                variant={vista === "modalidad" ? "default" : "outline"}
                data-testid="btn-vista-modalidad"
                onClick={() => { setVista("modalidad"); void cargar("modalidad"); }}
              >
                Toda mi modalidad
              </Button>
            </div>
          )}
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : bandeja.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground border rounded-lg">
              <CheckCircle className="w-10 h-10 opacity-20" />
              <p>No hay informes pendientes</p>
            </div>
          ) : (
            <div className="space-y-2">
              {bandeja.map((t) => {
                const meta = getEstadoMeta(t.estado);
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between p-4 border rounded-lg bg-card hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="text-center min-w-[48px]">
                        <div className="font-mono font-bold text-base">{t.horaInicio.substring(0, 5)}</div>
                        <div className="text-[10px] text-muted-foreground">hora</div>
                      </div>
                      <div className="w-px h-10 bg-border" />
                      <div>
                        <div className="font-semibold text-base leading-tight">
                          {t.paciente
                            ? `${t.paciente.apellido}, ${t.paciente.nombre}`
                            : "Paciente desconocido"}
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-2">
                          {t.paciente?.dni && <span>DNI {t.paciente.dni}</span>}
                          {t.motivoConsulta && <span>· {t.motivoConsulta}</span>}
                          {vista === "modalidad" && t.profesional && (
                            <span>· Dr/a. {t.profesional.apellido}</span>
                          )}
                          {t.informe?.estado === "firmado" && (
                            <span className="flex items-center gap-1 text-indigo-600">
                              <CheckCircle className="w-3 h-3" /> Firmado
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge estado={t.estado} />
                      <Link href={`/worklist/informe/${t.id}`}>
                        <Button
                          size="sm"
                          variant={t.estado === "pendiente_informe" ? "default" : "outline"}
                        >
                          <FileText className="w-4 h-4 mr-1" />
                          {t.informe
                            ? t.informe.estado === "publicado"
                              ? "Ver informe"
                              : "Editar informe"
                            : "Crear informe"}
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
