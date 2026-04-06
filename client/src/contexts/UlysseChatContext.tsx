import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useConversations, useCreateConversation, useConversation } from "@/hooks/use-chat";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
}

interface PendingFile {
  content: string;
  fileName: string;
  imageDataUrl?: string;
}

interface PageContext {
  pageId: string;
  pageName: string;
  pageDescription: string;
}

const PAGE_CONTEXTS: Record<string, PageContext> = {
  "/": { pageId: "dashboard", pageName: "Dashboard", pageDescription: "Tableau de bord principal d'Ulysse" },
  "/projects": { pageId: "projects", pageName: "Projets", pageDescription: "Gestion de projets — tu peux m'aider à organiser, créer ou prioriser des projets" },
  "/tasks": { pageId: "tasks", pageName: "Tâches", pageDescription: "Gestion des tâches — tu peux m'aider à organiser, créer ou prioriser des tâches" },
  "/notes": { pageId: "notes", pageName: "Notes", pageDescription: "Notes personnelles — tu peux m'aider à rédiger, organiser ou rechercher des notes" },
  "/settings": { pageId: "settings", pageName: "Réglages", pageDescription: "Paramètres de l'application" },
  "/emails": { pageId: "emails", pageName: "Emails", pageDescription: "Gestion des emails — tu peux m'aider à lire, répondre ou trier les emails" },
  "/ulysse-insights": { pageId: "insights", pageName: "Insights Ulysse", pageDescription: "Tableau de bord des insights et analyses d'Ulysse" },
  "/sports/predictions": { pageId: "sports", pageName: "Sports & Pronostics", pageDescription: "Pronostics sportifs — tu peux m'aider avec les analyses de matchs et paris" },
  "/sports/predictions/footalmanach": { pageId: "footalmanach", pageName: "Foot Almanach", pageDescription: "Almanach football — historique, stats et analyses de matchs" },
  "/brain": { pageId: "brain", pageName: "Brain Dashboard", pageDescription: "Base de connaissances — mémoire, apprentissage et connaissances d'Ulysse" },
  "/diagnostics": { pageId: "diagnostics", pageName: "Diagnostics", pageDescription: "Diagnostics système — état de santé, erreurs et performances" },
  "/finances": { pageId: "finances", pageName: "Finances", pageDescription: "Finances — comptes, transactions, analyse financière" },
  "/security": { pageId: "security", pageName: "Sécurité", pageDescription: "Dashboard de sécurité — monitoring, alertes et audit" },
  "/analytics": { pageId: "analytics", pageName: "Analytics", pageDescription: "Tableau de bord unifié — métriques et statistiques globales" },
  "/devops": { pageId: "devops", pageName: "DevOps", pageDescription: "Console DevOps — GitHub, déploiements, serveurs" },
  "/devops-iris": { pageId: "devops-iris", pageName: "DevOps Iris", pageDescription: "Panneau DevOps pour Iris — développement et maintenance" },
  "/suguval": { pageId: "suguval", pageName: "SUGU Valentine", pageDescription: "Gestion restaurant SUGU Valentine — achats, comptabilité, RH" },
  "/sugumaillane": { pageId: "sugumaillane", pageName: "SUGU Maillane", pageDescription: "Gestion restaurant SUGU Maillane — achats, comptabilité, RH" },
  "/assistant": { pageId: "assistant", pageName: "Assistant", pageDescription: "Assistant IA complet" },
  "/talking": { pageId: "talking", pageName: "Appel Vocal", pageDescription: "Conversation vocale avec Ulysse" },
  "/talking-v2": { pageId: "talking-v2", pageName: "Appel Vocal V2", pageDescription: "Conversation vocale V2 avec Ulysse" },
  "/iris": { pageId: "iris", pageName: "Iris Dashboard", pageDescription: "Tableau de bord Iris" },
  "/iris-homework": { pageId: "iris-homework", pageName: "Devoirs Iris", pageDescription: "Gestion des devoirs d'Iris — aide aux devoirs, planning" },
  "/iris-files": { pageId: "iris-files", pageName: "Fichiers Iris", pageDescription: "Fichiers et documents d'Iris" },
  "/iris-talking": { pageId: "iris-talking", pageName: "Appel Iris", pageDescription: "Conversation vocale avec Iris" },
  "/courses/suguval": { pageId: "suguval-checklist", pageName: "Checklist SUGU Val", pageDescription: "Checklist de formation SUGU Valentine" },
  "/courses/suguval/edit": { pageId: "suguval-admin", pageName: "Admin SUGU Val", pageDescription: "Administration des formations SUGU Valentine" },
  "/courses/suguval/history": { pageId: "suguval-history", pageName: "Historique SUGU Val", pageDescription: "Historique des formations SUGU Valentine" },
  "/courses/sugumaillane": { pageId: "sugumaillane-checklist", pageName: "Checklist SUGU Maillane", pageDescription: "Checklist de formation SUGU Maillane" },
  "/courses/sugumaillane/edit": { pageId: "sugumaillane-admin", pageName: "Admin SUGU Maillane", pageDescription: "Administration des formations SUGU Maillane" },
  "/courses/sugumaillane/history": { pageId: "sugumaillane-history", pageName: "Historique SUGU Maillane", pageDescription: "Historique des formations SUGU Maillane" },
};

const PAGES_WITH_OWN_CHAT = ["/", "/talking", "/talking-v2", "/devops", "/suguval", "/sugumaillane", "/assistant", "/iris", "/iris-talking", "/max", "/devops-max", "/devmax", "/login"];

export function emitChatSync(conversationId: number, source: string) {
  window.dispatchEvent(new CustomEvent("ulysse:chat-sync", {
    detail: { conversationId, source, timestamp: Date.now() }
  }));
}

export function getSharedConversationId(): number | null {
  const saved = localStorage.getItem("ulysse-active-conversation");
  return saved ? parseInt(saved, 10) : null;
}

export function setSharedConversationId(id: number) {
  localStorage.setItem("ulysse-active-conversation", String(id));
  emitChatSync(id, "context");
}

interface UlysseChatContextType {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  activeConversationId: number | null;
  pendingFile: PendingFile | null;
  currentPageContext: PageContext | null;
  persona: "Ulysse" | "Iris";
  shouldShowWidget: boolean;
  sendMessage: (text?: string, options?: { imageDataUrl?: string }) => Promise<void>;
  setInput: (input: string) => void;
  input: string;
  setPendingFile: (file: PendingFile | null) => void;
  setCurrentPath: (path: string) => void;
  setActiveConversationId: (id: number | null) => void;
}

const UlysseChatContext = createContext<UlysseChatContextType | null>(null);

export function useUlysseChat() {
  const ctx = useContext(UlysseChatContext);
  if (!ctx) throw new Error("useUlysseChat must be used within UlysseChatProvider");
  return ctx;
}

export function UlysseChatProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: conversations } = useConversations();
  const createConversation = useCreateConversation();

  const persona = useMemo(() => {
    if (user?.isOwner) return "Ulysse" as const;
    return "Iris" as const;
  }, [user?.isOwner]);

  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);

  const [sharedConvId, setSharedConvId] = useState<number | null>(() => {
    return getSharedConversationId();
  });

  const setActiveConversationId = useCallback((id: number | null) => {
    setSharedConvId(id);
    if (id) setSharedConversationId(id);
  }, []);

  useEffect(() => {
    if (!user) {
      setSharedConvId(null);
      return;
    }
    if (!sharedConvId && conversations && conversations.length > 0) {
      setActiveConversationId(conversations[0].id);
    }
  }, [conversations, sharedConvId, user, setActiveConversationId]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.conversationId && detail.source !== "widget") {
        setSharedConvId(detail.conversationId);
        queryClient.invalidateQueries({ queryKey: ["/api/conversations", detail.conversationId] });
      }
    };
    window.addEventListener("ulysse:chat-sync", handler);
    return () => window.removeEventListener("ulysse:chat-sync", handler);
  }, [queryClient]);

  useEffect(() => {
    const handler = () => {
      const current = getSharedConversationId();
      if (current && current !== sharedConvId) {
        setSharedConvId(current);
        queryClient.invalidateQueries({ queryKey: ["/api/conversations", current] });
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [sharedConvId, queryClient]);

  const lastSyncRefreshRef = useRef(0);
  useEffect(() => {
    const handleConvSync = () => {
      if (sharedConvId) {
        const now = Date.now();
        if (now - lastSyncRefreshRef.current > 2000) {
          lastSyncRefreshRef.current = now;
          queryClient.invalidateQueries({ queryKey: ["/api/conversations", sharedConvId] });
          queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
        }
      }
    };

    const handleConvMessage = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const { conversationId } = detail;
      if (conversationId && conversationId !== sharedConvId) {
        setSharedConvId(conversationId);
        if (conversationId) setSharedConversationId(conversationId);
        queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId] });
      } else if (conversationId && conversationId === sharedConvId) {
        const now = Date.now();
        if (now - lastSyncRefreshRef.current > 2000) {
          lastSyncRefreshRef.current = now;
          queryClient.invalidateQueries({ queryKey: ["/api/conversations", sharedConvId] });
        }
      }
    };

    window.addEventListener("ulysse:conversations-updated", handleConvSync);
    window.addEventListener("ulysse:conversation-message", handleConvMessage);
    return () => {
      window.removeEventListener("ulysse:conversations-updated", handleConvSync);
      window.removeEventListener("ulysse:conversation-message", handleConvMessage);
    };
  }, [sharedConvId, queryClient]);

  const { data: activeConversation } = useConversation(sharedConvId);

  const messages = useMemo<ChatMessage[]>(() => {
    if (!activeConversation?.messages) return [];
    return activeConversation.messages.map((m: any) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
    }));
  }, [activeConversation?.messages]);

  const currentPageContext = useMemo(() => {
    if (currentPath.startsWith("/projects/")) {
      return { pageId: "project-detail", pageName: "Détail Projet", pageDescription: "Détails et tâches d'un projet spécifique" };
    }
    return PAGE_CONTEXTS[currentPath] || null;
  }, [currentPath]);

  const shouldShowWidget = useMemo(() => {
    if (!user) return false;
    if (user.role === "external") return false;
    return !PAGES_WITH_OWN_CHAT.some(p => {
      if (p === "/") return currentPath === "/";
      return currentPath === p || currentPath.startsWith(p + "/");
    });
  }, [currentPath, user]);

  const sendMessage = useCallback(async (messageText?: string, options?: { imageDataUrl?: string }) => {
    let content = messageText || input;
    let imageDataUrl: string | undefined = options?.imageDataUrl;

    if (pendingFile) {
      if (pendingFile.imageDataUrl && !imageDataUrl) {
        imageDataUrl = pendingFile.imageDataUrl;
        content = content || "Analyse cette image en détail et décris ce que tu vois.";
      } else if (!pendingFile.imageDataUrl) {
        const fileContext = `[FICHIER JOINT: ${pendingFile.fileName}]\n\nContenu du fichier:\n${pendingFile.content.slice(0, 15000)}\n\n---\n\n${content || "Analyse ce fichier et donne-moi un résumé."}`;
        content = fileContext;
      }
      setPendingFile(null);
    }

    if (!content.trim() || isStreaming) return;
    setInput("");
    setIsStreaming(true);
    setStreamingContent("");

    let convId = sharedConvId;
    if (!convId) {
      try {
        const newConv = await createConversation.mutateAsync("Widget Chat");
        convId = newConv.id;
        setActiveConversationId(convId);
      } catch {
        setIsStreaming(false);
        return;
      }
    }

    queryClient.setQueryData(["/api/conversations", convId], (old: any) => ({
      ...old,
      messages: [...(old?.messages || []), { role: "user", content, createdAt: new Date() }]
    }));

    let fullResponse = "";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    const contextHint = currentPageContext
      ? `\n[CONTEXTE PAGE: ${currentPageContext.pageName} — ${currentPageContext.pageDescription}]`
      : "";

    try {
      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: contextHint ? content + contextHint : content,
          imageDataUrl,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (!res.ok) throw new Error("Erreur de communication");

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) {
                fullResponse += data.content;
                setStreamingContent(fullResponse);
              }
            } catch {}
          }
        }
      }

      if (fullResponse) {
        queryClient.setQueryData(["/api/conversations", convId], (old: any) => ({
          ...old,
          messages: [...(old?.messages || []), { role: "assistant", content: fullResponse, createdAt: new Date() }]
        }));
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      const errorMsg = err.name === "AbortError"
        ? "Ulysse met trop de temps à répondre. Réessayez."
        : err.message || "Erreur de communication";
      queryClient.setQueryData(["/api/conversations", convId], (old: any) => ({
        ...old,
        messages: [...(old?.messages || []), { role: "assistant", content: `⚠️ ${errorMsg}`, createdAt: new Date() }]
      }));
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      emitChatSync(convId!, "widget");
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", convId] });
    }
  }, [input, sharedConvId, isStreaming, queryClient, pendingFile, currentPageContext, createConversation, setActiveConversationId]);

  const value = useMemo(() => ({
    messages,
    isStreaming,
    streamingContent,
    activeConversationId: sharedConvId,
    pendingFile,
    currentPageContext,
    persona,
    shouldShowWidget,
    sendMessage,
    setInput,
    input,
    setPendingFile,
    setCurrentPath,
    setActiveConversationId,
  }), [messages, isStreaming, streamingContent, sharedConvId, pendingFile, currentPageContext, persona, shouldShowWidget, sendMessage, input, setActiveConversationId]);

  return (
    <UlysseChatContext.Provider value={value}>
      {children}
    </UlysseChatContext.Provider>
  );
}
