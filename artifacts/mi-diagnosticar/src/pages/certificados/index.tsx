import { useState } from "react";
import { useListPacientes, type Paciente } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Search, FileText, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { SeccionCertificados } from "@/pages/pacientes/resolucion";

export default function CertificadosPage() {
  const [dniInput, setDniInput] = useState("");
  const [dniBuscado, setDniBuscado] = useState("");
  const [paciente, setPaciente] = useState<Paciente | null>(null);

  const { data, isLoading } = useListPacientes(
    { dni: dniBuscado, limit: 5 },
    { query: { enabled: dniBuscado.length >= 6 } },
  );

  const resultados = dniBuscado.length >= 6 ? (data?.data ?? []) : [];

  const buscar = () => {
    setPaciente(null);
    setDniBuscado(dniInput.trim());
  };

  return (
    <>
      <PageHeader
        title="Certificados"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Certificados" }]}
      />
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Emitir certificado médico
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!paciente ? (
              <>
                <Label htmlFor="dni-certificado">DNI del paciente</Label>
                <div className="flex gap-2">
                  <Input
                    id="dni-certificado"
                    placeholder="Ej: 30123456"
                    value={dniInput}
                    inputMode="numeric"
                    onChange={(e) => setDniInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && buscar()}
                    data-testid="input-dni-certificado"
                  />
                  <Button onClick={buscar} disabled={dniInput.trim().length < 6} data-testid="boton-buscar-paciente-certificado">
                    <Search className="w-4 h-4 mr-1" /> Buscar
                  </Button>
                </div>
                {isLoading && dniBuscado ? (
                  <Skeleton className="h-12 w-full" />
                ) : dniBuscado && resultados.length === 0 && !isLoading ? (
                  <p className="text-sm text-muted-foreground">
                    No se encontró ningún paciente con DNI {dniBuscado}.
                  </p>
                ) : (
                  resultados.map((p) => (
                    <button
                      key={p.id}
                      className="w-full flex items-center justify-between rounded-lg border p-3 text-left hover:bg-accent transition-colors"
                      onClick={() => setPaciente(p)}
                      data-testid={`resultado-paciente-${p.id}`}
                    >
                      <div>
                        <div className="font-medium text-sm">{p.apellido}, {p.nombre}</div>
                        <div className="text-xs text-muted-foreground">DNI {p.dni ?? "—"}</div>
                      </div>
                      <Badge variant="secondary">Seleccionar</Badge>
                    </button>
                  ))
                )}
              </>
            ) : (
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-3">
                <div>
                  <div className="font-medium text-sm" data-testid="paciente-seleccionado-certificado">
                    {paciente.apellido}, {paciente.nombre}
                  </div>
                  <div className="text-xs text-muted-foreground">DNI {paciente.dni ?? "—"}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setPaciente(null)} data-testid="boton-cambiar-paciente-certificado">
                  <X className="w-4 h-4 mr-1" /> Cambiar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {paciente && <SeccionCertificados pacienteId={paciente.id} />}
      </div>
    </>
  );
}
