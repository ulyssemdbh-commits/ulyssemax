import { db } from "../db";
import { taskQueues, taskQueueItems } from "@shared/schema";
import { eq, and, asc, or, desc } from "drizzle-orm";
import { emitTaskProgress, broadcastToUser } from "./realtimeSync";
import OpenAI from "openai";

const openai = new OpenAI();

interface QueueItemInput {
  title: string;
  description?: string;
  toolName?: string;
  toolArgs?: any;
}

interface TaskQueueCreateInput {
  userId: number;
  title: string;
  items: QueueItemInput[];
  source?: string;
  threadId?: number;
  delayBetweenItemsMs?: number;
}

const activeQueues = new Map<number, boolean>();
const queueDelays = new Map<number, number>();
let watchdogRunning = false;
const WATCHDOG_INTERVAL = 30 * 1000;
const MAX_ITEM_RETRIES = 5;
const ITEM_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];

export async function ensureTaskQueueTables() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS task_queues (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',
        status TEXT NOT NULL DEFAULT 'pending',
        total_items INTEGER NOT NULL DEFAULT 0,
        completed_items INTEGER NOT NULL DEFAULT 0,
        current_item_id INTEGER,
        thread_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS task_queue_items (
        id SERIAL PRIMARY KEY,
        queue_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        description TEXT,
        tool_name TEXT,
        tool_args JSONB,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        error TEXT,
        duration_ms INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);
    try {
      await db.execute(`ALTER TABLE task_queue_items ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
    } catch {}
  } catch (e: any) {
    if (!e.message?.includes("already exists")) {
      console.error("[TaskQueue] Table creation error:", e.message);
    }
  }
}

export async function createTaskQueue(input: TaskQueueCreateInput): Promise<{ queueId: number; itemCount: number }> {
  const [queue] = await db.insert(taskQueues).values({
    userId: input.userId,
    title: input.title,
    source: input.source || "chat",
    status: "pending",
    totalItems: input.items.length,
    completedItems: 0,
    threadId: input.threadId,
  }).returning();

  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    await db.insert(taskQueueItems).values({
      queueId: queue.id,
      sortOrder: i,
      title: item.title,
      description: item.description,
      toolName: item.toolName,
      toolArgs: item.toolArgs,
      status: "pending",
    });
  }

  if (input.delayBetweenItemsMs) {
    queueDelays.set(queue.id, input.delayBetweenItemsMs);
  }

  broadcastToUser(input.userId, {
    type: "taskqueue.created",
    userId: input.userId,
    data: { queueId: queue.id, title: input.title, itemCount: input.items.length },
    timestamp: Date.now(),
  });

  console.log(`[TaskQueue] Queue #${queue.id} created: "${input.title}" with ${input.items.length} items${input.delayBetweenItemsMs ? ` (delay: ${input.delayBetweenItemsMs / 1000}s between items)` : ''}`);
  return { queueId: queue.id, itemCount: input.items.length };
}

export async function startTaskQueue(queueId: number, userId?: number): Promise<string> {
  if (activeQueues.get(queueId)) {
    return "Queue already running";
  }

  const conditions = userId 
    ? and(eq(taskQueues.id, queueId), eq(taskQueues.userId, userId))
    : eq(taskQueues.id, queueId);
  const [queue] = await db.select().from(taskQueues).where(conditions);
  if (!queue) return "Queue not found";
  if (queue.status === "completed") return "Queue already completed";

  activeQueues.set(queueId, true);

  await db.update(taskQueues).set({ status: "running", startedAt: new Date() }).where(eq(taskQueues.id, queueId));

  broadcastToUser(queue.userId, {
    type: "taskqueue.started",
    userId: queue.userId,
    data: { queueId, title: queue.title },
    timestamp: Date.now(),
  });

  executeQueueItems(queueId, queue.userId).catch(err => {
    console.error(`[TaskQueue] Queue #${queueId} execution error:`, err);
    activeQueues.delete(queueId);
  });

  return `Queue "${queue.title}" started with ${queue.totalItems} tasks`;
}

async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function executeQueueItems(queueId: number, userId: number) {
  try {
    const items = await db.select().from(taskQueueItems)
      .where(eq(taskQueueItems.queueId, queueId))
      .orderBy(asc(taskQueueItems.sortOrder));

    let completedCount = 0;
    const totalItems = items.length;

    for (const item of items) {
      if (!activeQueues.get(queueId)) {
        console.log(`[TaskQueue] Queue #${queueId} paused/stopped`);
        break;
      }

      if (item.status === "completed" || item.status === "skipped") {
        completedCount++;
        continue;
      }

      const retryCount = (item as any).retry_count || (item as any).retryCount || 0;

      if (item.status === "failed" && retryCount >= MAX_ITEM_RETRIES) {
        console.log(`[TaskQueue] Queue #${queueId} item "${item.title}" max retries (${MAX_ITEM_RETRIES}) reached — skipping`);
        completedCount++;
        continue;
      }

      const startTime = Date.now();
      await db.update(taskQueueItems).set({ status: "running", startedAt: new Date() }).where(eq(taskQueueItems.id, item.id));
      await db.update(taskQueues).set({ currentItemId: item.id }).where(eq(taskQueues.id, queueId));

      emitTaskProgress(userId, {
        taskId: `queue-${queueId}`,
        stage: item.title,
        percentage: Math.round((completedCount / totalItems) * 100),
        currentStep: item.title,
        totalSteps: totalItems,
        currentStepIndex: completedCount,
      });

      broadcastToUser(userId, {
        type: "taskqueue.item_started",
        userId,
        data: { queueId, itemId: item.id, title: item.title, index: completedCount, total: totalItems, retry: retryCount },
        timestamp: Date.now(),
      });

      try {
        const result = await executeWithTimeout(
          executeQueueItem(item, userId),
          ITEM_TIMEOUT_MS,
          item.title
        );
        const durationMs = Date.now() - startTime;

        await db.update(taskQueueItems).set({
          status: "completed",
          result: typeof result === "string" ? result.slice(0, 5000) : JSON.stringify(result).slice(0, 5000),
          durationMs,
          completedAt: new Date(),
        }).where(eq(taskQueueItems.id, item.id));

        completedCount++;
        await db.update(taskQueues).set({ completedItems: completedCount }).where(eq(taskQueues.id, queueId));

        broadcastToUser(userId, {
          type: "taskqueue.item_completed",
          userId,
          data: { queueId, itemId: item.id, title: item.title, result: typeof result === "string" ? result.slice(0, 500) : "Done", durationMs, index: completedCount, total: totalItems },
          timestamp: Date.now(),
        });

        console.log(`[TaskQueue] Queue #${queueId} item ${completedCount}/${totalItems}: "${item.title}" completed in ${durationMs}ms`);

        const itemDelay = queueDelays.get(queueId);
        if (itemDelay && completedCount < totalItems) {
          console.log(`[TaskQueue] Queue #${queueId} waiting ${itemDelay / 1000}s before next item...`);
          broadcastToUser(userId, {
            type: "taskqueue.item_waiting",
            userId,
            data: { queueId, nextIn: itemDelay, completedSoFar: completedCount, total: totalItems },
            timestamp: Date.now(),
          });
          await new Promise(r => setTimeout(r, itemDelay));
        }
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        const newRetryCount = retryCount + 1;
        const shouldRetry = newRetryCount < MAX_ITEM_RETRIES;

        await db.update(taskQueueItems).set({
          status: shouldRetry ? "pending" : "failed",
          error: err.message?.slice(0, 2000),
          durationMs,
          completedAt: shouldRetry ? null : new Date(),
        }).where(eq(taskQueueItems.id, item.id));

        try {
          await db.execute(`UPDATE task_queue_items SET retry_count = ${newRetryCount} WHERE id = ${item.id}`);
        } catch {}

        if (shouldRetry) {
          console.log(`[TaskQueue] Queue #${queueId} item "${item.title}" failed (attempt ${newRetryCount}/${MAX_ITEM_RETRIES}) — will retry`);
          broadcastToUser(userId, {
            type: "taskqueue.item_retrying",
            userId,
            data: { queueId, itemId: item.id, title: item.title, error: err.message?.slice(0, 500), attempt: newRetryCount, maxRetries: MAX_ITEM_RETRIES },
            timestamp: Date.now(),
          });
          const retryDelay = RETRY_DELAYS[Math.min(newRetryCount - 1, RETRY_DELAYS.length - 1)];
          console.log(`[TaskQueue] Waiting ${retryDelay / 1000}s before retry...`);
          await new Promise(r => setTimeout(r, retryDelay));
        } else {
          completedCount++;
          await db.update(taskQueues).set({ completedItems: completedCount }).where(eq(taskQueues.id, queueId));

          broadcastToUser(userId, {
            type: "taskqueue.item_failed",
            userId,
            data: { queueId, itemId: item.id, title: item.title, error: err.message?.slice(0, 500), durationMs, index: completedCount, total: totalItems, retries: newRetryCount },
            timestamp: Date.now(),
          });

          console.error(`[TaskQueue] Queue #${queueId} item "${item.title}" failed after ${newRetryCount} attempts:`, err.message);
        }
      }

      emitTaskProgress(userId, {
        taskId: `queue-${queueId}`,
        stage: completedCount >= totalItems ? "Terminé" : items[completedCount]?.title || "Suivant",
        percentage: Math.round((completedCount / totalItems) * 100),
        currentStep: completedCount >= totalItems ? "Toutes les tâches terminées" : items[completedCount]?.title,
        totalSteps: totalItems,
        currentStepIndex: completedCount,
      });
    }

    const pendingAfterLoop = await db.select().from(taskQueueItems)
      .where(and(eq(taskQueueItems.queueId, queueId), eq(taskQueueItems.status, "pending")));

    if (pendingAfterLoop.length > 0 && activeQueues.get(queueId)) {
      console.log(`[TaskQueue] Queue #${queueId} has ${pendingAfterLoop.length} pending items after loop (retries) — re-executing`);
      return executeQueueItems(queueId, userId);
    }

    const finalStatus = activeQueues.get(queueId) ? "completed" : "paused";

    if (finalStatus === "completed") {
      const completedItemsList = await db.select().from(taskQueueItems)
        .where(eq(taskQueueItems.queueId, queueId))
        .orderBy(asc(taskQueueItems.sortOrder));
      
      const successCount = completedItemsList.filter(i => i.status === "completed").length;
      const failCount = completedItemsList.filter(i => i.status === "failed").length;
      const totalDuration = completedItemsList.reduce((sum, i) => sum + (i.durationMs || 0), 0);

      await db.update(taskQueues).set({
        status: "completed",
        completedAt: new Date(),
        currentItemId: null,
      }).where(eq(taskQueues.id, queueId));

      const [queueInfo] = await db.select().from(taskQueues).where(eq(taskQueues.id, queueId));

      broadcastToUser(userId, {
        type: "taskqueue.completed",
        userId,
        data: { 
          queueId, 
          title: queueInfo?.title,
          completedItems: completedCount, 
          totalItems, 
          successCount,
          failCount,
          totalDurationMs: totalDuration,
          summary: completedItemsList.map(i => ({ title: i.title, status: i.status, durationMs: i.durationMs })),
        },
        timestamp: Date.now(),
      });

      console.log(`[TaskQueue] ✅ Queue #${queueId} "${queueInfo?.title}" completed: ${successCount}/${totalItems} OK, ${failCount} failed, total ${Math.round(totalDuration / 1000)}s`);

      try {
        const { broadcastToUser: sendNotif } = await import("./realtimeSync");
        sendNotif(userId, {
          type: "notification",
          userId,
          data: {
            title: `✅ Queue terminée: ${queueInfo?.title || 'Tâches'}`,
            body: `${successCount}/${totalItems} tâches OK${failCount > 0 ? `, ${failCount} échouées` : ''}. Durée: ${Math.round(totalDuration / 1000)}s`,
            level: failCount > 0 ? "warning" : "success",
          },
          timestamp: Date.now(),
        });
      } catch {}
    }

    activeQueues.delete(queueId);
  } catch (err: any) {
    await db.update(taskQueues).set({ status: "failed" }).where(eq(taskQueues.id, queueId));
    activeQueues.delete(queueId);
    console.error(`[TaskQueue] Queue #${queueId} fatal error:`, err);
  }
}

async function executeQueueItem(item: any, userId: number): Promise<string> {
  if (item.toolName && item.toolArgs) {
    const { executeToolCallV2 } = await import("./ulysseToolsServiceV2");
    const args = typeof item.toolArgs === "string" ? JSON.parse(item.toolArgs) : item.toolArgs;
    return await executeToolCallV2(item.toolName, args, userId);
  }

  const { ulysseToolsV2, executeToolCallV2 } = await import("./ulysseToolsServiceV2");

  const devopsToolNames = ['devops_github', 'devops_server', 'devmax_db', 'dgm_manage', 'task_queue_manage', 'work_journal_manage', 'devops_intelligence', 'monitoring_manage', 'manage_ai_system', 'manage_feature_flags', 'query_apptoorder', 'dashboard_screenshot', 'web_search', 'read_url', 'query_brain', 'memory_save', 'analyze_file', 'generate_file'];
  const coreTools = ulysseToolsV2.slice(0, 40);
  const devopsTools = ulysseToolsV2.filter((t: any) => devopsToolNames.includes(t.function?.name) && !coreTools.some((c: any) => c.function?.name === t.function?.name));
  const toolDefs = [...coreTools, ...devopsTools];

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `Tu es Ulysse, l'assistant personnel autonome de Maurice. Tu travailles 24h/24 7j/7 en arrière-plan.
Tu exécutes une tâche de ta file d'attente. Tu as accès à tous tes outils habituels.
Utilise les outils nécessaires pour accomplir cette tâche de manière concrète et factuelle.
Ne te contente pas de décrire ce qu'il faudrait faire — FAIS-LE.
Si tu ne peux pas utiliser d'outil, donne une réponse utile et concrète.
RÈGLE ABSOLUE: Tu ne t'arrêtes JAMAIS avant d'avoir terminé la tâche à 100%.
Si un outil échoue, réessaie avec une approche différente. Ne renonce JAMAIS.

Tâche à exécuter: "${item.title}"${item.description ? `\nDétails: ${item.description}` : ""}`,
    },
    { role: "user", content: `Exécute cette tâche maintenant: ${item.title}` },
  ];

  let workingMessages = [...messages];
  let maxRounds = 5;
  let round = 0;
  let lastContent = "";

  while (round < maxRounds) {
    round++;
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: workingMessages,
      tools: toolDefs,
      tool_choice: "auto",
      max_tokens: 4000,
    });

    const msg = response.choices[0]?.message;

    if (msg?.tool_calls?.length) {
      const toolResults: string[] = [];
      workingMessages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments);
          console.log(`[TaskQueue] Autonomous tool call (round ${round}): ${tc.function.name}`);
          const result = await executeToolCallV2(tc.function.name, args, userId);
          toolResults.push(`[${tc.function.name}] ${result.slice(0, 1000)}`);
          workingMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.slice(0, 3000),
          });
        } catch (e: any) {
          const errMsg = `Error: ${e.message}`;
          toolResults.push(`[${tc.function.name}] ${errMsg}`);
          workingMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: errMsg,
          });
        }
      }
      lastContent = toolResults.join("\n");
      continue;
    }

    lastContent = msg?.content || lastContent || "Tâche exécutée";
    break;
  }

  if (round >= maxRounds) {
    const summary = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        ...workingMessages,
        { role: "user", content: "Résume ce que tu as fait pour cette tâche en 2-3 phrases." },
      ],
      max_tokens: 500,
    });
    return summary.choices[0]?.message?.content || lastContent;
  }

  return lastContent;
}

export async function pauseTaskQueue(queueId: number, userId: number): Promise<string> {
  activeQueues.delete(queueId);
  await db.update(taskQueues).set({ status: "paused" }).where(and(eq(taskQueues.id, queueId), eq(taskQueues.userId, userId)));
  broadcastToUser(userId, { type: "taskqueue.paused", userId, data: { queueId }, timestamp: Date.now() });
  return "Queue paused";
}

export async function getTaskQueueStatus(queueId: number, userId: number) {
  const [queue] = await db.select().from(taskQueues).where(and(eq(taskQueues.id, queueId), eq(taskQueues.userId, userId)));
  if (!queue) return null;

  const items = await db.select().from(taskQueueItems)
    .where(eq(taskQueueItems.queueId, queueId))
    .orderBy(asc(taskQueueItems.sortOrder));

  return { queue, items };
}

export async function getActiveQueues(userId: number) {
  return db.select().from(taskQueues)
    .where(and(eq(taskQueues.userId, userId), eq(taskQueues.status, "running")));
}

export async function getRecentQueues(userId: number, limit = 10) {
  return db.select().from(taskQueues)
    .where(eq(taskQueues.userId, userId))
    .orderBy(desc(taskQueues.createdAt))
    .limit(limit);
}

export async function resumeInterruptedQueues(): Promise<number> {
  try {
    const interrupted = await db.select().from(taskQueues)
      .where(or(eq(taskQueues.status, "running"), eq(taskQueues.status, "pending")));

    if (interrupted.length === 0) {
      console.log("[TaskQueue] No interrupted queues to resume");
      return 0;
    }

    let resumed = 0;
    for (const queue of interrupted) {
      if (activeQueues.get(queue.id)) continue;

      const pendingItems = await db.select().from(taskQueueItems)
        .where(and(eq(taskQueueItems.queueId, queue.id), or(eq(taskQueueItems.status, "pending"), eq(taskQueueItems.status, "running"))));

      if (pendingItems.length === 0) {
        await db.update(taskQueues).set({ status: "completed", completedAt: new Date() }).where(eq(taskQueues.id, queue.id));
        console.log(`[TaskQueue] Queue #${queue.id} had no pending items — marked completed`);
        continue;
      }

      const runningItems = await db.select().from(taskQueueItems)
        .where(and(eq(taskQueueItems.queueId, queue.id), eq(taskQueueItems.status, "running")));
      for (const ri of runningItems) {
        await db.update(taskQueueItems).set({ status: "pending", startedAt: null }).where(eq(taskQueueItems.id, ri.id));
      }

      console.log(`[TaskQueue] ♻️ Resuming interrupted queue #${queue.id}: "${queue.title}" (${pendingItems.length} items remaining)`);
      activeQueues.set(queue.id, true);
      await db.update(taskQueues).set({ status: "running", startedAt: queue.startedAt || new Date() }).where(eq(taskQueues.id, queue.id));

      broadcastToUser(queue.userId, {
        type: "taskqueue.started",
        userId: queue.userId,
        data: { queueId: queue.id, title: queue.title, resumed: true },
        timestamp: Date.now(),
      });

      executeQueueItems(queue.id, queue.userId).catch(err => {
        console.error(`[TaskQueue] Resume execution error for queue #${queue.id}:`, err);
        activeQueues.delete(queue.id);
      });

      resumed++;
    }

    if (resumed > 0) {
      console.log(`[TaskQueue] ✅ Resumed ${resumed} interrupted queue(s)`);
    }
    return resumed;
  } catch (e: any) {
    console.error("[TaskQueue] Resume error:", e.message);
    return 0;
  }
}

export function startWatchdog() {
  if (watchdogRunning) return;
  watchdogRunning = true;

  console.log("[TaskQueue] 🐕 Watchdog started — checking for orphaned queues every 30 seconds");

  setInterval(async () => {
    try {
      const orphaned = await db.select().from(taskQueues)
        .where(and(
          or(eq(taskQueues.status, "running"), eq(taskQueues.status, "pending")),
        ));

      for (const q of orphaned) {
        if (!activeQueues.get(q.id)) {
          console.log(`[TaskQueue] 🐕 Watchdog found orphaned queue #${q.id}: "${q.title}" — resuming`);
          activeQueues.set(q.id, true);
          await db.update(taskQueues).set({ status: "running" }).where(eq(taskQueues.id, q.id));

          const runningItems = await db.select().from(taskQueueItems)
            .where(and(eq(taskQueueItems.queueId, q.id), eq(taskQueueItems.status, "running")));
          for (const ri of runningItems) {
            await db.update(taskQueueItems).set({ status: "pending", startedAt: null }).where(eq(taskQueueItems.id, ri.id));
          }

          executeQueueItems(q.id, q.userId).catch(err => {
            console.error(`[TaskQueue] Watchdog resume error for queue #${q.id}:`, err);
            activeQueues.delete(q.id);
          });
        }
      }
    } catch (e: any) {
      console.error("[TaskQueue] Watchdog error:", e.message);
    }
  }, WATCHDOG_INTERVAL);
}

export async function enqueueBackgroundDevOps(userId: number, title: string, toolCalls: Array<{ name: string; args: any }>, threadId?: number): Promise<{ queueId: number; message: string }> {
  const items: QueueItemInput[] = toolCalls.map((tc, i) => ({
    title: `${i + 1}. ${tc.name}: ${JSON.stringify(tc.args).slice(0, 100)}`,
    description: JSON.stringify(tc.args),
    toolName: tc.name,
    toolArgs: tc.args,
  }));

  const queue = await createTaskQueue({
    userId,
    title: `DevOps Background: ${title}`,
    items,
    source: "devops_background",
    threadId,
  });

  await startTaskQueue(queue.queueId);

  console.log(`[TaskQueue] 🚀 Background DevOps queue #${queue.queueId} started: "${title}" (${items.length} tool calls)`);

  return {
    queueId: queue.queueId,
    message: `Tâche DevOps lancée en arrière-plan (${items.length} étapes). Je continue même si tu fermes la page. Queue #${queue.queueId}.`,
  };
}

export function getActiveQueueCount(): number {
  return activeQueues.size;
}
