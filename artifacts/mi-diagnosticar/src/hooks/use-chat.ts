import { useState, useCallback, useRef } from "react";

export interface ChatAction {
  tipo: string;
  especialidad?: string;
  label: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  action?: ChatAction;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingContent: string;
  sendMessage: (content: string) => Promise<void>;
  reset: () => void;
  conversationId: number | null;
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const msgIdRef = useRef(0);
  const isLoadingRef = useRef(false);
  const convRef = useRef<{ id: number; token: string } | null>(null);

  const getOrCreateConversation = useCallback(async (): Promise<{
    id: number;
    token: string;
  }> => {
    if (convRef.current) return convRef.current;

    const res = await fetch("/api/openai/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Asistente ${new Date().toLocaleString("es-AR")}`,
      }),
      credentials: "include",
    });

    if (!res.ok) throw new Error("No se pudo crear la conversación");
    const conv = (await res.json()) as { id: number; token: string };
    convRef.current = { id: conv.id, token: conv.token };
    setConversationId(conv.id);
    return convRef.current;
  }, []);

  const sendMessage = useCallback(
    async (content: string): Promise<void> => {
      if (isLoadingRef.current) return;

      isLoadingRef.current = true;
      setIsLoading(true);
      setStreamingContent("");

      const userMsgId = ++msgIdRef.current;
      setMessages((prev) => [...prev, { id: userMsgId, role: "user", content }]);

      try {
        const conv = await getOrCreateConversation();

        const res = await fetch(`/api/openai/conversations/${conv.id}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "x-conversation-token": conv.token,
          },
          body: JSON.stringify({ content }),
          credentials: "include",
        });

        if (!res.ok || !res.body) {
          throw new Error("Error de conexión con el asistente");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let streamError: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6)) as {
                content?: string;
                done?: boolean;
                error?: string;
              };

              if (data.done) {
                const actionIdx = fullContent.indexOf("##ACCION##");
                let displayContent = fullContent;
                let action: ChatAction | undefined;

                if (actionIdx !== -1) {
                  displayContent = fullContent.slice(0, actionIdx).trim();
                  try {
                    action = JSON.parse(
                      fullContent.slice(actionIdx + 10)
                    ) as ChatAction;
                  } catch {
                    /* skip malformed action */
                  }
                }

                const assistantMsgId = ++msgIdRef.current;
                setMessages((prev) => [
                  ...prev,
                  { id: assistantMsgId, role: "assistant", content: displayContent, action },
                ]);
                setStreamingContent("");
              } else if (data.error) {
                streamError = data.error;
              } else if (data.content) {
                fullContent += data.content;
                setStreamingContent(fullContent);
              }
            } catch {
              /* skip malformed SSE line */
            }
          }
        }

        if (streamError) {
          throw new Error(streamError);
        }
      } catch {
        const errMsgId = ++msgIdRef.current;
        setMessages((prev) => [
          ...prev,
          {
            id: errMsgId,
            role: "assistant",
            content:
              "Lo siento, tuve un problema al procesar tu mensaje. Por favor intentá de nuevo o contactá a recepción.",
          },
        ]);
        setStreamingContent("");
      } finally {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    },
    [getOrCreateConversation]
  );

  const reset = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    convRef.current = null;
    setStreamingContent("");
    setIsLoading(false);
    isLoadingRef.current = false;
  }, []);

  return { messages, isLoading, streamingContent, sendMessage, reset, conversationId };
}
