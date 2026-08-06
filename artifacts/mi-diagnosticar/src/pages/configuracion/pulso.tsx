import {
  useGetPulsoEstado,
  useSyncPulsoPacientes,
  useSyncPulsoEstudios,
  getGetPulsoEstadoQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plug,
  RefreshCw,
  Loader2,
  Users,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Stethoscope,
} from "lucide-react";

function formatoFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" });
}

export default function PulsoIntegracion() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: estado, isLoading } = useGetPulsoEstado({
    query: {
      // Refrescar seguido mientras hay un sync en curso
      refetchInterval: (query) =>
        query.state.data?.sync?.sincronizando ||
        query.state.data?.estudios?.sync?.sincronizando
          ? 3000
          : false,
    },
  });

  const syncMutation = useSyncPulsoPacientes();
  const syncEstudiosMutation = useSyncPulsoEstudios();

  const sincronizando = estado?.sync?.sincronizando ?? false;
  const stats = estado?.sync?.ultimoResultado ?? null;

  const estudiosSincronizando = estado?.estudios?.sync?.sincronizando ?? false;
  const estudiosStats = estado?.estudios?.sync?.ultimoResultado ?? null;

  const lanzarEstudios = (full: boolean) => {
    syncEstudiosMutation.mutate(
      { data: { full } },
      {
        onSuccess: () => {
          toast({
            title: full ? "Resync completo de estudios iniciado" : "Sincronización de estudios iniciada",
            description: "Buscando estudios e informes en Pulso…",
          });
          queryClient.invalidateQueries({ queryKey: getGetPulsoEstadoQueryKey() });
        },
        onError: () => {
          toast({
            title: "No se pudo iniciar",
            description: "Puede que ya haya una sincronización de estudios en curso.",
            variant: "destructive",
          });
          queryClient.invalidateQueries({ queryKey: getGetPulsoEstadoQueryKey() });
        },
      },
    );
  };

  const lanzar = (full: boolean) => {
    syncMutation.mutate(
      { data: { full } },
      {
        onSuccess: () => {
          toast({
            title: full ? "Resincronización completa iniciada" : "Importación iniciada",
            description: "Buscando pacientes en Pulso…",
          });
          queryClient.invalidateQueries({ queryKey: getGetPulsoEstadoQueryKey() });
        },
        onError: () => {
          toast({
            title: "No se pudo iniciar",
            description: "Puede que ya haya una sincronización en curso.",
            variant: "destructive",
          });
          queryClient.invalidateQueries({ queryKey: getGetPulsoEstadoQueryKey() });
        },
      },
    );
  };

  const configurado = estado?.configurado ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Plug className="w-7 h-7 text-primary" /> Pulso
        </h1>
        <p className="text-muted-foreground">
          Importá los pacientes de Pulso a Conectar. Los pacientes nuevos se traen
          automáticamente; también podés forzar la importación desde acá.
        </p>
      </div>

      {!isLoading && !configurado && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex items-center gap-3 py-4">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="text-sm text-amber-800">
              La integración no está configurada. Faltan las credenciales de Pulso
              (<code>PULSO_USERNAME</code> / <code>PULSO_PASSWORD</code>).
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="w-5 h-5 text-primary" /> Pacientes importados
            </CardTitle>
            <CardDescription>Vinculados a un registro de Pulso</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">
              {isLoading ? "…" : (estado?.importados ?? 0).toLocaleString("es-AR")}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="w-5 h-5 text-primary" /> Última sincronización
            </CardTitle>
            <CardDescription>Actualización más reciente</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-medium">
              {isLoading ? "…" : formatoFecha(estado?.ultimaSincronizacion)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="w-5 h-5 text-primary" /> Estado
            </CardTitle>
            <CardDescription>Del proceso de importación</CardDescription>
          </CardHeader>
          <CardContent>
            {sincronizando ? (
              <Badge className="gap-1 bg-blue-600">
                <Loader2 className="w-3 h-3 animate-spin" /> Sincronizando…
              </Badge>
            ) : estado?.sync?.ultimoError ? (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="w-3 h-3" /> Error
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="w-3 h-3 text-green-600" /> Al día
              </Badge>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sincronizar ahora</CardTitle>
          <CardDescription>
            <strong>Importar nuevos</strong>: trae solo los pacientes agregados en Pulso desde
            la última vez (rápido). <strong>Resync completo</strong>: recorre todos los pacientes
            de Pulso y actualiza los datos existentes (más lento).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            onClick={() => lanzar(false)}
            disabled={!configurado || sincronizando || syncMutation.isPending}
          >
            {sincronizando || syncMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Importar nuevos
          </Button>
          <Button
            variant="outline"
            onClick={() => lanzar(true)}
            disabled={!configurado || sincronizando || syncMutation.isPending}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Resync completo
          </Button>
        </CardContent>
      </Card>

      {stats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resultado de la última corrida</CardTitle>
            <CardDescription>
              Modo: {estado?.sync?.ultimoModo ?? "—"} · Terminó: {formatoFecha(estado?.sync?.terminadoEn)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-center">
              <Metric label="Creados" value={stats.creados} highlight />
              <Metric label="Actualizados" value={stats.actualizados} />
              <Metric label="Vistos" value={stats.vistos} />
              <Metric label="Páginas" value={stats.paginas} />
              <Metric label="Sin DNI" value={stats.sinDni} />
              <Metric label="Errores" value={stats.errores} danger={stats.errores > 0} />
            </div>
            {estado?.sync?.ultimoError && (
              <p className="mt-4 text-sm text-red-600">{estado.sync.ultimoError}</p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="pt-2">
        <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <Stethoscope className="w-6 h-6 text-primary" /> Estudios e informes
        </h2>
        <p className="text-muted-foreground text-sm">
          Los estudios informados de Pulso se sincronizan a Conectar y se muestran en la ficha del
          paciente. El contenido del informe y el PDF firmado se consultan en vivo al abrirlos.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Stethoscope className="w-5 h-5 text-primary" /> Estudios sincronizados
            </CardTitle>
            <CardDescription>Vinculados a un paciente: {(estado?.estudios?.vinculados ?? 0).toLocaleString("es-AR")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">
              {isLoading ? "…" : (estado?.estudios?.total ?? 0).toLocaleString("es-AR")}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="w-5 h-5 text-primary" /> Última sincronización
            </CardTitle>
            <CardDescription>De estudios e informes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-medium">
              {isLoading ? "…" : formatoFecha(estado?.estudios?.ultimaSincronizacion)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="w-5 h-5 text-primary" /> Estado
            </CardTitle>
            <CardDescription>Del proceso de estudios</CardDescription>
          </CardHeader>
          <CardContent>
            {estudiosSincronizando ? (
              <Badge className="gap-1 bg-blue-600">
                <Loader2 className="w-3 h-3 animate-spin" /> Sincronizando…
              </Badge>
            ) : estado?.estudios?.sync?.ultimoError ? (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="w-3 h-3" /> Error
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="w-3 h-3 text-green-600" /> Al día
              </Badge>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sincronizar estudios ahora</CardTitle>
          <CardDescription>
            <strong>Sincronizar recientes</strong>: revisa los estudios de los últimos días para captar
            nuevos, firmas y cambios de estado (rápido). <strong>Resync completo</strong>: recorre todo
            el histórico de estudios de Pulso (más lento).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            onClick={() => lanzarEstudios(false)}
            disabled={!configurado || estudiosSincronizando || syncEstudiosMutation.isPending}
          >
            {estudiosSincronizando || syncEstudiosMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Sincronizar recientes
          </Button>
          <Button
            variant="outline"
            onClick={() => lanzarEstudios(true)}
            disabled={!configurado || estudiosSincronizando || syncEstudiosMutation.isPending}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Resync completo
          </Button>
        </CardContent>
      </Card>

      {estudiosStats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resultado de la última corrida (estudios)</CardTitle>
            <CardDescription>
              Modo: {estado?.estudios?.sync?.ultimoModo ?? "—"} · Terminó:{" "}
              {formatoFecha(estado?.estudios?.sync?.terminadoEn)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-center">
              <Metric label="Creados" value={estudiosStats.creados} highlight />
              <Metric label="Actualizados" value={estudiosStats.actualizados} />
              <Metric label="Vinculados" value={estudiosStats.vinculados} />
              <Metric label="Sin paciente" value={estudiosStats.sinPaciente} />
              <Metric label="Vistos" value={estudiosStats.vistos} />
              <Metric label="Errores" value={estudiosStats.errores} danger={estudiosStats.errores > 0} />
            </div>
            {estado?.estudios?.sync?.ultimoError && (
              <p className="mt-4 text-sm text-red-600">{estado.estudios.sync.ultimoError}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  highlight,
  danger,
}: {
  label: string;
  value: number;
  highlight?: boolean;
  danger?: boolean;
}) {
  return (
    <div>
      <div
        className={`text-2xl font-bold ${
          danger ? "text-red-600" : highlight ? "text-green-600" : ""
        }`}
      >
        {value.toLocaleString("es-AR")}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
