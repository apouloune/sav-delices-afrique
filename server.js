const express  = require("express");
const cron     = require("node-cron");
const fetch    = require("node-fetch");
const cors     = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const SHOPIFY_STORE       = "f588e3-2.myshopify.com";
const SHOPIFY_TOKEN       = process.env.SHOPIFY_TOKEN || "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";
const STORE_EMAIL         = "lesdelicesdelafrique59@gmail.com";
const STORE_NAME          = "Les Délices de l'Afrique";
const TG_TOKEN            = process.env.TG_TOKEN   || "8620267243:AAEYYR-gvJFXW0L9QW-HMML-7AKkoRAWilo";
const TG_CHAT_ID          = process.env.TG_CHAT_ID || "5909965082";
const ANTHROPIC_KEY       = process.env.ANTHROPIC_API_KEY;
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const SIGNATURE           = "Daniel, cofondateur de Les Délices de l'Afrique 🌍";

let dailySummary     = [];
let cycleRunning     = false;
let lastCycle        = null;
let totalStats       = { total:0, replied:0, urgent:0, partner:0, tg:0 };
let gmailAccessToken = null;
let gmailTokenExpiry = 0;

// ── GMAIL TOKEN ──────────────────────────────────────────────────────────
async function getGmailToken() {
  if (gmailAccessToken && Date.now() < gmailTokenExpiry - 60000) return gmailAccessToken;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Gmail token failed: " + JSON.stringify(d));
  gmailAccessToken = d.access_token;
  gmailTokenExpiry = Date.now() + (d.expires_in * 1000);
  console.log("✅ Gmail token OK");
  return gmailAccessToken;
}

// ── GMAIL LIST ────────────────────────────────────────────────────────────
async function gmailListEmails(max = 15) {
  const token = await getGmailToken();
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&labelIds=INBOX&q=is:unread`,
    { headers: { Authorization: "Bearer " + token } }
  );
  const d = await r.json();
  return d.messages || [];
}

// ── GMAIL GET ─────────────────────────────────────────────────────────────
async function gmailGetEmail(id) {
  const token = await getGmailToken();
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: "Bearer " + token } }
  );
  return await r.json();
}

// ── GMAIL SEND — encodage corrigé ─────────────────────────────────────────
async function gmailSendEmail(to, subject, body, threadId) {
  const token = await getGmailToken();

  // Encode subject properly for non-ASCII characters
  const encodeSubject = (str) => {
    if (/[^\x00-\x7F]/.test(str)) {
      return `=?UTF-8?B?${Buffer.from(str, "utf-8").toString("base64")}?=`;
    }
    return str;
  };

  const boundary = "boundary_" + Date.now();
  const lines = [
    `From: =?UTF-8?B?${Buffer.from(STORE_NAME,"utf-8").toString("base64")}?= <${STORE_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQP(body)
  ];

  const raw = lines.join("\r\n");
  const encoded = Buffer.from(raw).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await r.json();
  if (result.error) console.error("Gmail send error:", result.error);
  return result;
}

// Quoted-Printable encoder pour UTF-8
function encodeQP(str) {
  let result = "";
  const bytes = Buffer.from(str, "utf-8");
  let lineLen = 0;
  for (const byte of bytes) {
    let encoded;
    if (byte === 0x0D || byte === 0x0A) {
      result += "\r\n"; lineLen = 0; continue;
    } else if (byte === 0x09 || (byte >= 0x20 && byte <= 0x7E && byte !== 0x3D)) {
      encoded = String.fromCharCode(byte);
    } else {
      encoded = "=" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
    if (lineLen + encoded.length > 75) {
      result += "=\r\n"; lineLen = 0;
    }
    result += encoded;
    lineLen += encoded.length;
  }
  return result;
}

// ── GMAIL MARK READ ───────────────────────────────────────────────────────
async function gmailMarkRead(id) {
  const token = await getGmailToken();
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] })
  });
}

// ── PARSE EMAIL ───────────────────────────────────────────────────────────
function parseEmail(msg) {
  const headers = msg.payload?.headers || [];
  const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";

  const from = get("From");
  const emailMatch = from.match(/<(.+?)>/) || [null, from.match(/\S+@\S+/)?.[0] || from];
  const fromEmail = emailMatch[1];
  const fromName  = from.replace(/<.+?>/, "").trim().replace(/"/g, "") || fromEmail;

  // Decode subject if encoded
  const rawSubject = get("Subject");
  const subject = decodeEmailHeader(rawSubject);

  // Extract body recursively
  let body = "";
  const extractBody = (part) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      body += Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) part.parts.forEach(extractBody);
  };
  extractBody(msg.payload);
  if (!body && msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
  }
  if (!body) body = msg.snippet || "";

  const hasAttachments = !!(msg.payload?.parts?.some(p => p.filename && p.filename.length > 0));

  return {
    id: msg.id, threadId: msg.threadId,
    from: fromEmail, name: fromName,
    subject, body: body.slice(0, 2000),
    hasAttachments, snippet: msg.snippet || ""
  };
}

function decodeEmailHeader(str) {
  if (!str) return "";
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
    if (encoding.toUpperCase() === "B") {
      return Buffer.from(text, "base64").toString("utf-8");
    } else {
      return text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }
  });
}

// ── CLASSIFY ──────────────────────────────────────────────────────────────
async function classifyEmail(email) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 20,
      messages: [{ role: "user", content:
        `Classifie cet email pour la boutique "${STORE_NAME}":\nDe: ${email.name} <${email.from}>\nSujet: ${email.subject}\nMessage: ${email.body.slice(0,400)}\n\nCatégories: client_reclamation, client_suivi, client_question, partenariat, partenariat_suite, non_client\n\nRéponds UNIQUEMENT avec le mot de la catégorie.`
      }]
    })
  });
  const d = await r.json();
  const cat = d.content?.[0]?.text?.trim().toLowerCase() || "client_question";
  const valid = ["client_reclamation","client_suivi","client_question","partenariat","partenariat_suite","non_client"];
  return valid.includes(cat) ? cat : "client_question";
}

// ── SHOPIFY ───────────────────────────────────────────────────────────────
async function shopifyFetch(endpoint) {
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`,
      { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    return await r.json();
  } catch(e) { return { error: e.message }; }
}

async function getClientInfo(email) {
  const d = await shopifyFetch(`customers/search.json?query=email:${encodeURIComponent(email)}&fields=first_name,last_name`);
  const c = d.customers?.[0];
  return c ? { firstName: c.first_name, lastName: c.last_name } : { firstName: null };
}

async function getClientOrders(email) {
  const d = await shopifyFetch(`orders.json?email=${encodeURIComponent(email)}&status=any&limit=3&fields=name,fulfillment_status,financial_status,created_at`);
  return d.orders || [];
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message })
    });
    return await r.json();
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── GENERATE REPLY ────────────────────────────────────────────────────────
async function generateReply(email, category, clientInfo, orders) {
  const fn = clientInfo?.firstName || email.name.split(" ")[0] || "cher(e) client(e)";
  const orderInfo = orders.length > 0
    ? orders.map(o => `Commande ${o.name} — statut: ${o.fulfillment_status||"en cours"}, paiement: ${o.financial_status}`).join("\n")
    : "Aucune commande trouvée dans Shopify";

  const systemPrompt = `Tu es Daniel, cofondateur de "${STORE_NAME}" (lesdelicesdelafrique.fr), boutique de produits africains authentiques de Guinée.
Tu réponds aux emails SAV avec un ton très empathique, chaleureux et humain.
Tu signes toujours avec : "${SIGNATURE}"
Tes réponses sont en français, courtes (3-5 paragraphes max), sans HTML.`;

  const userPrompts = {
    client_suivi:
      `Rédige une réponse pour ${fn} qui demande où est sa commande.\n\nEmail reçu:\n${email.body.slice(0,400)}\n\nInfos Shopify:\n${orderInfo}\n\nCommence par "Bonjour ${fn}," et donne le statut exact si disponible, sinon rassure sur le délai (3-5 jours ouvrés France). Signe avec "${SIGNATURE}".`,

    client_question:
      `Rédige une réponse pour ${fn} qui pose une question sur la boutique ou les produits.\n\nQuestion:\n${email.body.slice(0,400)}\n\nCommence par "Bonjour ${fn}," réponds avec enthousiasme et expertise. Signe avec "${SIGNATURE}".`,

    client_reclamation:
      `Rédige une réponse pour ${fn} qui signale un problème avec son produit.\n\nRéclamation:\n${email.body.slice(0,400)}\n\nDemande-lui d'envoyer des photos du produit en réponse à cet email. Sois très empathique et sincèrement désolé. Commence par "Bonjour ${fn},". Signe avec "${SIGNATURE}".`,

    partenariat:
      `Rédige une réponse professionnelle et enthousiaste à cette demande de partenariat.\n\nDe: ${email.name}\nMessage:\n${email.body.slice(0,400)}\n\nDemande : la nature exacte du partenariat, leur profil et statistiques si influenceur/UGC. Commence par "Bonjour," et signe avec "${SIGNATURE}".`,

    partenariat_suite:
      `Le partenaire a répondu avec les détails de sa proposition.\n\nDe: ${email.name}\nMessage:\n${email.body.slice(0,400)}\n\nRédige une réponse professionnelle disant que nos équipes vont étudier la proposition et reviendront prochainement. Signe avec "${SIGNATURE}".\n\nRetourne UNIQUEMENT ce JSON (pas de texte autour):\n{"reply":"corps complet de l'email","partner_name":"${email.name}","partner_proposal":"résumé de la proposition en 2-3 phrases"}`
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompts[category] || userPrompts.client_question }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error("Claude error: " + d.error.message);
  return d.content?.[0]?.text || "";
}

// ── PROCESS EMAIL ─────────────────────────────────────────────────────────
async function processEmail(email, logs) {
  logs.push(`[${email.category}] ${email.subject}`);

  if (email.category === "non_client") {
    logs.push("📋 Interne — résumé uniquement");
    dailySummary.push({ ...email, replied: false, summary: email.snippet });
    await gmailMarkRead(email.id);
    return;
  }

  try {
    const clientInfo = await getClientInfo(email.from);
    const orders     = await getClientOrders(email.from);
    logs.push("🛒 Shopify: " + (clientInfo.firstName || "client inconnu") + " — " + orders.length + " commande(s)");

    // Photos reçues pour réclamation
    if (email.category === "client_reclamation" && email.hasAttachments) {
      totalStats.tg++; totalStats.urgent++;
      await sendTelegram(
        `📸🔴 PHOTOS REÇUES — Produit défectueux\n${new Date().toLocaleTimeString("fr-FR")}\n\n`+
        `👤 ${clientInfo.firstName || email.name}\n📧 ${email.from}\n📋 ${email.subject}\n`+
        (orders[0] ? `📦 ${orders[0].name}\n` : "")+
        `\n⚠️ ${email.snippet.slice(0,200)}\n\n👉 Va dans Gmail voir les photos.\n🤖 ${STORE_NAME}`
      );
      logs.push("📲 Telegram — Photos !");
      await gmailMarkRead(email.id);
      dailySummary.push({ ...email, replied: false });
      return;
    }

    // Génère la réponse
    const replyText = await generateReply(email, email.category, clientInfo, orders);

    if (email.category === "partenariat_suite") {
      let result = { reply: replyText, partner_name: email.name, partner_proposal: email.snippet };
      try { result = JSON.parse(replyText.replace(/```json\n?|\n?```/g,"").trim()); } catch{}
      await gmailSendEmail(email.from, "Re: " + email.subject, result.reply || replyText, email.threadId);
      totalStats.tg++; totalStats.partner++;
      await sendTelegram(
        `🤝 PARTENARIAT — Détails reçus\n${new Date().toLocaleTimeString("fr-FR")}\n\n`+
        `👤 ${result.partner_name}\n📧 ${email.from}\n\n💼 ${result.partner_proposal}\n\n✅ Réponse envoyée\n🤖 ${STORE_NAME}`
      );
      logs.push("📲 Telegram — Partenariat !");
    } else {
      await gmailSendEmail(email.from, "Re: " + email.subject, replyText, email.threadId);
    }

    logs.push(`✅ Réponse envoyée à ${email.from}`);
    totalStats.replied++;
    await gmailMarkRead(email.id);
    dailySummary.push({ ...email, replied: true });

  } catch(e) {
    logs.push("❌ ERREUR: " + e.message);
    console.error(e);
  }
}

// ── RUN CYCLE ─────────────────────────────────────────────────────────────
async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true; lastCycle = new Date();
  const logs = [`🚀 Cycle ${lastCycle.toLocaleTimeString("fr-FR")}`];
  try {
    const messages = await gmailListEmails(15);
    logs.push(`📬 ${messages.length} email(s) non lus`);
    if (messages.length === 0) {
      logs.push("✅ Boîte vide");
      cycleRunning = false; console.log(logs.join("\n")); return;
    }
    const emails = [];
    for (const msg of messages) {
      const full   = await gmailGetEmail(msg.id);
      const parsed = parseEmail(full);
      if (parsed.from === STORE_EMAIL) continue;
      parsed.category = await classifyEmail(parsed);
      logs.push(`📧 [${parsed.category}] ${parsed.subject.slice(0,50)}`);
      emails.push(parsed);
    }
    totalStats.total += emails.length;
    const pri = c => ({client_reclamation:1,partenariat_suite:2,partenariat:3,client_suivi:4,client_question:5}[c]||6);
    emails.sort((a,b) => pri(a.category) - pri(b.category));
    for (const e of emails) { await processEmail(e, logs); await new Promise(r=>setTimeout(r,600)); }
    logs.push(`🏁 Terminé — ${emails.length} traités`);
  } catch(e) {
    logs.push("❌ " + e.message); console.error(e);
  }
  console.log(logs.join("\n"));
  cycleRunning = false;
}

// ── DAILY SUMMARY ─────────────────────────────────────────────────────────
async function sendDailySummary() {
  const date = new Date().toLocaleDateString("fr-FR");
  const items = dailySummary;
  let msg = `📊 RÉSUMÉ SAV — ${STORE_NAME}\n${date} à 20h\n\n`+
    `📧 ${items.length} email(s) traités\n`+
    `✅ ${items.filter(e=>e.replied).length} réponse(s)\n`+
    `🤝 ${items.filter(e=>e.category?.includes("partenariat")).length} partenariat(s)\n`+
    `📋 ${items.filter(e=>e.category==="non_client").length} interne(s)\n\n`+
    `🤖 ${STORE_NAME}`;
  await sendTelegram(msg);
  dailySummary = [];
}

// ── CRON ──────────────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *", () => runCycle());
cron.schedule("0 20 * * *",  () => sendDailySummary());

// ── ROUTES ────────────────────────────────────────────────────────────────
app.get("/", (req,res) => res.json({
  status:"running", agent: STORE_NAME+" SAV Bot",
  lastCycle: lastCycle?.toISOString()||"jamais",
  cycleRunning, stats: totalStats,
  summaryPending: dailySummary.length
}));

app.post("/cycle", async (req,res) => {
  if (cycleRunning) return res.json({ ok:false, message:"Cycle déjà en cours" });
  runCycle();
  res.json({ ok:true, message:"Cycle lancé" });
});

app.post("/summary", async (req,res) => {
  await sendDailySummary();
  res.json({ ok:true });
});

app.post("/test-telegram", async (req,res) => {
  const r = await sendTelegram(`🧪 Test — ${STORE_NAME}\n✅ Gmail API + Shopify + Claude\nSigné: ${SIGNATURE}`);
  res.json(r);
});

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌍 ${STORE_NAME} SAV Bot — port ${PORT}`);
  setTimeout(runCycle, 8000);
});
