import { useEffect, useRef, useCallback } from "react";
import { queryClient } from "@/lib/queryClient";

export type SyncEventType = 
  | "connected"
  | "memory.updated" 
  | "memory.deleted"
  | "files.updated" 
  | "diagnostics.updated" 
  | "homework.updated"
  | "homework.deleted"
  | "conversations.updated"
  | "conversation.message"
  | "search.results"
  | "talking.message"
  | "lightbox.show"
  | "lightbox.hide"
  | "dashboard.command"
  | "dashboard.update"
  | "typing.update"
  | "typing.prethink"
  | "tasks.updated"
  | "notes.updated"
  | "projects.updated"
  | "sugu.purchases.updated"
  | "sugu.expenses.updated"
  | "sugu.bank.updated"
  | "sugu.cash.updated"
  | "sugu.checklist.updated"
  | "sugu.files.updated"
  | "sugu.employees.updated"
  | "sugu.payroll.updated"
  | "sugu.absences.updated"
  | "sugu.loans.updated"
  | "sports.updated"
  | "stocks.updated"
  | "bets.updated"
  | "brain.updated"
  | "emails.updated"
  | "insights.updated"
  | "taskqueue.created"
  | "taskqueue.started"
  | "taskqueue.item_started"
  | "taskqueue.item_completed"
  | "taskqueue.item_failed"
  | "taskqueue.completed"
  | "taskqueue.paused"
  | "task.progress"
  | "app.navigate";

interface SyncEvent {
  type: SyncEventType;
  userId?: number;
  data?: any;
  timestamp: number;
}

// --- ALL query keys that each event type should invalidate ---
const eventToQueryKeys: Record<SyncEventType, string[][]> = {
  "connected": [],
  "memory.updated": [["/api/memory"], ["/api/ulysse/memories"]],
  "memory.deleted": [["/api/memory"], ["/api/ulysse/memories"]],
  "files.updated": [["/api/files"], ["/api/generated-files"]],
  "diagnostics.updated": [["/api/diagnostics/health"], ["/api/diagnostics/run"], ["/api/diagnostics/issues"], ["/api/diagnostics/iris-issues"]],
  "homework.updated": [["/api/homework"]],
  "homework.deleted": [["/api/homework"]],
  "conversations.updated": [["/api/conversations"], ["/api/v2/conversations"]],
  "conversation.message": [],
  "search.results": [],
  "talking.message": [],
  "lightbox.show": [],
  "lightbox.hide": [],
  "dashboard.command": [],
  "dashboard.update": [],
  "typing.update": [],
  "typing.prethink": [],
  "tasks.updated": [["/api/tasks"]],
  "taskqueue.created": [],
  "taskqueue.started": [],
  "taskqueue.item_started": [],
  "taskqueue.item_completed": [],
  "taskqueue.item_failed": [],
  "taskqueue.completed": [],
  "taskqueue.paused": [],
  "task.progress": [],
  "app.navigate": [],
  "notes.updated": [["/api/notes"]],
  "projects.updated": [["/api/projects"]],
  // sugu.* events invalidate BOTH restaurants (SuguVal + SuguMaillane)
  "sugu.purchases.updated": [
    ["/api/v2/sugu-management/purchases"],
    ["/api/v2/sugu-management/audit/overview"],
    ["/api/v2/sugumaillane-management/purchases"],
    ["/api/v2/sugumaillane-management/audit/overview"],
  ],
  "sugu.expenses.updated": [
    ["/api/v2/sugu-management/expenses"],
    ["/api/v2/sugu-management/audit/overview"],
    ["/api/v2/sugumaillane-management/expenses"],
    ["/api/v2/sugumaillane-management/audit/overview"],
  ],
  "sugu.bank.updated": [
    ["/api/v2/sugu-management/bank"],
    ["/api/v2/sugu-management/loans"],
    ["/api/v2/sugu-management/audit/overview"],
    ["/api/v2/sugumaillane-management/bank"],
    ["/api/v2/sugumaillane-management/loans"],
    ["/api/v2/sugumaillane-management/audit/overview"],
  ],
  "sugu.cash.updated": [
    ["/api/v2/sugu-management/cash"],
    ["/api/v2/sugu-management/cash/summary"],
    ["/api/v2/sugu-management/audit/overview"],
    ["/api/v2/sugumaillane-management/cash"],
    ["/api/v2/sugumaillane-management/cash/summary"],
    ["/api/v2/sugumaillane-management/audit/overview"],
  ],
  "sugu.checklist.updated": [
    ["/api/suguval/checks"], ["/api/suguval/dashboard"], ["/api/suguval/categories"],
    ["/api/sugumaillane/checks"], ["/api/sugumaillane/dashboard"], ["/api/sugumaillane/categories"],
  ],
  "sugu.files.updated": [
    ["/api/v2/sugu-management/files"],
    ["/api/v2/sugumaillane-management/files"],
  ],
  "sugu.employees.updated": [
    ["/api/v2/sugu-management/employees"],
    ["/api/v2/sugumaillane-management/employees"],
  ],
  "sugu.payroll.updated": [
    ["/api/v2/sugu-management/payroll"],
    ["/api/v2/sugumaillane-management/payroll"],
  ],
  "sugu.absences.updated": [
    ["/api/v2/sugu-management/absences"],
    ["/api/v2/sugumaillane-management/absences"],
  ],
  "sugu.loans.updated": [
    ["/api/v2/sugu-management/loans"],
    ["/api/v2/sugumaillane-management/loans"],
  ],
  "sports.updated": [
    ["/api/sports/cache/predictions/stats"],
    ["/api/sports/cache/predictions/history"],
    ["/api/sports/dashboard/big5/upcoming"],
  ],
  "stocks.updated": [["/api/v2/stocks/portfolio"], ["/api/v2/stocks/market"]],
  "bets.updated": [["/api/v2/bets"]],
  "brain.updated": [
    ["/api/learning/stats"], ["/api/learning/alerts"],
    ["/api/learning/metrics"], ["/api/learning/top-patterns"],
  ],
  "emails.updated": [["/api/agentmail/threads"], ["/api/agentmail/status"]],
  "insights.updated": [["/api/ulysse-dev/insights"]],
};

// ============================================================
// SINGLETON WebSocket — one connection per browser tab
// ============================================================

export interface PreThinkResult {
  intent: string | null;
  category: string | null;
  context: string[];
  suggestedTools: string[];
  isReading: boolean;
  confidence: number;
}

export interface TalkingMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  audioUrl?: string;
  origin: "talking" | "chat" | "voice";
}

export interface LightboxContent {
  type: "image" | "video" | "document" | "code" | "html";
  url?: string;
  content?: string;
  title?: string;
  mimeType?: string;
}

export interface DashboardCommand {
  action: string;
  target?: string;
  params?: Record<string, any>;
  source: "talking" | "chat" | "external";
}

export interface TTSRequest {
  text: string;
  origin: "chat" | "voice";
  timestamp: number;
}

interface SubscriberOptions {
  userId?: number;
  accessToken?: string | null;
  deviceId?: string;
  onSearchResults?: (data: any) => void;
  onConversationsUpdated?: (conversationId?: number) => void;
  onTalkingMessage?: (message: TalkingMessage) => void;
  onTTSRequest?: (request: TTSRequest) => void;
  onLightboxShow?: (content: LightboxContent) => void;
  onLightboxHide?: () => void;
  onDashboardCommand?: (command: DashboardCommand) => void;
  onDashboardUpdate?: (update: { section: string; data: any }) => void;
  onPreThink?: (result: PreThinkResult) => void;
  onTaskQueueUpdate?: (event: { type: string; data: any }) => void;
}

// --- Singleton state (module-level, shared across all hook instances) ---
let ws: WebSocket | null = null;
let isConnected = false;
let isAuthenticated = false;
let isGuest = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastPong = Date.now();
let lastActivity = Date.now();
let usingPolling = false;
let pollingTimer: ReturnType<typeof setInterval> | null = null;

const MAX_RECONNECT = 10;
const HEARTBEAT_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const KEEP_ALIVE_MS = 300000;

// Auth state — first non-null value wins, updated as subscribers register
let singletonUserId: number | undefined;
let singletonToken: string | null | undefined;
let singletonDeviceId: string | undefined;

// All active hook instances
const subscribers = new Map<string, SubscriberOptions>();

function startPolling() {
  if (pollingTimer || usingPolling) return;
  usingPolling = true;
  console.log("[RealtimeSync] Fallback: polling every 10s");
  pollingTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/v2/conversations"] });
    }
  }, 10000);
}

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
  usingPolling = false;
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  lastPong = Date.now();
  heartbeatTimer = setInterval(() => {
    if (isAuthenticated) {
      if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
        console.warn("[RealtimeSync] Heartbeat timeout — reconnecting");
        ws?.close();
        return;
      }
    }
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      fetch("/api/session/keep-alive", { method: "POST", credentials: "include" }).catch(() => {});
    }
  }, KEEP_ALIVE_MS);
}

function sendAuth() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!singletonUserId && !singletonToken) return;
  const deviceId = singletonDeviceId || (singletonToken ? "mobile" : "web");
  ws.send(JSON.stringify({
    type: "auth",
    token: singletonToken || undefined,
    userId: singletonToken ? undefined : singletonUserId,
    deviceId,
  }));
  console.log("[RealtimeSync] Auth sent:", { hasToken: !!singletonToken, userId: singletonUserId, deviceId });
}

function dispatchToSubscribers(data: any) {
  subscribers.forEach(opts => {
    if (data.type === "search.results" && opts.onSearchResults) opts.onSearchResults(data.data);
    if (data.type === "talking.message" && opts.onTalkingMessage) opts.onTalkingMessage(data.data);
    if (data.type === "tts_request" && opts.onTTSRequest) opts.onTTSRequest(data.data);
    if (data.type === "lightbox.show" && opts.onLightboxShow) opts.onLightboxShow(data.data);
    if (data.type === "lightbox.hide" && opts.onLightboxHide) opts.onLightboxHide();
    if (data.type === "dashboard.command" && opts.onDashboardCommand) opts.onDashboardCommand(data.data);
    if (data.type === "dashboard.update" && opts.onDashboardUpdate) opts.onDashboardUpdate(data.data);
    if (data.type === "typing.prethink" && opts.onPreThink) opts.onPreThink(data.data);
    if (data.type?.startsWith("taskqueue.") && opts.onTaskQueueUpdate) opts.onTaskQueueUpdate({ type: data.type, data: data.data });
    if (data.type === "task.progress" && opts.onTaskQueueUpdate) opts.onTaskQueueUpdate({ type: data.type, data: data.data });
    if (data.type === "app.navigate" && data.data) {
      window.dispatchEvent(new CustomEvent("ulysse:app-navigate", { detail: data.data }));
    }
    if ((data.type === "conversations.updated" || data.type === "conversation.message") && opts.onConversationsUpdated) {
      opts.onConversationsUpdated(data.data?.conversationId || data.data?.message?.conversationId);
    }
  });
}

function injectMessageIntoCache(msg: any) {
  const convId = msg.conversationId;
  const newMsg = {
    id: msg.id || Date.now(),
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp || new Date().toISOString(),
    conversationId: convId,
    threadId: convId,
    userId: msg.userId,
    modality: msg.modality || "text",
    attachments: msg.attachments || [],
    metadata: msg.metadata || {},
    createdAt: msg.timestamp || new Date().toISOString(),
  };

  const injected = { v1: false, v2: false };

  queryClient.setQueriesData(
    { queryKey: ["/api/conversations", convId] },
    (old: any) => {
      if (!old?.messages) return old;
      if (old.messages.some((m: any) => m.id === newMsg.id || (m.role === newMsg.role && m.content === newMsg.content && Math.abs(new Date(m.timestamp || m.createdAt).getTime() - new Date(newMsg.createdAt).getTime()) < 2000))) return old;
      injected.v1 = true;
      return { ...old, messages: [...old.messages, newMsg] };
    }
  );

  queryClient.setQueriesData(
    { queryKey: ["/api/v2/conversations", convId] },
    (old: any) => {
      if (!old?.messages) return old;
      if (old.messages.some((m: any) => m.id === newMsg.id || (m.role === newMsg.role && m.content === newMsg.content && Math.abs(new Date(m.createdAt).getTime() - new Date(newMsg.createdAt).getTime()) < 2000))) return old;
      injected.v2 = true;
      return { ...old, messages: [...old.messages, newMsg] };
    }
  );

  queryClient.setQueriesData(
    { queryKey: ["/api/conversations"] },
    (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((c: any) => {
        if (c.id !== convId) return c;
        return { ...c, lastMessageAt: newMsg.createdAt, messageCount: (c.messageCount || 0) + 1 };
      });
    }
  );

  queryClient.setQueriesData(
    { queryKey: ["/api/v2/conversations"] },
    (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((c: any) => {
        if (c.id !== convId) return c;
        return { ...c, lastMessageAt: newMsg.createdAt, messageCount: (c.messageCount || 0) + 1 };
      });
    }
  );

  if (injected.v1 || injected.v2) {
    console.log(`[RealtimeSync] Message injected into conv ${convId} (${msg.role})`);
  } else {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations", convId] });
    queryClient.invalidateQueries({ queryKey: ["/api/v2/conversations", convId] });
  }
}

function handleMessage(raw: MessageEvent) {
  try {
    const data = JSON.parse(raw.data as string);

    if (data.type === "pong" || data.type === "server_ping") { lastPong = Date.now(); return; }
    if (data.type === "connected") return;
    if (data.type === "auth.success") {
      console.log("[RealtimeSync] Authenticated, userId:", data.userId);
      isAuthenticated = true; isGuest = false; return;
    }
    if (data.type === "auth.failed") {
      console.warn("[RealtimeSync] Auth failed:", data.error); return;
    }
    if (data.type === "auth.guest") {
      console.log("[RealtimeSync] Connected as guest"); isGuest = true; isAuthenticated = false; return;
    }
    if (data.type === "auth.timeout") {
      console.warn("[RealtimeSync] Auth timeout"); return;
    }

    if (data.type === "conversation.message") {
      const msg = data.data?.message;
      if (msg?.conversationId) {
        injectMessageIntoCache(msg);
        window.dispatchEvent(new CustomEvent("ulysse:conversation-message", {
          detail: { conversationId: msg.conversationId, role: msg.role, origin: data.data?.origin }
        }));
      }
    }

    if (data.type === "conversations.updated") {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/v2/conversations"] });
      window.dispatchEvent(new CustomEvent("ulysse:conversations-updated"));
      dispatchToSubscribers(data);
      return;
    }

    dispatchToSubscribers(data);

    const keys = eventToQueryKeys[data.type as SyncEventType];
    if (keys?.length) {
      keys.forEach(key => queryClient.invalidateQueries({ queryKey: key }));
    }
  } catch (err) {
    console.error("[RealtimeSync] Message parse error:", err);
  }
}

function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  if (reconnectAttempts >= MAX_RECONNECT) { startPolling(); return; }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws/sync`;

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[RealtimeSync] Connected (singleton)");
      isConnected = true;
      reconnectAttempts = 0;
      stopPolling();
      startHeartbeat();
      sendAuth();
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      isConnected = false;
      isAuthenticated = false;
      isGuest = false;
      stopHeartbeat();
      reconnectAttempts++;

      if (reconnectAttempts >= MAX_RECONNECT) { startPolling(); return; }

      const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), 10000) + Math.random() * 500;
      console.log(`[RealtimeSync] Reconnecting in ${Math.round(delay / 1000)}s (${reconnectAttempts}/${MAX_RECONNECT})`);
      reconnectTimer = setTimeout(connect, delay);
    };

    ws.onerror = () => {};
  } catch (err) {
    console.error("[RealtimeSync] Connect error:", err);
    reconnectAttempts++;
    if (reconnectAttempts >= MAX_RECONNECT) startPolling();
    else reconnectTimer = setTimeout(connect, Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), 10000));
  }
}

function forceReconnect() {
  console.log("[RealtimeSync] Force reconnect");
  reconnectAttempts = 0;
  stopPolling();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws?.close();
  ws = null;
  connect();
}

// ============================================================
// Hook — registers as a subscriber to the singleton
// ============================================================

interface UseRealtimeSyncOptions {
  userId?: number;
  accessToken?: string | null;
  deviceId?: string;
  onSearchResults?: (data: any) => void;
  onConversationsUpdated?: (conversationId?: number) => void;
  onTalkingMessage?: (message: TalkingMessage) => void;
  onTTSRequest?: (request: TTSRequest) => void;
  onLightboxShow?: (content: LightboxContent) => void;
  onLightboxHide?: () => void;
  onDashboardCommand?: (command: DashboardCommand) => void;
  onDashboardUpdate?: (update: { section: string; data: any }) => void;
  onPreThink?: (result: PreThinkResult) => void;
  onTaskQueueUpdate?: (event: { type: string; data: any }) => void;
}

export function useRealtimeSync(options?: UseRealtimeSyncOptions) {
  const subscriberIdRef = useRef(`sub-${Math.random().toString(36).slice(2)}`);
  const id = subscriberIdRef.current;

  // Register/update subscriber options on every render
  useEffect(() => {
    subscribers.set(id, options || {});
  });

  useEffect(() => {
    subscribers.set(id, options || {});

    // Update singleton auth if this subscriber provides better credentials
    if (options?.userId && !singletonUserId) {
      singletonUserId = options.userId;
      singletonDeviceId = options.deviceId;
      if (isConnected) sendAuth();
    }
    if (options?.accessToken && !singletonToken) {
      singletonToken = options.accessToken;
      singletonDeviceId = options.deviceId || "mobile";
      if (isConnected) sendAuth();
    }

    // Connect singleton if not yet started
    if (!ws || ws.readyState > WebSocket.OPEN) connect();

    // Start keep-alive for the first subscriber
    if (subscribers.size === 1) startKeepAlive();

    return () => {
      subscribers.delete(id);
      // If this subscriber owned the auth, clear it if no other subscriber has it
      const anyWithUserId = [...subscribers.values()].some(s => s.userId);
      if (!anyWithUserId) { singletonUserId = undefined; isAuthenticated = false; }
    };
  }, [id]);

  // Update auth when userId/token change
  useEffect(() => {
    if (options?.userId && options.userId !== singletonUserId) {
      singletonUserId = options.userId;
      singletonDeviceId = options.deviceId || singletonDeviceId;
      if (isConnected) sendAuth();
    }
  }, [options?.userId, options?.accessToken, options?.deviceId]);

  // Visibility/network events
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        const inactive = Date.now() - lastActivity;
        if (inactive > 3000) {
          forceReconnect();
          queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
          queryClient.invalidateQueries({ queryKey: ["/api/v2/conversations"] });
        }
      } else {
        lastActivity = Date.now();
      }
    };
    const onOnline = () => {
      forceReconnect();
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/v2/conversations"] });
    };
    const onForce = () => forceReconnect();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onVisible);
    window.addEventListener("force-reconnect", onForce);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("force-reconnect", onForce);
    };
  }, []);

  // --- Send helpers ---
  const sendTalkingMessage = useCallback((message: TalkingMessage) => {
    if (ws?.readyState === WebSocket.OPEN && isAuthenticated) {
      ws.send(JSON.stringify({ type: "talking.message", data: message }));
    }
  }, []);

  const sendLightboxShow = useCallback((content: LightboxContent) => {
    if (ws?.readyState === WebSocket.OPEN && isAuthenticated) {
      ws.send(JSON.stringify({ type: "lightbox.show", data: content }));
    }
  }, []);

  const sendLightboxHide = useCallback(() => {
    if (ws?.readyState === WebSocket.OPEN && isAuthenticated) {
      ws.send(JSON.stringify({ type: "lightbox.hide" }));
    }
  }, []);

  const sendDashboardCommand = useCallback((command: DashboardCommand) => {
    if (ws?.readyState === WebSocket.OPEN && isAuthenticated) {
      ws.send(JSON.stringify({ type: "dashboard.command", data: command }));
    }
  }, []);

  const sendDashboardUpdate = useCallback((update: { section: string; data: any }) => {
    if (ws?.readyState === WebSocket.OPEN && isAuthenticated) {
      ws.send(JSON.stringify({ type: "dashboard.update", data: update }));
    }
  }, []);

  const sendTypingUpdate = useCallback((text: string, conversationId?: number) => {
    if (ws?.readyState === WebSocket.OPEN && isAuthenticated && text.length >= 10) {
      ws.send(JSON.stringify({ type: "typing.update", data: { text, conversationId } }));
    }
  }, []);

  return {
    sendTalkingMessage,
    sendLightboxShow,
    sendLightboxHide,
    sendDashboardCommand,
    sendDashboardUpdate,
    sendTypingUpdate,
  };
}
