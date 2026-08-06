import { useState, useRef, useEffect } from "react";
import {
  Bot,
  X,
  Send,
  Loader2,
  ChevronRight,
  Calendar,
  MessageSquare,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

const WIDGET_CHIPS = [
  { icon: Calendar, label: "Sacar un turno", prompt: "Quiero sacar un turno" },
  { icon: MapPin, label: "¿Dónde están las sedes?", prompt: "¿Dónde están las sedes de Conectar?" },
  { icon: MessageSquare, label: "¿Qué especialidades tienen?", prompt: "¿Qué especialidades tienen disponibles?" },
];

export function AsistenteWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const { messages, isLoading, streamingContent, sendMessage } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasMessages = messages.length > 0;

  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingContent, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  const handleSend = (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || isLoading) return;
    setInput("");
    void sendMessage(msg);
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {isOpen && (
        <div
          className={cn(
            "w-[340px] max-sm:w-[calc(100vw-3rem)] bg-background border rounded-2xl shadow-2xl flex flex-col overflow-hidden",
            "animate-in slide-in-from-bottom-4 fade-in-0 duration-200"
          )}
          style={{ maxHeight: "520px" }}
        >
          {/* Header */}
          <div className="flex items-center gap-2.5 px-3.5 py-3 bg-primary text-primary-foreground flex-shrink-0">
            <div className="w-7 h-7 rounded-full bg-card/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-3.5 h-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm leading-none">Asistente Conectar</p>
              <div className="flex items-center gap-1 mt-1">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-xs opacity-75">En línea</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="w-7 h-7 text-primary-foreground hover:bg-card/20 flex-shrink-0"
              onClick={() => setIsOpen(false)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
            {!hasMessages ? (
              <div className="py-3 space-y-4">
                <div className="text-center space-y-1.5">
                  <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
                    <Bot className="w-6 h-6 text-primary" />
                  </div>
                  <p className="font-semibold text-sm">¡Hola! ¿En qué puedo ayudarte?</p>
                  <p className="text-xs text-muted-foreground">
                    Puedo ayudarte a sacar turnos, consultar especialidades y más
                  </p>
                </div>
                <div className="space-y-1.5">
                  {WIDGET_CHIPS.map((chip) => (
                    <button
                      key={chip.label}
                      onClick={() => handleSend(chip.prompt)}
                      className="w-full flex items-center gap-2.5 text-left text-xs px-3 py-2.5 rounded-xl border bg-muted/30 hover:bg-accent hover:border-primary/30 transition-all"
                    >
                      <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <chip.icon className="w-3 h-3 text-primary" />
                      </div>
                      <span className="font-medium">{chip.label}</span>
                      <ChevronRight className="w-3 h-3 text-muted-foreground ml-auto flex-shrink-0" />
                    </button>
                  ))}
                </div>
                <p className="text-center text-xs text-muted-foreground/60">
                  O escribí tu consulta abajo
                </p>
              </div>
            ) : (
              <>
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex gap-2",
                      msg.role === "user" ? "justify-end" : "justify-start"
                    )}
                  >
                    {msg.role === "assistant" && (
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Bot className="w-3 h-3 text-primary" />
                      </div>
                    )}
                    <div className="max-w-[85%] space-y-1.5">
                      <div
                        className={cn(
                          "rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-line",
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground rounded-tr-sm"
                            : "bg-muted rounded-tl-sm"
                        )}
                      >
                        {msg.content}
                      </div>
                      {msg.action?.tipo === "reservar" && (
                        <a
                          href={`/reservar${msg.action.especialidad ? `?esp=${encodeURIComponent(msg.action.especialidad)}` : ""}`}
                          className="flex items-center gap-1.5 text-xs text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
                        >
                          <Calendar className="w-3 h-3 flex-shrink-0" />
                          {msg.action.label}
                          <ChevronRight className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="flex gap-2 justify-start">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-3 h-3 text-primary" />
                    </div>
                    <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 text-xs max-w-[85%]">
                      {streamingContent ? (
                        <span>
                          {streamingContent.replace(/##ACCION##.*$/s, "")}
                          <span className="inline-block w-0.5 h-3 bg-foreground/60 ml-0.5 animate-pulse align-text-bottom" />
                        </span>
                      ) : (
                        <div className="flex gap-1 h-4 items-center">
                          {[0, 150, 300].map((delay) => (
                            <div
                              key={delay}
                              className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
                              style={{ animationDelay: `${delay}ms` }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {/* Input */}
          <div className="flex-shrink-0 p-2.5 border-t flex gap-2 items-center">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Escribí tu consulta..."
              className="text-xs rounded-full h-8 bg-muted/50"
              disabled={isLoading}
              autoComplete="off"
            />
            <Button
              size="icon"
              className="rounded-full flex-shrink-0 w-8 h-8"
              onClick={() => handleSend()}
              disabled={isLoading || !input.trim()}
            >
              {isLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Floating toggle button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200",
          "bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105 active:scale-95",
          isOpen && "rotate-0"
        )}
        aria-label={isOpen ? "Cerrar asistente" : "Abrir asistente"}
      >
        {isOpen ? <X className="w-6 h-6" /> : <Bot className="w-6 h-6" />}
      </button>
    </div>
  );
}
