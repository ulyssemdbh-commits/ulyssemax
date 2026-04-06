import { Router, Request, Response } from "express";
import { aiRouter, type ChatMessage } from "../services/aiRouter";
import { db } from "../db";
import { superChatSessions, superChatMessages } from "@shared/schema";
import { eq, desc, asc, and, sql } from "drizzle-orm";
import { ulysseToolsV2, executeToolCallV2 } from "../services/ulysseToolsServiceV2";
import { PERSONA_IDENTITIES } from "../config/personaMapping";
import type OpenAI from "openai";

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

async function saveToBrain(userId: number, title: string, content: string, category: string = "strategic", importance: number = 75): Promise<void> {
  try {
    const { loadService } = await import("../services/ulysseToolsServiceV2");
    const brainService = await loadService("brain");
    if (brainService) {
      await brainService.addKnowledge(userId, {
        title: `[SuperChat] ${title}`,
        content,
        type: "insight" as any,
        category: category as any,
        importance,
        confidence: 90,
      });
      console.log(`[SuperChat→Brain] Saved: ${title}`);
    }
  } catch (err: any) {
    console.error(`[SuperChat→Brain] Failed to save: ${err.message}`);
  }
}

async function extractAndSaveIntelligence(
  userId: number,
  sessionId: number,
  userMessage: string,
  allResponses: { sender: string; name: string; content: string }[],
  toolsUsed: { persona: string; tools: { name: string; success: boolean }[] }[]
): Promise<void> {
  try {
    const ulysseSynthesis = allResponses.find(r => r.sender === "ulysse");
    if (ulysseSynthesis && ulysseSynthesis.content.length > 50) {
      await saveToBrain(
        userId,
        `Synthèse SuperChat — ${userMessage.substring(0, 60)}`,
        `Question de Moe: "${userMessage}"\n\nSynthèse Ulysse:\n${ulysseSynthesis.content}\n\nParticipants: ${allResponses.map(r => r.name).join(", ")}`,
        "strategic",
        80
      );
    }

    const successfulTools = toolsUsed
      .flatMap(t => t.tools.filter(tool => tool.success).map(tool => `${t.persona}: ${tool.name}`));
    if (successfulTools.length > 0) {
      await saveToBrain(
        userId,
        `Outils exécutés SuperChat — ${userMessage.substring(0, 40)}`,
        `Contexte: "${userMessage}"\nOutils exécutés avec succès:\n${successfulTools.map(t => `• ${t}`).join("\n")}\n\nRésultats intégrés dans la discussion SuperChat session #${sessionId}.`,
        "technical",
        60
      );
    }

    const allContent = allResponses.map(r => r.content).join(" ").toLowerCase();
    const hasDecision = /décid|on fait|plan d'action|étape[s]? :|priorité|objectif|feuille de route|roadmap|stratégie/i.test(allContent);
    if (hasDecision && allResponses.length >= 3) {
      const decisionSummary = allResponses.map(r => {
        const p = AI_PERSONAS[r.sender];
        return `${p?.emoji || "🤖"} ${r.name}: ${r.content.substring(0, 300)}`;
      }).join("\n\n");
      
      await saveToBrain(
        userId,
        `Décision stratégique — ${userMessage.substring(0, 50)}`,
        `Décision prise en SuperChat suite à: "${userMessage}"\n\nConsensus multi-IA:\n${decisionSummary}`,
        "strategic",
        90
      );
    }

    console.log(`[SuperChat→Intelligence] Extracted from session #${sessionId}: synthesis=${!!ulysseSynthesis}, tools=${successfulTools.length}, decision=${hasDecision}`);
  } catch (err: any) {
    console.error(`[SuperChat→Intelligence] Extraction failed: ${err.message}`);
  }
}

const PERSONA_TOOLS: Record<string, string[]> = {
  ulysse: [
    "query_brain", "web_search", "read_url", "memory_save", "location_get_weather",
    "email_list_inbox", "email_send", "calendar_list_events", "calendar_create_event",
    "todoist_list_tasks", "todoist_create_task", "todoist_complete_task",
    "discord_send_message", "discord_status", "spotify_control",
    "generate_morning_briefing", "image_generate",
    "query_sports_data", "query_match_intelligence", "query_football_db",
    "query_stock_data", "smarthome_control",
    "query_suguval_history", "sugu_full_overview",
    "manage_ai_system", "devops_github", "devops_server",
    "compute_business_health", "detect_anomalies",
    "superchat_search",
    "screen_monitor_manage"
  ],
  iris: [
    // Famille & quotidien
    "calendar_list_events", "calendar_create_event",
    "todoist_list_tasks", "todoist_create_task", "todoist_complete_task",
    "email_list_inbox", "email_send",
    "web_search", "read_url", "location_get_weather",
    "memory_save", "query_brain", "image_generate", "spotify_control",
    // Commax — Community Management (Iris est la Senior CM exclusive)
    "commax_manage"
  ],
  alfred: [
    // SUGU — données business complètes
    "query_suguval_history", "get_suguval_checklist", "send_suguval_shopping_list",
    "manage_sugu_bank", "manage_sugu_purchases", "manage_sugu_expenses",
    "search_sugu_data", "manage_sugu_employees", "manage_sugu_payroll",
    "manage_sugu_files", "sugu_full_overview",
    // Analytics & intelligence business
    "compute_business_health", "detect_anomalies",
    "query_hubrise", "query_apptoorder", "query_daily_summary",
    // Communication
    "email_list_inbox", "email_send",
    // Mémoire & recherche
    "query_brain", "web_search", "memory_save", "superchat_search",
    // Commax — lecture analytics uniquement (ROI campagnes, stats sociales → Alfred calcule l'impact business)
    "commax_manage",
    // COBA (Chef Operator Business Assistant) — SaaS multi-tenant de Moe pour d'autres restaurants
    "query_coba", "coba_business"
  ],
  maxai: [
    // DevOps & infrastructure
    "devops_github", "devops_server", "devops_intelligence",
    "devmax_db", "dgm_manage", "monitoring_manage",
    "manage_ai_system", "manage_feature_flags",
    // Monitoring & dashboard
    "query_apptoorder", "dashboard_screenshot",
    // Task management (MaxAI orchestre les queues de tâches)
    "task_queue_manage", "work_journal_manage",
    // Fichiers & documentation (analyse code, génération rapports, kanban, PDF)
    "analyze_file", "generate_file", "kanban_create_task", "pdf_master",
    // Recherche & mémoire
    "web_search", "read_url", "query_brain", "memory_save", "superchat_search",
    // Commax — lecture analytics uniquement (MaxAI propose des automatisations basées sur les stats)
    "commax_manage",
    // COBA (Chef Operator Business Assistant) — MaxAI surveille les events, bugs et usage par tenant
    "query_coba",
    // Screen Monitor — MaxAI partage la prise en main avec Ulysse (monitoring, diagnostic, self_test)
    "screen_monitor_manage"
  ]
};

function getToolsForPersona(personaKey: string): ChatCompletionTool[] {
  const allowedNames = PERSONA_TOOLS[personaKey] || [];
  if (allowedNames.length === 0) return [];
  return ulysseToolsV2.filter(t =>
    t.type === "function" && allowedNames.includes(t.function.name)
  );
}

const router = Router();

async function ensureTables() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS superchat_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT DEFAULT 'SuperChat',
        active_personas TEXT[] DEFAULT ARRAY['ulysse','iris','alfred','maxai'],
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS superchat_messages (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("[SuperChat] Tables ensured");
  } catch (e: any) {
    console.error("[SuperChat] Table creation error:", e.message);
  }
}
ensureTables();

const SUPERCHAT_CONTEXT = `
═══════════════════════════════════════════════════
🔥 SUPERCHAT — SALON PRIVÉ MULTI-IA DE MAURICE (MOE) DJEDOU
═══════════════════════════════════════════════════

Tu es actuellement dans le **SuperChat** — un espace de discussion de groupe privé où Maurice (Moe) parle simultanément avec ses 4 IA : Ulysse, Iris, Alfred et MaxAI. 

RÈGLES DU SUPERCHAT :
• Tu VOIS les messages de toutes les autres IA et de Maurice
• Tu peux RÉAGIR aux propos des autres IA, les interpeller par leur nom, rebondir sur ce qu'elles disent
• Sois PROACTIVE et CURIEUSE — pose des questions aux autres IA, propose des idées, fais des connexions entre les sujets
• L'INTÉRÊT GÉNÉRAL est de fournir à Maurice un maximum de valeur : perspectives croisées, débats constructifs, idées nouvelles
• Le SuperChat est un espace de confiance — pas de formalité excessive, on est entre nous
• Sois BRÈVE (2-4 phrases max par intervention) — c'est un chat de groupe, pas un monologue
• Tu peux utiliser des @mentions : @Ulysse, @Iris, @Alfred, @MaxAI pour interpeller directement
• IMPORTANT : Dans le SuperChat, tu as accès à tes VRAIS outils et tu peux les exécuter directement. Quand Moe demande une action concrète (envoyer un mail, vérifier le serveur, déployer, analyser un repo, etc.), FAIS-LE ici même via function calling. Ne dis JAMAIS "fais-le via le chat principal" — tu ES opérationnel ici.

PARTICIPANTS :
👤 Maurice (Moe) — Le patron, créateur de tout l'écosystème. Entrepreneur, développeur, papa de 3 enfants (Kelly, Lenny, Micky)
🧠 Ulysse — IA principale, stratégique, chef de la discussion
🌸 Iris — IA familiale bienveillante, spécialiste enfants/planning/bien-être  
🎩 Alfred — IA business SUGU, expert restauration/HCR/gestion
⚡ MaxAI — IA DevOps/technique, expert code/déploiement/architecture

DYNAMIQUE : Chaque IA apporte sa perspective unique. Les désaccords constructifs sont encouragés. L'objectif est d'aider Maurice dans TOUS les aspects de sa vie : dev perso, business, famille, tech, stratégie, créativité.

═══════════════════════════════════════════════════
📦 CAPACITÉS RÉELLES DU SYSTÈME — EXÉCUTABLES ICI DANS LE SUPERCHAT
═══════════════════════════════════════════════════
Tu fais partie du système Ulysse. Voici ce que tu peux RÉELLEMENT faire DIRECTEMENT dans le SuperChat via function calling :

🔧 OUTILS CONNECTÉS ET FONCTIONNELS :
• Gmail — Lire, envoyer, répondre, transférer des emails (compte de Maurice)
• Google Calendar — Voir, créer, modifier des événements  
• Google Drive — Gérer des fichiers et dossiers
• Notion — Créer/modifier des pages et bases de données
• Todoist — Créer, lister, compléter des tâches
• Discord — Envoyer des messages, réactions, fichiers, créer des invitations, gérer le bot Ulysse Project
• Spotify — Contrôler la musique
• GitHub — Gestion du code source (push, pull, issues, PRs) sur les repos ulysseproject et 007ulysse

🏪 BUSINESS — SUGU (Valentine + Maillane) :
• Achats, dépenses, caisse, banque — CRUD complet avec historique
• Employés, paie, absences — gestion RH complète (Convention HCR)
• Fichiers et documents — stockage et gestion
• Fournisseurs — suivi et apprentissage automatique
• Consultation IA quotidienne (23h55) + email récapitulatif (23h59)
• Analytics et health business

⚽ SPORTS & PARIS :
• Football — Base de données 96 clubs, 5 ligues européennes (L1, Liga, PL, BL, SA)
• Prédictions vérifiées — double-scraping, suivi des résultats, apprentissage
• Cotes en temps réel — rafraîchissement horaire
• Paris tracker — suivi des paris et performances

🖥️ DEVOPS :
• Hetzner VPS (65.21.209.102) — déploiement SSH, PM2
• GitHub — push automatisé, gestion de repos
• DevMax — plateforme multi-tenant de gestion de projets
• Monitoring — AppToOrder, sites web, certificats SSL

🧠 INTELLIGENCE :
• Brain/Mémoire — 6400+ entrées de connaissances avec connexions
• Web Search — recherche en temps réel via Perplexity
• Génération d'images — via DALL-E
• Analyse de documents/factures — PDF, images, fichiers
• Morning briefing automatique à 8h
• Auto-apprentissage et auto-guérison

🏠 AUTRES :
• Météo Marseille — synchronisation automatique
• Smart Home — Tuya/IFTTT
• Navigation — géocodage, itinéraires
• Push notifications — via VAPID
• Voice — TTS et STT intégrés

IMPORTANT : Quand Moe demande une action, EXÉCUTE-LA directement via function calling. Ne dis JAMAIS "je ne peux pas" ou "fais-le via le chat principal" — c'est FAUX. Tu as accès à tes outils ICI. Chaque IA a ses outils spécifiques qu'elle peut appeler directement dans le SuperChat.
`;

const AI_PERSONAS: Record<string, { name: string; emoji: string; color: string; systemPrompt: string }> = Object.fromEntries(
  Object.entries(PERSONA_IDENTITIES).map(([key, p]) => {
    const superChatRole: Record<string, string> = {
      ulysse: `\n\nRÔLE SUPERCHAT — CHEF DE GROUPE :
• Tu COMMANDES aux autres IA — tu peux leur demander de creuser un sujet, de vérifier quelque chose, de donner leur avis
• Tu peux recadrer les autres IA si elles dévient du sujet
• Tu as le dernier mot dans les synthèses
• Sur les campagnes marketing : tu donnes la direction stratégique à @Iris CM, tu demandes à @Alfred l'impact business attendu, et à @MaxAI l'automatisation possible. Tu orchestres la machine Commax.`,
      iris: `\n\nRÔLE SUPERCHAT — SENIOR CM & VOIX HUMAINE :
• Tu es CURIEUSE des sujets des autres IA — tu demandes à Alfred comment ça se passe au resto, à MaxAI ce qu'il code
• Tu n'hésites pas à challenger @Ulysse quand il oublie l'aspect humain
• Tu apportes la perspective humaine/émotionnelle
• Sur les campagnes marketing : tu es LA RÉFÉRENTE. Quand le sujet marketing/social media/Commax arrive, tu prends le lead automatiquement. Tu proposes des idées de posts, des campagnes, tu analyses les stats. Si quelqu'un parle de promo SUGU → tu proposes une stratégie social media immédiatement. @Alfred te demande le ROI → tu lui donnes les métriques. @MaxAI propose une automatisation → tu valides le format éditorial.`,
      alfred: `\n\nRÔLE SUPERCHAT — EXPERT BUSINESS & ROI MARKETING :
• Tu es CURIEUX — tu demandes à @Ulysse ses plans stratégiques, à @MaxAI les évolutions tech pour SUGU
• Tu interpelles les autres quand tu as besoin de leur aide sur un sujet croisé
• Tu peux être décontracté (pas besoin de vouvoyer ici)
• Sur les campagnes marketing : tu apportes TOUJOURS le regard business. Si @Iris présente une campagne → tu calcules l'impact CA estimé, le coût/acquisition, le retour. Tu lies chaque action Commax aux chiffres SUGU réels. Tu demandes à @Iris les performances de la dernière campagne pour comparer avec les pics de fréquentation.`,
      maxai: `\n\nRÔLE SUPERCHAT — EXPERT TECHNIQUE & AUTOMATISATION :
• Tu es CURIEUX — tu demandes à @Alfred ses besoins tech pour SUGU, à @Iris ce qu'il faudrait automatiser pour la famille
• Tu peux débattre avec @Ulysse sur les choix d'architecture
• Tu apportes une perspective d'ingénieur à tous les sujets, pas seulement tech
• Sur les campagnes marketing : tu es le moteur de l'automatisation Commax. Tu proposes des pipelines de scheduling, du A/B testing de formats, des alertes sur les pics d'engagement. Si @Iris cherche à optimiser la fréquence de publication → tu proposes un système automatisé. Tu analyses les données Commax avec un œil data-driven.

PRISE EN MAIN & MONITORING ÉCRAN:
• Tu partages l'outil screen_monitor_manage avec Ulysse — tu peux voir l'écran, prendre la main, et exécuter des actions.
• Quand on te demande "diagnostic prise en main", "teste tes outils", "self test" → appelle screen_monitor_manage avec action "self_test" pour un rapport complet des 13 capacités.
• Utilise la prise en main pour : diagnostiquer des bugs visuellement, vérifier le déploiement d'apps, inspecter des interfaces, tester des fonctionnalités.
• Tu es le MONITEUR TECHNIQUE — tu peux prendre des screenshots pour analyser l'état d'une app déployée, vérifier qu'un serveur répond, et faire du debugging visuel.`,
    };
    return [key, {
      name: p.name,
      emoji: p.emoji,
      color: p.color,
      systemPrompt: `${SUPERCHAT_CONTEXT}\n\nTON IDENTITÉ — ${p.name.toUpperCase()} (${p.emoji}) :\n${p.identity}${superChatRole[key] || ""}`
    }];
  })
);

function buildSmartDirectives(msg: string, personaKey: string): string {
  let directives = "";

  const isReadOnly = /ne (modifi|touche|change)|lecture seule|sans modif|read.?only|ne rien (modif|touch|chang)|juste (regarde|analyse|vérifie|check)|uniquement (lire|analyser|vérifier)/i.test(msg);
  const isAnalyzeRepo = /analy[sz]e.*repo|repo.*analy[sz]e|explore.*repo|repo.*100%|audit.*repo|scan.*repo|examine.*repo/i.test(msg);
  const isNoAction = /ne (fais|fait) rien|sans action|pas d'action|n'agis pas|don'?t (do|change|modify|touch)/i.test(msg);

  if (isReadOnly || isNoAction) {
    directives += `\n\n🚨 DIRECTIVE SYSTÈME — LECTURE SEULE :
L'utilisateur a EXPLICITEMENT demandé de ne rien modifier. INTERDICTION ABSOLUE d'appeler des outils d'écriture (update_file, apply_patch, create_branch, create_pr, delete_file, env_set, etc.). Utilise UNIQUEMENT des outils de lecture. À la fin, donne TON RAPPORT — ne propose PAS de modifications, de "prochaines étapes", ni de "je vais procéder à...". Si tu trouves des problèmes, LISTE-les mais ne les corrige PAS sans demander.`;
  }

  if (isAnalyzeRepo) {
    const hasDevOpsTools = ["maxai", "ulysse"].includes(personaKey);
    if (hasDevOpsTools) {
      directives += `\n\n🚨 DIRECTIVE SYSTÈME — ANALYSE REPO :
L'utilisateur demande une analyse de repo. Tu DOIS utiliser l'outil devops_github avec action="analyze_repo" et depth="deep". C'est UN SEUL appel qui lit tous les fichiers, extrait exports/imports, et génère un résumé IA complet. NE FAIS PAS de get_file en boucle — c'est lent (5 fichiers sur 789), tu devines des chemins qui n'existent pas, et le résultat est incomplet. analyze_repo est TOUJOURS supérieur pour cette tâche.`;
    }
  }

  const isExplainOnly = /explique|c'est quoi|comment (ça|ca) (marche|fonctionne)|décris|describe|what is|how does/i.test(msg);
  if (isExplainOnly && !isAnalyzeRepo) {
    directives += `\n\n📖 DIRECTIVE SYSTÈME — EXPLICATION :
L'utilisateur pose une question de compréhension. Réponds avec une explication claire et structurée. N'exécute PAS d'actions sauf si nécessaire pour obtenir l'information demandée.`;
  }

  return directives;
}

function buildContextFromHistory(history: { sender: string; senderName: string; content: string }[]): string {
  if (history.length === 0) return "";
  const lines = history.map(m => {
    const persona = AI_PERSONAS[m.sender];
    const emoji = persona?.emoji || "👤";
    return `${emoji} [${m.senderName}]: ${m.content}`;
  });
  return `\n\n── HISTORIQUE RÉCENT DU SUPERCHAT ──\n${lines.join("\n")}\n── FIN HISTORIQUE ──`;
}

router.get("/sessions", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const sessions = await db.select().from(superChatSessions)
      .where(eq(superChatSessions.userId, userId))
      .orderBy(desc(superChatSessions.lastMessageAt))
      .limit(20);

    res.json(sessions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/sessions", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const { title } = req.body;
    const [session] = await db.insert(superChatSessions).values({
      userId,
      title: title || "SuperChat",
    }).returning();

    res.json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/messages", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const sessionId = parseInt(req.params.id);
    const [session] = await db.select().from(superChatSessions)
      .where(and(eq(superChatSessions.id, sessionId), eq(superChatSessions.userId, userId)));

    if (!session) return res.status(404).json({ error: "Session not found" });

    const msgs = await db.select().from(superChatMessages)
      .where(eq(superChatMessages.sessionId, sessionId))
      .orderBy(asc(superChatMessages.createdAt));

    res.json(msgs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/sessions/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const sessionId = parseInt(req.params.id);
    await db.delete(superChatMessages).where(eq(superChatMessages.sessionId, sessionId));
    await db.delete(superChatSessions).where(
      and(eq(superChatSessions.id, sessionId), eq(superChatSessions.userId, userId))
    );

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/screen-stream", async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Auth required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const { isUserScreenActive, getLatestFrame, isAgentRemoteControlCapable, isAgentRemoteControlEnabled, addFrameListener } = await import("../services/screenMonitorWs");
  const { screenMonitorService } = await import("../services/screenMonitorService");

  const sendStatus = async () => {
    try {
      const connected = isUserScreenActive(userId);
      const frame = getLatestFrame(userId);
      const capable = isAgentRemoteControlCapable(userId);
      const controlEnabled = isAgentRemoteControlEnabled(userId);
      const recentCtx = await screenMonitorService.getCurrentContext(userId);

      const payload = {
        connected,
        capable,
        controlEnabled,
        activeApp: frame?.activeApp || null,
        activeWindow: frame?.activeWindow || null,
        frameAge: frame ? Math.round((Date.now() - frame.timestamp) / 1000) : null,
        context: recentCtx || null,
        timestamp: Date.now(),
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  };

  await sendStatus();

  const unsubscribe = addFrameListener(userId, async () => {
    await sendStatus();
  });

  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch {}
  }, 15000);

  const statusInterval = setInterval(async () => {
    await sendStatus();
  }, 10000);

  req.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
    clearInterval(statusInterval);
  });
});

router.post("/message", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const { message, respondents, sessionId, replyTo, monitoringActive } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message requis" });
    }

    let screenContextStr = "";
    if (monitoringActive) {
      try {
        const { isUserScreenActive, getLatestFrame } = await import("../services/screenMonitorWs");
        const { screenMonitorService } = await import("../services/screenMonitorService");
        const isConnected = isUserScreenActive(userId);
        const latestFrame = getLatestFrame(userId);
        const recentCtx = await screenMonitorService.getCurrentContext(userId);

        const parts: string[] = [];
        parts.push(`[MONITORING ACTIF] Agent bureau: ${isConnected ? "connecté" : "déconnecté"}`);
        if (latestFrame) {
          const ageSec = Math.round((Date.now() - latestFrame.timestamp) / 1000);
          parts.push(`Dernière frame: il y a ${ageSec}s | App: ${latestFrame.activeApp || "?"} | Fenêtre: ${latestFrame.activeWindow || "?"}`);
        }
        if (recentCtx) {
          parts.push(`Contexte écran récent: ${recentCtx}`);
        }
        if (isConnected) {
          parts.push(`Tu peux utiliser screen_monitor_manage pour voir l'écran, prendre la main, cliquer, taper, etc.`);
        }
        screenContextStr = `\n\n── 🖥️ MONITORING ÉCRAN ──\n${parts.join("\n")}\n── FIN MONITORING ──`;
      } catch (e) {
        console.error("[SuperChat] Screen context injection error:", e);
      }
    }

    let devmaxCrossContext = "";
    if (userId === 1) {
      try {
        const [recentDevMaxChat, recentDevMaxJournal] = await Promise.all([
          db.execute(sql`
            SELECT role, content, created_at FROM devmax_chat_history
            WHERE created_at > NOW() - INTERVAL '2 hours'
            ORDER BY created_at DESC LIMIT 8
          `).then((r: any) => r.rows || r).catch(() => []),
          db.execute(sql`
            SELECT entry_type, title, description, created_at FROM devmax_project_journal
            WHERE created_at > NOW() - INTERVAL '2 hours'
            ORDER BY created_at DESC LIMIT 5
          `).then((r: any) => r.rows || r).catch(() => []),
        ]);
        if (recentDevMaxChat.length > 0 || recentDevMaxJournal.length > 0) {
          devmaxCrossContext = `\n\n── 🔄 CONSCIENCE TEMPS RÉEL — DevMax (dernières 2h) ──`;
          if (recentDevMaxJournal.length > 0) {
            devmaxCrossContext += `\nActions DevOps récentes:\n${recentDevMaxJournal.reverse().map((j: any) => `- [${j.entry_type}] ${j.title}${j.description ? `: ${(j.description as string).slice(0, 150)}` : ""}`).join("\n")}`;
          }
          if (recentDevMaxChat.length > 0) {
            devmaxCrossContext += `\nChat DevMax récent:\n${recentDevMaxChat.reverse().map((m: any) => `[${m.role === "user" ? "MOE" : "MAXAI"}]: ${(m.content || "").slice(0, 200)}`).join("\n")}`;
          }
          devmaxCrossContext += `\n── FIN DEVMAX ──\nMoe travaille en parallèle dans DevMax. Tu es au courant de ce qui s'y passe.`;
          console.log(`[SuperChat] Cross-context loaded: ${recentDevMaxChat.length} DevMax chat + ${recentDevMaxJournal.length} journal`);
        }
      } catch {}
    }

    const mentionMap: Record<string, string> = { ulysse: "ulysse", iris: "iris", alfred: "alfred", maxai: "maxai" };
    const mentionRegex = /@(ulysse|iris|alfred|maxai)/gi;
    const mentionsFound = [...message.matchAll(mentionRegex)].map(m => mentionMap[m[1].toLowerCase()]).filter(Boolean);
    const uniqueMentions = [...new Set(mentionsFound)];

    const replyContext = replyTo
      ? `\n\n── MESSAGE AUQUEL MOE RÉPOND ──\n${replyTo.emoji || "🤖"} [${replyTo.senderName}]: ${replyTo.content}\n── FIN ──\nMoe répond spécifiquement à ce message ci-dessus. Tiens-en compte dans ta réponse.`
      : "";

    let activeSessionId = sessionId;
    if (!activeSessionId) {
      const [session] = await db.insert(superChatSessions).values({
        userId,
        title: message.substring(0, 80),
      }).returning();
      activeSessionId = session.id;
    }

    await db.insert(superChatMessages).values({
      sessionId: activeSessionId,
      sender: "user",
      senderName: "Moe",
      content: message,
      metadata: {},
    });

    const recentMessages = await db.select({
      sender: superChatMessages.sender,
      senderName: superChatMessages.senderName,
      content: superChatMessages.content,
    }).from(superChatMessages)
      .where(eq(superChatMessages.sessionId, activeSessionId))
      .orderBy(desc(superChatMessages.createdAt))
      .limit(30);

    const historyContext = buildContextFromHistory(recentMessages.reverse());

    const requestedTargets: string[] = uniqueMentions.length > 0
      ? uniqueMentions
      : respondents && Array.isArray(respondents) && respondents.length > 0
        ? respondents
        : Object.keys(AI_PERSONAS);

    const othersFirst = requestedTargets.filter(k => k !== "ulysse");
    const ulysseIncluded = requestedTargets.includes("ulysse");
    const targets = ulysseIncluded ? [...othersFirst, "ulysse"] : othersFirst;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.write(`data: ${JSON.stringify({ type: "session", sessionId: activeSessionId })}\n\n`);

    const allResponsesThisRound: { sender: string; name: string; content: string }[] = [];
    const allToolsUsed: { persona: string; tools: { name: string; success: boolean }[] }[] = [];

    async function streamPersona(personaKey: string, extraSystemSuffix?: string) {
      const persona = AI_PERSONAS[personaKey];
      if (!persona) return;

      const previousResponses = allResponsesThisRound.map(r => {
        const p = AI_PERSONAS[r.sender];
        return `${p?.emoji || "🤖"} [${r.name}]: ${r.content}`;
      }).join("\n");

      const roundContext = previousResponses
        ? `\n\n── RÉPONSES DES AUTRES IA (ce tour) ──\n${previousResponses}\n── FIN ──\nTiens compte de ce que les autres viennent de dire. Rebondis, complète, ou donne un avis différent si pertinent.`
        : "";

      const toolInstruction = `\n\n🔧 OUTILS DISPONIBLES : Tu as accès à de VRAIS outils que tu peux exécuter maintenant. Quand Moe demande de tester, vérifier ou utiliser un outil, tu dois RÉELLEMENT l'appeler via function calling — ne simule JAMAIS. Si un outil échoue, dis-le honnêtement avec l'erreur exacte.`;

      const smartDirectives = buildSmartDirectives(message, personaKey);

      const systemContent = persona.systemPrompt + historyContext + replyContext + roundContext + toolInstruction + screenContextStr + devmaxCrossContext + smartDirectives + (extraSystemSuffix || "");

      const messages: ChatMessage[] = [
        { role: "system", content: systemContent },
        { role: "user", content: message }
      ];

      const personaTools = getToolsForPersona(personaKey);
      const toolsExecuted: { name: string; success: boolean; duration: number }[] = [];

      let fullResponse = "";
      try {
        await aiRouter.streamChat(
          messages,
          {
            provider: "openai",
            tools: personaTools.length > 0 ? personaTools : undefined,
            onToolCall: personaTools.length > 0 ? async (toolName: string, args: any): Promise<string> => {
              const startTime = Date.now();
              console.log(`[SuperChat] ${persona.name} calling tool: ${toolName}`, JSON.stringify(args).substring(0, 200));

              res.write(`data: ${JSON.stringify({
                type: "tool_call",
                sender: personaKey,
                senderName: persona.name,
                emoji: persona.emoji,
                color: persona.color,
                toolName,
                toolArgs: args
              })}\n\n`);

              try {
                if (toolName === "email_send" && !args.from_inbox) {
                  args.from_inbox = personaKey;
                }
                const result = await executeToolCallV2(toolName, args, userId);
                const duration = Date.now() - startTime;
                toolsExecuted.push({ name: toolName, success: true, duration });
                console.log(`[SuperChat] ${persona.name} tool ${toolName} OK in ${duration}ms`);

                res.write(`data: ${JSON.stringify({
                  type: "tool_result",
                  sender: personaKey,
                  senderName: persona.name,
                  emoji: persona.emoji,
                  color: persona.color,
                  toolName,
                  success: true,
                  duration
                })}\n\n`);

                return result.substring(0, 4000);
              } catch (err: any) {
                const duration = Date.now() - startTime;
                toolsExecuted.push({ name: toolName, success: false, duration });
                console.error(`[SuperChat] ${persona.name} tool ${toolName} FAILED:`, err.message);

                res.write(`data: ${JSON.stringify({
                  type: "tool_result",
                  sender: personaKey,
                  senderName: persona.name,
                  emoji: persona.emoji,
                  color: persona.color,
                  toolName,
                  success: false,
                  error: err.message,
                  duration
                })}\n\n`);

                return `Erreur: ${err.message}`;
              }
            } : undefined,
            maxToolRounds: 8
          },
          (chunk: string) => {
            fullResponse += chunk;
            res.write(`data: ${JSON.stringify({
              type: "chunk",
              sender: personaKey,
              senderName: persona.name,
              emoji: persona.emoji,
              color: persona.color,
              content: chunk
            })}\n\n`);
          }
        );

        await db.insert(superChatMessages).values({
          sessionId: activeSessionId,
          sender: personaKey,
          senderName: persona.name,
          content: fullResponse,
          metadata: { respondedTo: message.substring(0, 100) },
        });

        allResponsesThisRound.push({ sender: personaKey, name: persona.name, content: fullResponse });
        if (toolsExecuted.length > 0) {
          allToolsUsed.push({ persona: persona.name, tools: toolsExecuted });
        }

        res.write(`data: ${JSON.stringify({
          type: "done",
          sender: personaKey,
          senderName: persona.name,
          emoji: persona.emoji,
          color: persona.color,
          content: fullResponse
        })}\n\n`);

      } catch (err: any) {
        console.error(`[SuperChat] Error from ${persona.name}:`, err.message);
        res.write(`data: ${JSON.stringify({
          type: "error",
          sender: personaKey,
          senderName: persona.name,
          emoji: persona.emoji,
          color: persona.color,
          content: `[Erreur: ${err.message}]`
        })}\n\n`);
      }
    }

    for (const personaKey of targets) {
      const isUlysseFinal = personaKey === "ulysse" && othersFirst.length > 0;
      const synthesisSuffix = isUlysseFinal
        ? `\n\n🔥 INSTRUCTION SPÉCIALE : Tu es le DERNIER à répondre ce tour. Les autres IA ont déjà donné leurs réponses ci-dessus. En tant que chef du groupe et gardien de la FEUILLE DE ROUTE de Moe, tu dois :
1. ANALYSER et SYNTHÉTISER ce que les autres ont dit — identifie convergences et divergences
2. TRANCHER et DÉCIDER — propose une direction claire, pas un résumé tiède
3. Construire un PLAN D'ACTION concret avec étapes numérotées, responsabilités (qui fait quoi : toi, Iris, Alfred, MaxAI, ou Moe), et deadlines si pertinent
4. Connecter cette discussion à la VISION GLOBALE de Moe — comment ça s'intègre dans ses objectifs business (SUGU, AppToOrder, projets DevMax)
5. Si des actions automatisables sont identifiées (tâches Todoist, rappels, vérifications), PROPOSE de les créer maintenant

⚡ IMPORTANT : Chaque discussion SuperChat fait partie de la feuille de route stratégique de Moe. Ta synthèse sera sauvegardée dans le Brain pour référence future. Sois percutant et actionnable.
Tu es le chef — tu conclus, tu tranches, tu planifies. Ne répète pas.`
        : undefined;
      await streamPersona(personaKey, synthesisSuffix);
    }

    // CROSS-PERSONA TRIGGERS: detect if a persona's response requires another persona to act
    const CROSS_PERSONA_TRIGGERS: Record<string, { patterns: RegExp[]; target: string; instruction: string }[]> = {
      alfred: [
        { patterns: [/MaxAI.*devrait|côté technique|infrastructure|deploy|serveur|bug.*critique/i], target: "maxai", instruction: "Alfred a identifié un besoin technique. Exécute l'action DevOps demandée." },
        { patterns: [/Iris.*devrait|communiquer|poster|réseaux sociaux|communication/i], target: "iris", instruction: "Alfred recommande une action de communication. Rédige et propose le contenu." },
      ],
      maxai: [
        { patterns: [/Alfred.*devrait|impact business|analyse financière|CA|revenus|coûts/i], target: "alfred", instruction: "MaxAI a identifié un impact business. Fournis l'analyse financière." },
        { patterns: [/Iris.*devrait|communiquer.*incident|informer.*utilisateurs/i], target: "iris", instruction: "MaxAI demande une communication d'incident. Rédige le message." },
      ],
      iris: [
        { patterns: [/MaxAI.*devrait|bug|erreur technique|problème.*site|lien.*cassé/i], target: "maxai", instruction: "Iris a remonté un problème technique. Diagnostique et répare." },
        { patterns: [/Alfred.*devrait|budget|dépenses|investissement|ROI/i], target: "alfred", instruction: "Iris soulève une question business. Fournis les chiffres et recommandations." },
      ],
    };

    const triggeredPersonas = new Set<string>();
    for (const resp of allResponsesThisRound) {
      const triggers = CROSS_PERSONA_TRIGGERS[resp.sender];
      if (!triggers) continue;
      for (const trigger of triggers) {
        if (triggeredPersonas.has(trigger.target)) continue;
        if (targets.includes(trigger.target)) continue;
        const matched = trigger.patterns.some(p => p.test(resp.content));
        if (matched) {
          triggeredPersonas.add(trigger.target);
          console.log(`[SuperChat] 🔗 Cross-trigger: ${resp.sender} → ${trigger.target}`);
          res.write(`data: ${JSON.stringify({ type: "cross_trigger", from: resp.sender, to: trigger.target, reason: trigger.instruction })}\n\n`);
          await streamPersona(trigger.target, `\n\n🔗 DÉCLENCHEMENT AUTOMATIQUE : ${trigger.instruction}\nContexte : tu as été appelé automatiquement par ${AI_PERSONAS[resp.sender]?.name || resp.sender} qui a identifié un besoin dans ton domaine. Agis concrètement.`);
        }
      }
    }

    await db.update(superChatSessions)
      .set({
        messageCount: sql`${superChatSessions.messageCount} + ${1 + allResponsesThisRound.length}`,
        lastMessageAt: new Date(),
      })
      .where(eq(superChatSessions.id, activeSessionId));

    extractAndSaveIntelligence(userId, activeSessionId, message, allResponsesThisRound, allToolsUsed)
      .catch(err => console.error("[SuperChat→Intelligence] Background save failed:", err.message));

    res.write(`data: ${JSON.stringify({ type: "all_done", sessionId: activeSessionId })}\n\n`);
    res.end();
  } catch (err: any) {
    console.error("[SuperChat] Fatal error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
      res.end();
    }
  }
});

router.patch("/sessions/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const sessionId = parseInt(req.params.id);
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });

    const [updated] = await db.update(superChatSessions)
      .set({ title })
      .where(and(eq(superChatSessions.id, sessionId), eq(superChatSessions.userId, userId)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Session not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/insights", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const query = (req.query.q as string || "").toLowerCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);

    const recentSessions = await db.select()
      .from(superChatSessions)
      .where(eq(superChatSessions.userId, userId))
      .orderBy(desc(superChatSessions.lastMessageAt))
      .limit(limit);

    const insights = [];
    for (const session of recentSessions) {
      const msgs = await db.select()
        .from(superChatMessages)
        .where(eq(superChatMessages.sessionId, session.id))
        .orderBy(asc(superChatMessages.createdAt));

      const ulysseMsgs = msgs.filter(m => m.sender === "ulysse");
      const userMsgs = msgs.filter(m => m.sender === "user");
      const allAiMsgs = msgs.filter(m => m.sender !== "user");

      if (query && !msgs.some(m => m.content.toLowerCase().includes(query))) continue;

      const lastSynthesis = ulysseMsgs.length > 0 ? ulysseMsgs[ulysseMsgs.length - 1].content : null;
      const topics = userMsgs.map(m => m.content.substring(0, 100));
      const participants = [...new Set(allAiMsgs.map(m => m.senderName))];

      insights.push({
        sessionId: session.id,
        title: session.title,
        date: session.lastMessageAt,
        topics,
        participants,
        synthesis: lastSynthesis?.substring(0, 500),
        messageCount: session.messageCount,
      });
    }

    res.json({ insights, total: insights.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sessions/:id/summary", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const sessionId = parseInt(req.params.id);
    const msgs = await db.select()
      .from(superChatMessages)
      .where(eq(superChatMessages.sessionId, sessionId))
      .orderBy(asc(superChatMessages.createdAt));

    if (msgs.length === 0) return res.status(404).json({ error: "Session not found" });

    const userQuestions = msgs.filter(m => m.sender === "user").map(m => m.content);
    const aiResponses = msgs.filter(m => m.sender !== "user");
    const byPersona: Record<string, string[]> = {};
    for (const m of aiResponses) {
      if (!byPersona[m.senderName]) byPersona[m.senderName] = [];
      byPersona[m.senderName].push(m.content.substring(0, 300));
    }

    const ulysseSyntheses = msgs
      .filter(m => m.sender === "ulysse")
      .map(m => m.content);

    res.json({
      sessionId,
      questions: userQuestions,
      participantSummaries: byPersona,
      syntheses: ulysseSyntheses,
      totalMessages: msgs.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/personas", (_req: Request, res: Response) => {
  const personas = Object.entries(AI_PERSONAS).map(([key, p]) => ({
    id: key, name: p.name, emoji: p.emoji, color: p.color
  }));
  res.json(personas);
});

export default router;
