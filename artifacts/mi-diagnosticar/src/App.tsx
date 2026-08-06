import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter } from "@workspace/api-client-react";

setAuthTokenGetter(() =>
  typeof window !== "undefined" ? localStorage.getItem("auth_token") : null
);
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout/app-layout";
import { PublicLayout } from "@/components/layout/public-layout";
import { PersonalizacionGate } from "@/components/personalizacion/personalizacion-gate";
import { ValidacionTokenProvider } from "@/contexts/validacion-token-provider";
import { VistaRolSwitcher } from "@/components/vista-rol-switcher";
import { ErrorBoundary } from "@/components/error-boundary";

import Login from "@/pages/login";
import NotFound from "@/pages/not-found";

const Dashboard = lazy(() => import("@/pages/dashboard"));
const TurnosList = lazy(() => import("@/pages/turnos/list"));
const TableroOperativo = lazy(() => import("@/pages/turnos/tablero"));
const TurnoNuevo = lazy(() => import("@/pages/turnos/nuevo"));
const TurnoDetalle = lazy(() => import("@/pages/turnos/detalle"));
const AgendasActivas = lazy(() => import("@/pages/turneras/agendas"));
const TodasLasAgendas = lazy(() => import("@/pages/turneras/todas"));
const PacientesList = lazy(() => import("@/pages/pacientes/list"));
const PacienteDetail = lazy(() => import("@/pages/pacientes/detail"));
const HistoriaClinica = lazy(() => import("@/pages/pacientes/historia"));
const Hce = lazy(() => import("@/pages/pacientes/hce"));
const ConsultaUnificada = lazy(() => import("@/pages/pacientes/consulta"));
const ConsultorioDigital = lazy(() => import("@/pages/consultorio"));
const EscritorioMedico = lazy(() => import("@/pages/escritorio-medico"));
const FirmasPendientes = lazy(() => import("@/pages/medico/firmas-pendientes"));
const MedicoConsulta = lazy(() => import("@/pages/medico-consulta"));
const MiApp = lazy(() => import("@/pages/mi-app"));
const VideollamadaMedico = lazy(() => import("@/pages/videollamada"));
const CertificadosPage = lazy(() => import("@/pages/certificados"));
const AsistenteMedico = lazy(() => import("@/pages/asistente-medico"));
const ProfesionalesList = lazy(() => import("@/pages/profesionales/list"));
const TurnerasList = lazy(() => import("@/pages/turneras/list"));
const TurneraNueva = lazy(() => import("@/pages/turneras/nueva"));
const Configuracion = lazy(() => import("@/pages/configuracion"));
const SedesPage = lazy(() => import("@/pages/configuracion/sedes"));
const EspecialidadesPage = lazy(
  () => import("@/pages/configuracion/especialidades")
);
const PulsoIntegracion = lazy(() => import("@/pages/configuracion/pulso"));
const KlinicosIntegracion = lazy(
  () => import("@/pages/configuracion/klinicos")
);
const PacsWorklistPage = lazy(
  () => import("@/pages/configuracion/pacs-worklist")
);
const EquivalenciasPage = lazy(
  () => import("@/pages/configuracion/equivalencias")
);
const Importacion = lazy(() => import("@/pages/importacion"));
const Informes = lazy(() => import("@/pages/informes"));
const EstudiosWorkspaceLista = lazy(() => import("@/pages/estudios"));
const EstudioWorkspace = lazy(() => import("@/pages/estudios/workspace"));
const Notificaciones = lazy(() => import("@/pages/notificaciones"));
const Worklist = lazy(() => import("@/pages/worklist"));
const InformeEditor = lazy(() => import("@/pages/worklist/informe"));
const SalaEspera = lazy(() => import("@/pages/sala-espera"));
const PantallaSala = lazy(() => import("@/pages/pantalla-sala"));
const TvEntrada = lazy(() => import("@/pages/tv"));
const IngresoMagico = lazy(() => import("@/pages/ingreso-magico"));
const VerificarCertificado = lazy(
  () => import("@/pages/verificar-certificado")
);
const VerificarOrden = lazy(() => import("@/pages/verificar-orden"));
const VerificarReceta = lazy(() => import("@/pages/verificar-receta"));
const BandejaSolicitudes = lazy(() => import("@/pages/recepcion/solicitudes"));
const OrdenesRecepcion = lazy(() => import("@/pages/recepcion/ordenes"));
const Recepcion = lazy(() => import("@/pages/recepcion"));
const AgendaPorMedico = lazy(() => import("@/pages/recepcion/agenda-medico"));
const Estadisticas = lazy(() => import("@/pages/estadisticas"));
const ReportesEstadisticos = lazy(
  () => import("@/pages/estadisticas/reportes")
);
const Mensajeria = lazy(() => import("@/pages/mensajeria"));
const SalasGrupales = lazy(() => import("@/pages/salas-grupales"));
const Asistente = lazy(() => import("@/pages/asistente"));
const Reservar = lazy(() => import("@/pages/reservar"));
const ConfirmarTurno = lazy(() => import("@/pages/reservar/confirmar"));
const MiTurno = lazy(() => import("@/pages/mi-turno"));
const ModuloEnConstruccion = lazy(
  () => import("@/pages/modulo-en-construccion")
);
const ObrasSociales = lazy(() => import("@/pages/obras-sociales/list"));
const Caja = lazy(() => import("@/pages/caja"));
const Consultorios = lazy(() => import("@/pages/consultorios/list"));
const SalasLlamado = lazy(() => import("@/pages/salas-llamado/list"));
const OrdenesList = lazy(() => import("@/pages/ordenes/index"));
const OrdenesNueva = lazy(() => import("@/pages/ordenes/nueva"));
const OrdenDetalle = lazy(() => import("@/pages/ordenes/detalle"));
const PracticasCatalogoConfig = lazy(
  () => import("@/pages/configuracion/practicas-catalogo")
);
const ImportacionAdmin = lazy(
  () => import("@/pages/configuracion/importacion-admin")
);
const PerfilesPage = lazy(() => import("@/pages/perfiles"));
const PuntajesPage = lazy(() => import("@/pages/puntajes"));
const FeedbackPage = lazy(() => import("@/pages/feedback"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function PageLoader() {
  return (
    <div className="flex h-[60vh] w-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function ProtectedRoutes() {
  return (
    <AppLayout>
      {/* Boundary interno: un crash de página deja el menú/navegación vivos */}
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/turnos" component={TurnosList} />
          <Route path="/turnos/tablero" component={TableroOperativo} />
          <Route path="/turnos/nuevo" component={TurnoNuevo} />
          <Route path="/turnos/:id" component={TurnoDetalle} />
          <Route path="/agendas" component={AgendasActivas} />
          <Route path="/agendas/todas" component={TodasLasAgendas} />
          <Route path="/pacientes" component={PacientesList} />
          <Route path="/pacientes/:id" component={PacienteDetail} />
          <Route path="/pacientes/:id/historia" component={HistoriaClinica} />
          <Route path="/pacientes/:id/hce" component={Hce} />
          <Route path="/pacientes/:id/consulta" component={ConsultaUnificada} />
          <Route path="/consultorio" component={ConsultorioDigital} />
          <Route path="/escritorio-medico" component={EscritorioMedico} />
          <Route path="/firmas-pendientes" component={FirmasPendientes} />
          <Route path="/medico-consulta" component={MedicoConsulta} />
          <Route path="/mi-app" component={MiApp} />
          <Route path="/videollamada" component={VideollamadaMedico} />
          <Route path="/certificados" component={CertificadosPage} />
          <Route path="/asistente-medico" component={AsistenteMedico} />
          <Route path="/profesionales" component={ProfesionalesList} />
          <Route path="/turneras" component={TurnerasList} />
          <Route path="/turneras/nueva" component={TurneraNueva} />
          <Route path="/turneras/:id/editar" component={TurneraNueva} />
          <Route path="/perfiles" component={PerfilesPage} />
          <Route path="/puntajes" component={PuntajesPage} />
          <Route path="/feedback" component={FeedbackPage} />
          <Route path="/configuracion" component={Configuracion} />
          <Route path="/configuracion/sedes" component={SedesPage} />
          <Route path="/configuracion/especialidades" component={EspecialidadesPage} />
          <Route path="/configuracion/pulso" component={PulsoIntegracion} />
          <Route path="/configuracion/klinicos" component={KlinicosIntegracion} />
          <Route path="/configuracion/pacs-worklist" component={PacsWorklistPage} />
          <Route path="/configuracion/equivalencias" component={EquivalenciasPage} />
          <Route path="/importacion" component={Importacion} />
          <Route path="/estudios" component={EstudiosWorkspaceLista} />
          <Route path="/estudios/:id/workspace" component={EstudioWorkspace} />
          <Route path="/worklist" component={Worklist} />
          <Route path="/worklist/informe/:turnoId" component={InformeEditor} />
          <Route path="/informes" component={Informes} />
          <Route path="/notificaciones" component={Notificaciones} />
          <Route path="/sala-espera" component={SalaEspera} />
          <Route path="/admision" component={Recepcion} />
          <Route path="/recepcion" component={Recepcion} />
          <Route path="/recepcion/agenda-medico" component={AgendaPorMedico} />
          <Route path="/recepcion/solicitudes" component={BandejaSolicitudes} />
          <Route path="/recepcion/ordenes" component={OrdenesRecepcion} />
          <Route path="/estadisticas" component={Estadisticas} />
          <Route path="/estadisticas/reportes" component={ReportesEstadisticos} />
          <Route path="/mensajeria" component={Mensajeria} />
          <Route path="/salas-grupales" component={SalasGrupales} />
          <Route path="/asistente" component={Asistente} />
          <Route path="/obra-social" component={ObrasSociales} />
          <Route path="/caja" component={Caja} />
          <Route path="/entrada-salida" component={ModuloEnConstruccion} />
          <Route path="/socios" component={ModuloEnConstruccion} />
          <Route path="/consultorios" component={Consultorios} />
          <Route path="/salas-llamado" component={SalasLlamado} />
          <Route path="/imprimir" component={ModuloEnConstruccion} />
          <Route path="/movimientos" component={ModuloEnConstruccion} />
          <Route path="/localidades" component={ModuloEnConstruccion} />
          <Route path="/actividad-laboral" component={ModuloEnConstruccion} />
          <Route path="/ordenes" component={OrdenesList} />
          <Route path="/ordenes/nueva" component={OrdenesNueva} />
          <Route path="/ordenes/:id" component={OrdenDetalle} />
          <Route path="/configuracion/practicas-catalogo" component={PracticasCatalogoConfig} />
          <Route path="/configuracion/importacion-admin" component={ImportacionAdmin} />
          <Route path="/auditoria" component={ModuloEnConstruccion} />
          <Route path="/ocupacion-puestos" component={ModuloEnConstruccion} />
          <Route path="/ayuda" component={ModuloEnConstruccion} />
          <Route component={NotFound} />
        </Switch>
        </Suspense>
      </ErrorBoundary>
    </AppLayout>
  );
}

function PublicRoutes() {
  return (
    <PublicLayout>
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/reservar" component={Reservar} />
          <Route path="/reservar/confirmar" component={ConfirmarTurno} />
          <Route path="/mi-turno" component={MiTurno} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </PublicLayout>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/pantalla-sala" component={PantallaSala} />
        <Route path="/tv" component={TvEntrada} />
        <Route path="/ingreso/:token" component={IngresoMagico} />
        <Route path="/verificar/:codigo" component={VerificarCertificado} />
        <Route path="/verificar" component={VerificarCertificado} />
        <Route path="/verificar-orden/:codigo" component={VerificarOrden} />
        <Route path="/verificar-orden" component={VerificarOrden} />
        <Route path="/verificar-receta/:codigo" component={VerificarReceta} />
        <Route path="/verificar-receta" component={VerificarReceta} />
        <Route path="/asistente" component={Asistente} />
        <Route path="/reservar/*?" component={PublicRoutes} />
        <Route path="/mi-turno/*?" component={PublicRoutes} />
        <Route path="/*" component={ProtectedRoutes} />
      </Switch>
    </Suspense>
  );
}

// La PWA dedicada de Feedback arranca en /feedback?solo=1. Se captura acá
// (antes del login) para que el modo "solo chat" sobreviva la redirección
// del login y cualquier navegación intermedia.
if (new URLSearchParams(window.location.search).get("solo") === "1") {
  sessionStorage.setItem("feedback_solo", "1");
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          {/* Validación de token global: sigue en segundo plano al cerrar el
              dialog y el cartel grande salta en cualquier pantalla. */}
          <ValidacionTokenProvider>
            <Router />
            <PersonalizacionGate />
            <VistaRolSwitcher />
          </ValidacionTokenProvider>
        </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
