import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export type ItemChecklist = {
  key: string;
  label: string;
  ok: boolean;
  advertencia?: boolean;
  detalle?: string;
};

export type ResultadoChecklist = {
  items: ItemChecklist[];
  todoOk: boolean;
  faltantes: string[];
};

export function evaluarChecklistKlinicos({
  esConsulta,
  dni,
  cobertura,
  nroAfiliado,
  especialidad,
  profesional,
  motivo,
  ingresoGuardado,
  practicaId,
  practicasNombres,
}: {
  esConsulta: boolean;
  dni?: string | null;
  cobertura?: string | null;
  nroAfiliado?: string | null;
  especialidad?: string | null;
  profesional?: string | null;
  motivo?: string | null;
  ingresoGuardado?: boolean;
  practicaId?: number | null;
  /** Nombres de TODOS los estudios del turno (turno_practicas), no solo el principal */
  practicasNombres?: string[];
}): ResultadoChecklist {
  const esIoma =
    cobertura?.toLowerCase().includes("ioma") || cobertura?.toLowerCase().includes("pami") || true;

  const items: ItemChecklist[] = [
    {
      key: "dni",
      label: "DNI del paciente",
      ok: Boolean(dni?.trim()),
      detalle: dni?.trim() ? `DNI ${dni}` : "Sin DNI cargado",
    },
    {
      key: "especialidad",
      label: "Especialidad Klinicos",
      ok: Boolean(especialidad?.trim()),
      detalle: especialidad?.trim() || "Sin especialidad configurada",
    },
    // Los siguientes son recomendados: no bloquean la carga del token.
    {
      key: "cobertura",
      label: "Cobertura / Nro. de afiliado (recomendado)",
      ok: Boolean(cobertura?.trim()) && Boolean(nroAfiliado?.trim()),
      advertencia: true,
      detalle:
        cobertura && nroAfiliado
          ? `${cobertura} · Afiliado ${nroAfiliado}`
          : cobertura && !nroAfiliado
            ? `${cobertura} — sin nro. de afiliado, el Robot lo completa por padrón`
            : "Sin cobertura cargada",
    },
    {
      key: "profesional",
      label: "Profesional Klinicos (recomendado)",
      ok: Boolean(profesional?.trim()),
      advertencia: true,
      detalle: profesional?.trim() || "Sin profesional configurado en la turnera/turno",
    },
  ];

  if (esConsulta) {
    // Se muestran TODOS los estudios del turno, no solo el principal
    const cantidad = practicasNombres?.length ?? (practicaId != null ? 1 : 0);
    items.push({
      key: "practica",
      label: cantidad > 1 ? `Estudios IOMA (${cantidad})` : "Práctica IOMA (recomendado)",
      ok: cantidad > 0,
      advertencia: true,
      detalle:
        cantidad > 0
          ? practicasNombres && practicasNombres.length > 0
            ? practicasNombres.join(" + ")
            : `Práctica ID ${practicaId} seleccionada`
          : "Sin práctica seleccionada (el Robot puede requerir carga manual)",
    });
  }

  const obligatorios = items.filter((i) => !i.advertencia);
  const todoOk = obligatorios.every((i) => i.ok);
  const faltantes = obligatorios.filter((i) => !i.ok).map((i) => i.label);

  return { items, todoOk, faltantes };
}

export function ChecklistKlinicos({ resultado }: { resultado: ResultadoChecklist }) {
  return (
    <div className="space-y-1.5">
      {resultado.items.map((item) => {
        const esAdvertencia = !item.ok && item.advertencia;
        const esError = !item.ok && !item.advertencia;
        return (
          <div key={item.key} className="flex items-start gap-2 text-sm">
            {item.ok ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
            ) : esAdvertencia ? (
              <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            ) : (
              <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <span
                className={
                  item.ok
                    ? "text-foreground"
                    : esAdvertencia
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-red-700 dark:text-red-400 font-medium"
                }
              >
                {item.label}
              </span>
              {item.detalle && (
                <div
                  className={`text-xs truncate mt-0.5 ${
                    item.ok
                      ? "text-muted-foreground"
                      : esAdvertencia
                        ? "text-amber-600 dark:text-amber-500"
                        : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {item.detalle}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
