import { useMemo, useState } from "react";
import {
  useGetCajaResumen,
  useCreateCajaMovimiento,
  useDeleteCajaMovimiento,
  useCerrarCaja,
  getGetCajaResumenQueryKey,
  useListProfesionales,
  useListPacientes,
  useListObrasSociales,
  useListNomencladorPracticas,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Loader2, Save, List, Lock, Wallet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/layout/page-header";

function hoyArgentina(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
}

const pesos = (n: number) =>
  n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });

const TIPOS = [
  { value: "turno", label: "Turno / Consulta" },
  { value: "sena", label: "Seña" },
  { value: "insumo", label: "Insumo" },
] as const;

const MEDIOS = [
  { value: "efectivo", label: "Efectivo" },
  { value: "tarjeta", label: "Tarjeta" },
  { value: "transferencia", label: "Transferencia" },
  { value: "pago_digital", label: "Pago digital" },
] as const;

export default function CajaPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [fecha, setFecha] = useState<string>(hoyArgentina());

  const { data: resumen, isLoading } = useGetCajaResumen({ fecha });
  const { data: profesionales } = useListProfesionales();
  const crear = useCreateCajaMovimiento();
  const anular = useDeleteCajaMovimiento();
  const cerrar = useCerrarCaja();

  const [form, setForm] = useState({
    tipo: "turno",
    medioPago: "efectivo",
    monto: "",
    concepto: "",
    profesionalId: "",
    pacienteQ: "",
    pacienteId: "",
  });
  const [obraSocialId, setObraSocialId] = useState("");
  const [practicaQ, setPracticaQ] = useState("");
  const [practicaElegida, setPracticaElegida] = useState(false);
  const { data: obrasSociales } = useListObrasSociales();
  const { data: nomenclador } = useListNomencladorPracticas(
    { obraSocialId: Number(obraSocialId), buscar: practicaQ.trim(), limite: 8 },
    { query: { enabled: !!obraSocialId && practicaQ.trim().length >= 2 && !practicaElegida } },
  );
  const practicasSugeridas = nomenclador?.practicas ?? [];
  const [anularId, setAnularId] = useState<number | null>(null);
  const [confirmCierre, setConfirmCierre] = useState(false);

  const { data: pacientesResp } = useListPacientes(
    { q: form.pacienteQ, limit: 8 },
    { query: { enabled: form.pacienteQ.trim().length >= 2 } },
  );
  const pacientes = pacientesResp?.data ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetCajaResumenQueryKey({ fecha }) });

  const cerrada = resumen?.cerrada ?? false;

  const montoNum = useMemo(() => {
    const n = Number(form.monto.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [form.monto]);

  const registrar = () => {
    if (!montoNum) return;
    crear.mutate(
      {
        data: {
          fecha,
          tipo: form.tipo as "turno" | "sena" | "insumo",
          medioPago: form.medioPago as "efectivo" | "tarjeta" | "transferencia" | "pago_digital",
          monto: montoNum,
          ...(form.concepto.trim() && { concepto: form.concepto.trim() }),
          ...(form.profesionalId && { profesionalId: Number(form.profesionalId) }),
          ...(form.pacienteId && { pacienteId: Number(form.pacienteId) }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Pago registrado", description: pesos(montoNum) });
          setForm((f) => ({ ...f, monto: "", concepto: "", pacienteQ: "", pacienteId: "" }));
          setPracticaQ("");
          setPracticaElegida(false);
          invalidate();
        },
        onError: () => toast({ title: "No se pudo registrar el pago", variant: "destructive" }),
      },
    );
  };

  const confirmAnular = () => {
    if (!anularId) return;
    anular.mutate({ id: anularId }, {
      onSuccess: () => { toast({ title: "Movimiento anulado" }); invalidate(); setAnularId(null); },
      onError: () => { toast({ title: "No se pudo anular", variant: "destructive" }); setAnularId(null); },
    });
  };

  const hacerCierre = () => {
    cerrar.mutate({ data: { fecha } }, {
      onSuccess: (c) => {
        toast({ title: "Caja cerrada", description: `Total del día: ${pesos(c.total)}` });
        invalidate();
        setConfirmCierre(false);
      },
      onError: () => { toast({ title: "No se pudo cerrar la caja", variant: "destructive" }); setConfirmCierre(false); },
    });
  };

  const movimientos = resumen?.movimientos ?? [];
  const porProfesional = resumen?.porProfesional ?? [];

  return (
    <>
      <PageHeader 
        title="Caja Diaria"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Caja" }]}
      />

      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="date"
            className="w-44"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            data-testid="caja-fecha"
          />
          {cerrada ? (
            <Badge className="bg-slate-500 hover:bg-slate-500 gap-1">
              <Lock className="w-3 h-3" /> CAJA CERRADA
            </Badge>
          ) : (
            <Badge className="bg-emerald-500 hover:bg-emerald-500">CAJA ABIERTA</Badge>
          )}
          <div className="ml-auto text-right">
            <div className="text-xs uppercase text-muted-foreground">Total del día</div>
            <div className="text-2xl font-bold tabular-nums" data-testid="caja-total">
              {pesos(resumen?.total ?? 0)}
            </div>
          </div>
        </div>

        {!cerrada && (
          <Card className="border-l-4 border-l-primary">
            <CardContent className="pt-5 space-y-4">
              <div className="flex items-center gap-2 font-semibold">
                <Plus className="w-4 h-4" /> Registrar pago
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5 w-40">
                  <Label className="text-xs uppercase text-muted-foreground">Tipo</Label>
                  <Select value={form.tipo} onValueChange={(v) => setForm((f) => ({ ...f, tipo: v }))}>
                    <SelectTrigger data-testid="caja-tipo"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIPOS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 w-40">
                  <Label className="text-xs uppercase text-muted-foreground">Medio de pago</Label>
                  <Select value={form.medioPago} onValueChange={(v) => setForm((f) => ({ ...f, medioPago: v }))}>
                    <SelectTrigger data-testid="caja-medio"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MEDIOS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 w-32">
                  <Label className="text-xs uppercase text-muted-foreground">Monto *</Label>
                  <Input
                    placeholder="0,00"
                    inputMode="decimal"
                    value={form.monto}
                    onChange={(e) => setForm((f) => ({ ...f, monto: e.target.value }))}
                    data-testid="caja-monto"
                  />
                </div>
                <div className="space-y-1.5 w-52">
                  <Label className="text-xs uppercase text-muted-foreground">Profesional</Label>
                  <Select
                    value={form.profesionalId || "ninguno"}
                    onValueChange={(v) => setForm((f) => ({ ...f, profesionalId: v === "ninguno" ? "" : v }))}
                  >
                    <SelectTrigger data-testid="caja-profesional"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ninguno">Sin profesional</SelectItem>
                      {(profesionales ?? []).map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.nombre} {p.apellido ?? ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 w-56 relative">
                  <Label className="text-xs uppercase text-muted-foreground">Paciente</Label>
                  <Input
                    placeholder="Buscar por nombre o DNI…"
                    value={form.pacienteQ}
                    onChange={(e) => setForm((f) => ({ ...f, pacienteQ: e.target.value, pacienteId: "" }))}
                    data-testid="caja-paciente"
                  />
                  {form.pacienteQ.trim().length >= 2 && !form.pacienteId && pacientes.length > 0 && (
                    <div className="absolute z-10 top-full left-0 right-0 mt-1 rounded-md border bg-popover shadow-md max-h-52 overflow-auto">
                      {pacientes.map((p) => (
                        <button
                          key={p.id}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              pacienteId: String(p.id),
                              pacienteQ: `${p.apellido ?? ""} ${p.nombre}`.trim(),
                            }))
                          }
                          data-testid={`caja-paciente-${p.id}`}
                        >
                          {p.apellido ? `${p.apellido}, ` : ""}{p.nombre}
                          {p.dni ? <span className="text-muted-foreground"> — DNI {p.dni}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 w-48">
                  <Label className="text-xs uppercase text-muted-foreground">Obra social (nomenclador)</Label>
                  <Select
                    value={obraSocialId || "ninguna"}
                    onValueChange={(v) => {
                      setObraSocialId(v === "ninguna" ? "" : v);
                      setPracticaQ("");
                      setPracticaElegida(false);
                    }}
                  >
                    <SelectTrigger data-testid="caja-obra-social"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ninguna">Sin obra social</SelectItem>
                      {(obrasSociales ?? []).filter((o) => o.activa).map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>{o.nombre}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {obraSocialId && (
                  <div className="space-y-1.5 w-72 relative">
                    <Label className="text-xs uppercase text-muted-foreground">Práctica (autocompleta valor)</Label>
                    <Input
                      placeholder="Buscar por código o nombre…"
                      value={practicaQ}
                      onChange={(e) => { setPracticaQ(e.target.value); setPracticaElegida(false); }}
                      data-testid="caja-practica"
                    />
                    {practicaQ.trim().length >= 2 && !practicaElegida && practicasSugeridas.length > 0 && (
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 rounded-md border bg-popover shadow-md max-h-52 overflow-auto">
                        {practicasSugeridas.map((p) => (
                          <button
                            key={p.id}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                            onClick={() => {
                              setPracticaQ(`${p.codigo} — ${p.descripcion}`);
                              setPracticaElegida(true);
                              setForm((f) => ({
                                ...f,
                                monto: String(p.valorTotal).replace(".", ","),
                                concepto: `${p.codigo} — ${p.descripcion}`,
                              }));
                            }}
                            data-testid={`caja-practica-${p.id}`}
                          >
                            <span className="font-mono text-xs">{p.codigo}</span> {p.descripcion}
                            <span className="text-muted-foreground"> — {pesos(p.valorTotal)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="space-y-1.5 w-64">
                  <Label className="text-xs uppercase text-muted-foreground">Concepto</Label>
                  <Input
                    placeholder="Ej. Consulta particular"
                    value={form.concepto}
                    onChange={(e) => setForm((f) => ({ ...f, concepto: e.target.value }))}
                    data-testid="caja-concepto"
                  />
                </div>
                <Button onClick={registrar} disabled={!montoNum || crear.isPending} data-testid="caja-registrar">
                  {crear.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Registrar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <Card className="xl:col-span-2 border-l-4 border-l-primary">
            <CardContent className="pt-5 space-y-3">
              <div className="font-semibold">Movimientos del día</div>
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-800 hover:bg-slate-800">
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase">Tipo</TableHead>
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase">Paciente</TableHead>
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase">Profesional</TableHead>
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase">Concepto</TableHead>
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase">Medio</TableHead>
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase text-right">Monto</TableHead>
                      {!cerrada && <TableHead className="w-12" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}>
                          {Array.from({ length: 6 }).map((__, j) => (
                            <TableCell key={j}><Skeleton className="h-7 w-full" /></TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : movimientos.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                          Sin movimientos para esta fecha.
                        </TableCell>
                      </TableRow>
                    ) : (
                      movimientos.map((m, i) => (
                        <TableRow key={m.id} className={i % 2 === 1 ? "bg-primary/5" : undefined}>
                          <TableCell className="uppercase text-xs font-medium">
                            {TIPOS.find((t) => t.value === m.tipo)?.label ?? m.tipo}
                          </TableCell>
                          <TableCell className="text-sm">{m.pacienteNombre ?? "—"}</TableCell>
                          <TableCell className="text-sm">{m.profesionalNombre ?? "—"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{m.concepto ?? ""}</TableCell>
                          <TableCell className="text-xs uppercase">
                            {MEDIOS.find((x) => x.value === m.medioPago)?.label ?? m.medioPago}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{pesos(m.monto)}</TableCell>
                          {!cerrada && (
                            <TableCell>
                              <Button
                                variant="outline"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                onClick={() => setAnularId(m.id)}
                                title="Anular"
                                data-testid={`anular-${m.id}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <div className="border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
                  <List className="w-3.5 h-3.5" />
                  {movimientos.length} {movimientos.length === 1 ? "movimiento" : "movimientos"}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-primary">
            <CardContent className="pt-5 space-y-3">
              <div className="font-semibold">Totales por profesional</div>
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-800 hover:bg-slate-800">
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase">Profesional</TableHead>
                      <TableHead className="text-slate-100 text-xs font-semibold uppercase text-right">Subtotal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {porProfesional.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={2} className="h-16 text-center text-muted-foreground">
                          Sin datos.
                        </TableCell>
                      </TableRow>
                    ) : (
                      porProfesional.map((p, i) => (
                        <TableRow key={`${p.profesionalId ?? "sin"}-${i}`} className={i % 2 === 1 ? "bg-primary/5" : undefined}>
                          <TableCell className="text-sm">{p.profesionalNombre}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{pesos(p.subtotal)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {!cerrada && (
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => setConfirmCierre(true)}
                  disabled={cerrar.isPending || isLoading}
                  data-testid="cerrar-caja"
                >
                  <Lock className="w-4 h-4 mr-2" /> Finalizar caja del día
                </Button>
              )}
              {cerrada && resumen?.cierre && (
                <div className="text-sm text-muted-foreground">
                  Caja cerrada — total {pesos(resumen.cierre.total)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <AlertDialog open={!!anularId} onOpenChange={() => setAnularId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Anular movimiento?</AlertDialogTitle>
              <AlertDialogDescription>
                El movimiento se eliminará de la caja del día. Esta acción no se puede deshacer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={confirmAnular} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Anular
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmCierre} onOpenChange={setConfirmCierre}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Finalizar caja del {fecha}?</AlertDialogTitle>
              <AlertDialogDescription>
                Una vez cerrada la caja no se podrán registrar ni anular movimientos para ese día.
                Total actual: {pesos(resumen?.total ?? 0)}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={hacerCierre}>
                {cerrar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Finalizar caja
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}
