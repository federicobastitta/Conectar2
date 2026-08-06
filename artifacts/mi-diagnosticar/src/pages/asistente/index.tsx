import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import {
  Bot,
  Send,
  Calendar,
  FileText,
  User,
  Loader2,
  ChevronRight,
  RotateCcw,
  MapPin,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

const QUICK_ACTIONS = [
  {
    icon: Calendar,
    label: "Sacar turno",
    prompt: "Quiero sacar un turno",
    color: "text-blue-600 bg-blue-50 dark:bg-blue-950/40",
  },
  {
    icon: FileText,
    label: "Mis estudios",
    prompt: "¿Cómo puedo ver mis estudios?",
    color: "text-green-600 bg-green-50 dark:bg-green-950/40",
  },
  {
    icon: Clock,
    label: "Mis turnos",
    prompt: "Quiero ver mis turnos activos",
    color: "text-purple-600 bg-purple-50 dark:bg-purple-950/40",
  },
  {
    icon: MapPin,
    label: "Sedes y horarios",
    prompt: "¿Cuáles son las sedes y sus horarios de atención?",
    color: "text-orange-600 bg-orange-50 dark:bg-orange-950/40",
  },
];

const SUGGESTION_CHIPS = [
  "Necesito una ecografía",
  "Quiero turno con traumatología",
  "¿Tengo turno pendiente?",
  "¿Cómo me preparo para un análisis?",
  "Turno con el mismo médico",
];

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  action?: { tipo: string; especialidad?: string; label: string };
}

function MessageBubble({ role, content, action }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div className={cn("flex gap-2.5", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
      )}
      <div className={cn("max-w-[80%] space-y-2", isUser && "items-end flex flex-col")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-line",
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-card border shadow-sm rounded-tl-sm"
          )}
        >
          {content}
        </div>
        {action?.tipo === "reservar" && (
          <Button
            size="sm"
            className="w-full max-w-[260px] rounded-xl text-xs font-medium"
            asChild
          >
            <Link
              href={`/reservar${action.especialidad ? `?esp=${encodeURIComponent(action.especialidad)}` : ""}`}
            >
              <Calendar className="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
              {action.label}
              <ChevronRight className="w-3.5 h-3.5 ml-auto flex-shrink-0" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function TypingIndicator({ content }: { content: string }) {
  const display = content.replace(/##ACCION##.*$/s, "");
  return (
    <div className="flex gap-2.5 justify-start">
      <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="bg-card border shadow-sm rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm max-w-[80%]">
        {display ? (
          <span>
            {display}
            <span className="inline-block w-0.5 h-3.5 bg-foreground/60 ml-0.5 animate-pulse align-text-bottom" />
          </span>
        ) : (
          <div className="flex items-center gap-1 h-5">
            {[0, 150, 300].map((delay) => (
              <div
                key={delay}
                className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Asistente() {
  const { messages, isLoading, streamingContent, sendMessage, reset } = useChat();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasMessages = messages.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSend = (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || isLoading) return;
    setInput("");
    inputRef.current?.focus();
    void sendMessage(msg);
  };

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] bg-background">
      {/* Header */}
      <div className="flex-shrink-0 border-b bg-background/95 backdrop-blur px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-sm">Asistente Conectar</h1>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-xs text-muted-foreground">En línea · siempre disponible</span>
            </div>
          </div>
          {hasMessages && (
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-muted-foreground"
              onClick={reset}
              title="Nueva conversación"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {!hasMessages ? (
            <div className="flex flex-col items-center text-center gap-6 pt-4 pb-8">
              <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center shadow-sm">
                <Bot className="w-10 h-10 text-primary" />
              </div>

              <div>
                <h2 className="text-2xl font-bold tracking-tight">
                  Hola, ¿en qué te ayudo?
                </h2>
                <p className="text-muted-foreground mt-1.5 text-sm max-w-xs mx-auto">
                  Escribí lo que necesitás y te guío al turno, informe o
                  consulta correcta
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
                {QUICK_ACTIONS.map((action) => (
                  <button
                    key={action.label}
                    onClick={() => handleSend(action.prompt)}
                    className="flex items-center gap-3 p-3.5 rounded-2xl border bg-card hover:bg-accent hover:border-primary/30 transition-all text-left"
                  >
                    <div
                      className={cn(
                        "w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0",
                        action.color
                      )}
                    >
                      <action.icon className="w-4 h-4" />
                    </div>
                    <span className="text-sm font-medium leading-tight">
                      {action.label}
                    </span>
                  </button>
                ))}
              </div>

              <div className="w-full max-w-sm">
                <p className="text-xs text-muted-foreground mb-2 text-left">
                  O probá con:
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTION_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      onClick={() => handleSend(chip)}
                      className="px-3 py-1.5 rounded-full text-xs border bg-background hover:bg-accent hover:border-primary/40 transition-all"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 w-full max-w-sm">
                <Button variant="outline" size="sm" className="flex-1 rounded-xl" asChild>
                  <Link href="/reservar">
                    <Calendar className="w-3.5 h-3.5 mr-1.5" />
                    Reservar turno
                  </Link>
                </Button>
                <Button variant="outline" size="sm" className="flex-1 rounded-xl" asChild>
                  <Link href="/mi-turno">
                    <User className="w-3.5 h-3.5 mr-1.5" />
                    Mi turno
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  role={msg.role}
                  content={msg.content}
                  action={msg.action}
                />
              ))}
              {isLoading && <TypingIndicator content={streamingContent} />}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="flex-shrink-0 border-t bg-background/95 backdrop-blur px-4 py-3">
        <div className="max-w-2xl mx-auto flex gap-2 items-center">
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
            placeholder="Escribí lo que necesitás..."
            className="rounded-full text-sm bg-muted/50"
            disabled={isLoading}
            autoComplete="off"
          />
          <Button
            size="icon"
            className="rounded-full flex-shrink-0 w-9 h-9"
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground/60 mt-2 max-w-2xl mx-auto">
          El asistente no reemplaza a tu médico · Para urgencias llamá al 107
        </p>
      </div>
    </div>
  );
}
