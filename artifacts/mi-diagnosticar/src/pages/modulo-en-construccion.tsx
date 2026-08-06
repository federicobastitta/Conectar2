import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Construction } from "lucide-react";

const TITULOS: Record<string, string> = {
  "/obra-social": "Obra Social",
  "/caja": "Caja",
  "/entrada-salida": "Entrada/Salida",
  "/socios": "Socios",
  "/consultorios": "Consultorios",
  "/imprimir": "Imprimir",
  "/movimientos": "Movimientos",
  "/localidades": "Localidades",
  "/actividad-laboral": "Actividad Laboral",
  "/practicas": "Prácticas",
};

export default function ModuloEnConstruccion() {
  const [location] = useLocation();
  const titulo = TITULOS[location] ?? "Módulo";

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">{titulo}</h1>
        <p className="text-sm text-muted-foreground">Módulo en construcción</p>
      </div>
      <Card>
        <CardContent className="py-12 flex flex-col items-center text-center gap-3">
          <div className="bg-muted rounded-full p-4">
            <Construction className="w-8 h-8 text-muted-foreground" />
          </div>
          <p className="font-medium">Este módulo todavía no está disponible</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            {titulo} forma parte del menú de la nueva versión y se va a habilitar próximamente.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
