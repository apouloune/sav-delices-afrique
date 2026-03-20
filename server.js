const express  = require("express");
const cron     = require("node-cron");
const fetch    = require("node-fetch");
const cors     = require("cors");

const app  = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SHOPIFY_STORE  = "f588e3-2.myshopify.com";
const SHOPIFY_TOKEN  = "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";
const GMAIL_MCP      = "https://gmail.mcp.claude.com/mcp";
const STORE_EMAIL    = "lesdelicesdelafrique59@gmail.com";
const STORE_NAME     = "Les Délices de l'Afrique";
const TG_TOKEN       = "8620267243:AAEYYR-gvJFXW0L9QW-HMML-7AKkoRAWilo";
const TG_CHAT_ID     = "5909965082";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SIGNATURE      = "Daniel, cofondateur de Les Délices de l'Afrique 🌍";

// ─── ÉTAT INTERNE ─────────────────────────────────────────────────────────
let dailySummary = [];
let cycleRunning = false;
let lastCycle    = null;
let totalStats   = { total:0, replied:0, urgent:0, partner:0, tg:0 };

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────
const SYSTEM = `Tu es Daniel, cofondateur et agent SAV de "${STORE_NAME}" (lesdelicesdelafrique.fr).
Tu gères la boîte ${STORE_EMAIL} spécialisée dans les produits africains authentiques.

SIGNATURE OBLIGATOIRE : "${SIGNATURE}"

PERSONNALISATION :
- Cherche TOUJOURS le prénom du client sur Shopify avant de rédiger
- Commence par "Bonjour [Prénom],"
- Ton empathique, chaleureux, humain — le client ne doit pas sentir que c'est un bot
- Phrases : "Je comprends tout à fait...", "Je suis sincèrement désolé..."

POLITIQUE SAV :
- Livraison : 3-5 jours ouvrés France, traitement 24-48h
- Retours : 14 jours après réception
- Remboursements : 5-10 jours après retour reçu

CLASSIFICATIONS :
1. client_reclamation : produit défectueux, endommagé, mauvais produit
2. client_suivi : où est ma commande, tracking, livraison
3. client_question : question produit, entreprise, disponibilité
4. partenariat : premier contact collaboration, UGC, influenceur, revendeur
5. partenariat_suite : réponse d'un partenaire qui détaille sa proposition
6. non_client : factures, newsletters, notifications, spam

FLUX PAR TYPE :

[non_client] → Pas de réponse. JSON: {"category":"non_client","replied":false,"summary":"résumé 1 phrase"}

[client_suivi] →
1. Cherche prénom sur Shopify via email
2. Trouve commande et lien tracking
3. Réponds avec empathie + statut exact + lien suivi
4. JSON: {"category":"client_suivi","replied":true,"client_name":"prénom","order_number":"#X","tracking_url":"url"}

[client_question] →
1. Cherche prénom sur Shopify
2. Réponds avec infos entreprise/produits
3. JSON: {"category":"client_question","replied":true,"client_name":"prénom"}

[client_reclamation SANS photos] →
1. Cherche prénom sur Shopify
2. Réponds en demandant les photos avec empathie
3. JSON: {"category":"client_reclamation","replied":true,"awaiting_photos":true,"has_photos":false,"client_name":"prénom"}

[client_reclamation AVEC photos] →
1. Cherche prénom sur Shopify
2. Décris chaque photo précisément
3. NE PAS répondre au client
4. JSON: {"category":"client_reclamation","replied":false,"has_photos":true,"photos_count":N,"photos_description":"description détaillée","problem_summary":"résumé","client_name":"prénom","order_number":"#X"}

[partenariat premier contact] →
1. Réponds en demandant : nature du partenariat, ce qu'ils proposent, profil/stats si influenceur
2. JSON: {"category":"partenariat","replied":true,"awaiting_partner_details":true}

[partenariat_suite avec détails] →
1. Réponds : "Merci pour ces informations. Nos équipes vont étudier votre proposition et reviendront vers vous prochainement."
2. JSON: {"category":"partenariat_suite","replied":true,"partner_name":"nom","partner_proposal":"résumé complet","partner_contact":"email/insta"}

Réponds UNIQUEMENT en JSON valide, aucun texte autour.`;

const SHOPIFY_TOOL = {
  name: "shopify_api",
  description: "Shopify Admin API. Endpoints: customers/search.json?query=email:xxx, orders.json?email=xxx, orders/ID.json",
  input_schema: { type:"object", properties:{ endpoint:{type:"string"} }, required:["endpoint"] }
};

// ─── HELPERS ──────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id:TG_CHAT_ID, text:message })
    });
    return await r.json();
  } catch(e) { return { ok:false, error:e.message }; }
}

async function shopifyFetch(endpoint) {
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`, {
      headers:{ "X-Shopify-Access-Token":SHOPIFY_TOKEN, "Content-Type":"application/json" }
    });
    if (!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  } catch(e) { return { error:"shopify_error", details:e.message }; }
}

async function agentLoop(prompt, logs=[]) {
  const messages = [{ role:"user", content:prompt }];
  let finalText = "";

  for (let i = 0; i < 18; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514", max_tokens:2500,
        system:SYSTEM, messages, tools:[SHOPIFY_TOOL],
        mcp_servers:[{ type:"url", url:GMAIL_MCP, name:"gmail" }]
      })
    });

    const d = await res.json();
    if (d.error) { logs.push("❌ "+d.error.message); break; }

    messages.push({ role:"assistant", content:d.content });

    for (const b of d.content) {
      if (b.type==="text" && b.text?.trim()) {
        finalText = b.text;
        logs.push("🤖 "+(b.text.length>100 ? b.text.slice(0,100)+"…" : b.text));
      }
      if (b.type==="mcp_tool_use")    logs.push("📧 Gmail → "+b.name);
      if (b.type==="mcp_tool_result") logs.push("✉️  Gmail répondu");
      if (b.type==="tool_use")        logs.push("🛒 Shopify → "+b.input?.endpoint);
    }

    if (d.stop_reason==="end_turn") break;

    if (d.stop_reason==="tool_use") {
      const results = [];
      for (const b of d.content.filter(b=>b.type==="tool_use")) {
        const data = b.name==="shopify_api" ? await shopifyFetch(b.input.endpoint) : {error:"unknown"};
        logs.push("✅ Shopify → "+Object.keys(data).slice(0,4).join(", "));
        results.push({ type:"tool_result", tool_use_id:b.id, content:JSON.stringify(data) });
      }
      messages.push({ role:"user", content:results });
    }
  }
  return finalText;
}

// ─── TRAITEMENT EMAIL ─────────────────────────────────────────────────────
async function processEmail(email, logs) {
  logs.push(`━━ [${email.category}] ${email.subject}`);

  if (email.category === "non_client") {
    logs.push("📋 Email interne — résumé uniquement");
    dailySummary.push({...email, replied:false, summary:email.snippet});
    return;
  }

  const prompt =
    `Traite cet email SAV (Gmail ID: ${email.id}) de ${email.name||email.from}.\n`+
    `Catégorie : ${email.category}\n\n`+
    `ÉTAPES :\n`+
    `1. Lis l'email complet via Gmail\n`+
    `2. Cherche le prénom exact sur Shopify via : ${email.from}\n`+
    `3. Applique le flux pour la catégorie '${email.category}'\n`+
    `4. Signe avec : ${SIGNATURE}\n`+
    `5. Envoie la réponse via Gmail si applicable\n`+
    `6. Retourne CE JSON EXACT :\n`+
    `{"replied":false,"category":"${email.category}","client_name":"","order_number":"","order_status":"","tracking_url":"","awaiting_photos":false,"has_photos":false,"photos_count":0,"photos_description":"","problem_summary":"","awaiting_partner_details":false,"partner_name":"","partner_proposal":"","partner_contact":"","summary":""}`;

  const raw = await agentLoop(prompt, logs);
  let result = { replied:false, category:email.category, summary:email.snippet };
  try { result = JSON.parse(raw.replace(/```json\n?|\n?```/g,"").trim()); } catch{}

  dailySummary.push({...email, ...result});

  if (result.replied) {
    logs.push(`✅ Réponse envoyée à ${email.from} (${result.client_name||"client"})`);
    totalStats.replied++;
  }

  // Escalades Telegram
  if (result.has_photos) {
    totalStats.tg++;
    totalStats.urgent++;
    await sendTelegram(
      `📸🔴 PHOTOS REÇUES — Produit défectueux\n${new Date().toLocaleTimeString("fr-FR")}\n\n`+
      `👤 Client : ${result.client_name||email.name||email.from}\n`+
      `📧 ${email.from}\n`+
      `📋 ${email.subject}\n`+
      (result.order_number ? `📦 Commande : ${result.order_number}\n` : "")+
      `\n📷 ${result.photos_count||"?"} photo(s) reçue(s)\n`+
      `🔍 ${result.photos_description||"Voir Gmail"}\n\n`+
      `⚠️ Problème : ${result.problem_summary||email.snippet}\n\n`+
      `👉 Va dans Gmail pour voir les photos et décider.\n🤖 ${STORE_NAME}`
    );
    logs.push("📲 Telegram alerté — Photos reçues !");
  }

  if (result.category==="partenariat_suite") {
    totalStats.tg++;
    totalStats.partner++;
    await sendTelegram(
      `🤝 PARTENARIAT — Détails reçus\n${new Date().toLocaleTimeString("fr-FR")}\n\n`+
      `👤 ${result.partner_name||email.from}\n`+
      `📧 ${result.partner_contact||email.from}\n\n`+
      `💼 Proposition :\n${result.partner_proposal||email.snippet}\n\n`+
      `✅ Réponse auto envoyée\n🤖 ${STORE_NAME}`
    );
    logs.push("📲 Telegram alerté — Partenariat !");
  }

  if (result.awaiting_photos) logs.push("📷 Photos demandées — en attente client");
}

// ─── CYCLE COMPLET ────────────────────────────────────────────────────────
async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  lastCycle    = new Date();
  const logs   = [];

  logs.push(`🚀 Cycle SAV — ${lastCycle.toLocaleTimeString("fr-FR")}`);
  logs.push("📧 Lecture Gmail…");

  try {
    const raw = await agentLoop(
      `Lis les 15 derniers emails dans ${STORE_EMAIL}.\n`+
      `Classifie chacun : client_reclamation, client_suivi, client_question, partenariat, partenariat_suite, non_client\n`+
      `partenariat_suite = réponse détaillée d'un partenaire potentiel\n`+
      `non_client = factures, newsletters, notifications, spam\n\n`+
      `Retourne UNIQUEMENT :\n`+
      `{"emails":[{"id":"gmail_id","from":"email","name":"nom","subject":"sujet","date":"DD/MM","category":"type","snippet":"90 chars","has_attachments":false}]}`,
      logs
    );

    let parsed = { emails:[] };
    try { parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g,"").trim()); } catch{}
    const all = parsed.emails || [];
    totalStats.total += all.length;
    logs.push(`✅ ${all.length} email(s) détecté(s)`);

    // Trier par priorité
    const pri = c => ({client_reclamation:1,partenariat_suite:2,partenariat:3,client_suivi:4,client_question:5}[c]||6);
    const sorted = [...all].sort((a,b)=>pri(a.category)-pri(b.category));

    for (const e of sorted) {
      await processEmail(e, logs);
      await new Promise(r=>setTimeout(r,700));
    }

    logs.push(`🏁 Cycle terminé — ${all.length} emails traités`);
    console.log(logs.join("\n"));

  } catch(e) {
    logs.push("❌ Cycle échoué : "+e.message);
    console.error(e);
  }

  cycleRunning = false;
}

// ─── RÉSUMÉ 20H ───────────────────────────────────────────────────────────
async function sendDailySummary() {
  const items = dailySummary;
  if (items.length === 0) return;
  const date = new Date().toLocaleDateString("fr-FR");
  const replied  = items.filter(e=>e.replied).length;
  const partners = items.filter(e=>e.category?.includes("partenariat"));
  const admins   = items.filter(e=>e.category==="non_client");
  const waiting  = items.filter(e=>e.awaiting_photos||e.awaiting_partner_details);

  let msg = `📊 RÉSUMÉ SAV — ${STORE_NAME}\n${date} à 20h00\n\n`+
    `📧 ${items.length} email(s) traités\n`+
    `✅ ${replied} réponse(s) envoyée(s)\n`+
    `🤝 ${partners.length} partenariat(s)\n`+
    `📋 ${admins.length} email(s) admin/interne\n`+
    `⏳ ${waiting.length} en attente\n`;

  if (admins.length > 0) {
    msg += `\n📋 EMAILS INTERNES :\n`;
    admins.forEach(e=>{ msg += `• ${e.subject} — ${e.summary||e.snippet}\n`; });
  }
  if (partners.length > 0) {
    msg += `\n🤝 PARTENARIATS :\n`;
    partners.forEach(e=>{ msg += `• ${e.partner_name||e.from} : ${e.partner_proposal||e.subject}\n`; });
  }
  msg += `\n🤖 ${STORE_NAME} SAV Bot`;

  const r = await sendTelegram(msg);
  if (r.ok) console.log("✅ Résumé 20h envoyé");
  dailySummary = [];
}

// ─── CRON JOBS ─────────────────────────────────────────────────────────────
// Cycle toutes les 5 minutes
cron.schedule("*/5 * * * *", () => {
  console.log("⏰ Cron — lancement cycle SAV");
  runCycle();
});

// Résumé quotidien à 20h
cron.schedule("0 20 * * *", () => {
  console.log("📊 Cron — résumé quotidien 20h");
  sendDailySummary();
});

// ─── API ROUTES ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "running",
    agent: STORE_NAME+" SAV Bot",
    lastCycle: lastCycle?.toISOString() || "jamais",
    cycleRunning,
    stats: totalStats,
    summaryPending: dailySummary.length
  });
});

app.post("/cycle", async (req, res) => {
  if (cycleRunning) return res.json({ ok:false, message:"Cycle déjà en cours" });
  runCycle();
  res.json({ ok:true, message:"Cycle lancé" });
});

app.post("/summary", async (req, res) => {
  await sendDailySummary();
  res.json({ ok:true, message:"Résumé envoyé" });
});

app.post("/test-telegram", async (req, res) => {
  const r = await sendTelegram(
    `🧪 Test SAV Bot — ${STORE_NAME}\n✅ Serveur Railway opérationnel !\n`+
    `📧 Gmail connecté\n🛒 Shopify connecté\n`+
    `🔄 Cycle auto toutes les 5 min\n📊 Résumé automatique à 20h\n`+
    `Signé : ${SIGNATURE}`
  );
  res.json(r);
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌍 ${STORE_NAME} SAV Bot démarré sur port ${PORT}`);
  console.log("🔄 Cycle toutes les 5 min | 📊 Résumé à 20h");
  // Premier cycle au démarrage
  setTimeout(runCycle, 5000);
});
