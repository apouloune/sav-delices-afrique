const express  = require("express");
const cron     = require("node-cron");
const fetch    = require("node-fetch");
const cors     = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// CONFIG
const SHOPIFY_STORE       = "f588e3-2.myshopify.com";
const SHOPIFY_TOKEN       = process.env.SHOPIFY_TOKEN || "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";
const STORE_EMAIL         = "lesdelicesdelafrique59@gmail.com";
const STORE_NAME          = "Les Délices de l'Afrique";
const TG_TOKEN            = process.env.TG_TOKEN      || "8620267243:AAEYYR-gvJFXW0L9QW-HMML-7AKkoRAWilo";
const TG_CHAT_ID          = process.env.TG_CHAT_ID    || "5909965082";
const ANTHROPIC_KEY       = process.env.ANTHROPIC_API_KEY;
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const SIGNATURE           = "Daniel, cofondateur de Les Délices de l'Afrique 🌍";

// STATE
let dailySummary     = [];
let cycleRunning     = false;
let lastCycle        = null;
let totalStats       = { total:0, replied:0, urgent:0, partner:0, tg:0 };
let gmailAccessToken = null;
let gmailTokenExpiry = 0;

// GMAIL AUTH
async function getGmailToken() {
  if (gmailAccessToken && Date.now() < gmailTokenExpiry - 60000) return gmailAccessToken;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token"
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Gmail token failed: " + JSON.stringify(d));
  gmailAccessToken = d.access_token;
  gmailTokenExpiry = Date.now() + (d.expires_in * 1000);
  console.log("Gmail token refreshed");
  return gmailAccessToken;
}

async function gmailListEmails(max = 15) {
  const token = await getGmailToken();
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&labelIds=INBOX&q=is:unread`,
    { headers: { Authorization: "Bearer " + token } }
  );
  const d = await r.json();
  return d.messages || [];
}

async function gmailGetEmail(id) {
  const token = await getGmailToken();
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: "Bearer " + token } }
  );
  return await r.json();
}

async function gmailSendEmail(to, subject, body, threadId) {
  const token = await getGmailToken();
  const lines = [`From: ${STORE_NAME} <${STORE_EMAIL}>`, `To: ${to}`, `Subject: ${subject}`, `Content-Type: text/plain; charset=utf-8`, ``, body];
  const encoded = Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await r.json();
}

async function gmailMarkRead(id) {
  const token = await getGmailToken();
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] })
  });
}

function parseEmail(msg) {
  const headers = msg.payload?.headers || [];
  const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
  const from = get("From");
  const emailMatch = from.match(/<(.+)>/) || from.match(/(\S+@\S+)/);
  const fromEmail = emailMatch ? emailMatch[1] : from;
  const fromName  = from.replace(/<.+>/, "").trim().replace(/"/g,"") || fromEmail;
  let body = "";
  const extractBody = part => {
    if (part.mimeType === "text/plain" && part.body?.data) body += Buffer.from(part.body.data, "base64").toString("utf-8");
    if (part.parts) part.parts.forEach(extractBody);
  };
  extractBody(msg.payload);
  if (!body && msg.snippet) body = msg.snippet;
  const hasAttachments = msg.payload?.parts?.some(p => p.filename && p.filename.length > 0) || false;
  return { id: msg.id, threadId: msg.threadId, from: fromEmail, name: fromName, subject: get("Subject"), body: body.slice(0,2000), hasAttachments, snippet: msg.snippet || "" };
}

async function classifyEmail(email) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 20,
      messages: [{ role: "user", content:
        `Classifie cet email pour la boutique "${STORE_NAME}" en UNE catégorie:\nDe: ${email.name} <${email.from}>\nSujet: ${email.subject}\nMessage: ${email.body.slice(0,400)}\n\nCatégories: client_reclamation, client_suivi, client_question, partenariat, partenariat_suite, non_client\n\nRéponds UNIQUEMENT avec le mot de la catégorie.`
      }]
    })
  });
  const d = await r.json();
  const cat = d.content?.[0]?.text?.trim().toLowerCase() || "client_question";
  const valid = ["client_reclamation","client_suivi","client_question","partenariat","partenariat_suite","non_client"];
  return valid.includes(cat) ? cat : "client_question";
}

async function shopifyFetch(endpoint) {
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch(e) { return { error: e.message }; }
}

async function getClientInfo(email) {
  const d = await shopifyFetch(`customers/search.json?query=email:${email}&fields=first_name,last_name`);
  const c = d.customers?.[0];
  return c ? { firstName: c.first_name, lastName: c.last_name } : { firstName: null };
}

async function getClientOrders(email) {
  const d = await shopifyFetch(`orders.json?email=${email}&status=any&limit=3&fields=name,fulfillment_status,financial_status,created_at`);
  return d.orders || [];
}

async function sendTelegram(message) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message })
    });
    return await r.json();
  } catch(e) { return { ok: false, error: e.message }; }
}

async function generateReply(email, category, clientInfo, orders) {
  const fn = clientInfo?.firstName || email.name.split(" ")[0] || "cher(e) client(e)";
  const orderInfo = orders.length > 0 ? "Commandes: " + JSON.stringify(orders.slice(0,2)) : "Aucune commande";

  const prompts = {
    client_suivi: `Tu es Daniel, cofondateur de "${STORE_NAME}".\nClient: ${fn}\nEmail: "${email.body.slice(0,400)}"\n${orderInfo}\nEcris une réponse empathique et chaleureuse avec le statut de la commande si disponible. Commence par "Bonjour ${fn}," et signe "${SIGNATURE}". En français.`,
    client_question: `Tu es Daniel, cofondateur de "${STORE_NAME}", produits africains authentiques de Guinée.\nClient: ${fn}\nQuestion: "${email.body.slice(0,400)}"\nRéponds avec empathie. Commence par "Bonjour ${fn}," et signe "${SIGNATURE}". En français.`,
    client_reclamation: `Tu es Daniel de "${STORE_NAME}".\nClient: ${fn}\nRéclamation: "${email.body.slice(0,300)}"\nDemande les photos du produit défectueux avec beaucoup d'empathie. Commence par "Bonjour ${fn}," et signe "${SIGNATURE}". En français.`,
    partenariat: `Tu es Daniel de "${STORE_NAME}".\nDe: ${email.name}\nMessage: "${email.body.slice(0,400)}"\nRéponds avec enthousiasme. Demande: nature du partenariat, profil/stats. Commence par "Bonjour," et signe "${SIGNATURE}". En français.`,
    partenariat_suite: `Tu es Daniel de "${STORE_NAME}".\nDe: ${email.name}\nMessage: "${email.body.slice(0,400)}"\nRéponds que nos équipes vont étudier la proposition. Signe "${SIGNATURE}".\nRetourne JSON: {"reply":"corps email","partner_name":"${email.name}","partner_proposal":"résumé 2 phrases"}`
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800, messages: [{ role: "user", content: prompts[category] || prompts.client_question }] })
  });
  const d = await r.json();
  return d.content?.[0]?.text || "";
}

async function processEmail(email, logs) {
  logs.push(`[${email.category}] ${email.subject}`);
  if (email.category === "non_client") {
    logs.push("Email interne — résumé uniquement");
    dailySummary.push({ ...email, replied: false });
    await gmailMarkRead(email.id);
    return;
  }
  try {
    const clientInfo = await getClientInfo(email.from);
    const orders = await getClientOrders(email.from);
    if (clientInfo.firstName) logs.push("Client Shopify: " + clientInfo.firstName);

    if (email.category === "client_reclamation" && email.hasAttachments) {
      totalStats.tg++; totalStats.urgent++;
      await sendTelegram(`📸🔴 PHOTOS REÇUES\n${new Date().toLocaleTimeString("fr-FR")}\n👤 ${clientInfo.firstName||email.name}\n📧 ${email.from}\n📋 ${email.subject}\n${orders[0]?"📦 "+orders[0].name:""}\n\n⚠️ ${email.snippet.slice(0,150)}\n\n👉 Va dans Gmail pour voir les photos.\n🤖 ${STORE_NAME}`);
      logs.push("Telegram alerté — Photos !");
      await gmailMarkRead(email.id);
      dailySummary.push({ ...email, replied: false });
      return;
    }

    const replyText = await generateReply(email, email.category, clientInfo, orders);

    if (email.category === "partenariat_suite") {
      let result = { reply: replyText, partner_name: email.name, partner_proposal: email.snippet };
      try { result = JSON.parse(replyText.replace(/```json\n?|\n?```/g,"").trim()); } catch{}
      await gmailSendEmail(email.from, "Re: " + email.subject, result.reply || replyText, email.threadId);
      totalStats.tg++; totalStats.partner++;
      await sendTelegram(`🤝 PARTENARIAT\n${new Date().toLocaleTimeString("fr-FR")}\n👤 ${result.partner_name}\n📧 ${email.from}\n\n💼 ${result.partner_proposal}\n\n✅ Réponse envoyée\n🤖 ${STORE_NAME}`);
      logs.push("Telegram alerté — Partenariat !");
    } else {
      await gmailSendEmail(email.from, "Re: " + email.subject, replyText, email.threadId);
    }

    logs.push("Réponse envoyée à " + email.from);
    totalStats.replied++;
    await gmailMarkRead(email.id);
    dailySummary.push({ ...email, replied: true });
  } catch(e) {
    logs.push("ERREUR: " + e.message);
    console.error(e);
  }
}

async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true; lastCycle = new Date();
  const logs = ["Cycle SAV " + lastCycle.toLocaleTimeString("fr-FR")];
  try {
    const messages = await gmailListEmails(15);
    logs.push(messages.length + " emails non lus");
    if (messages.length === 0) { logs.push("Boite vide — rien a traiter"); cycleRunning = false; console.log(logs.join("\n")); return; }
    const emails = [];
    for (const msg of messages) {
      const full = await gmailGetEmail(msg.id);
      const parsed = parseEmail(full);
      if (parsed.from === STORE_EMAIL) continue;
      parsed.category = await classifyEmail(parsed);
      logs.push("[" + parsed.category + "] " + parsed.subject.slice(0,50));
      emails.push(parsed);
    }
    totalStats.total += emails.length;
    emails.sort((a,b) => ({client_reclamation:1,partenariat_suite:2,partenariat:3,client_suivi:4,client_question:5}[a.category]||6) - ({client_reclamation:1,partenariat_suite:2,partenariat:3,client_suivi:4,client_question:5}[b.category]||6));
    for (const e of emails) { await processEmail(e, logs); await new Promise(r=>setTimeout(r,500)); }
    logs.push("Cycle termine — " + emails.length + " emails traites");
  } catch(e) { logs.push("ERREUR: " + e.message); console.error(e); }
  console.log(logs.join("\n"));
  cycleRunning = false;
}

async function sendDailySummary() {
  const items = dailySummary;
  const date = new Date().toLocaleDateString("fr-FR");
  let msg = `📊 RÉSUMÉ SAV — ${STORE_NAME}\n${date} à 20h\n\n📧 ${items.length} traités\n✅ ${items.filter(e=>e.replied).length} réponses\n🤝 ${items.filter(e=>e.category?.includes("partenariat")).length} partenariats\n📋 ${items.filter(e=>e.category==="non_client").length} internes\n\n🤖 ${STORE_NAME}`;
  await sendTelegram(msg);
  dailySummary = [];
}

cron.schedule("*/5 * * * *", () => runCycle());
cron.schedule("0 20 * * *",  () => sendDailySummary());

app.get("/", (req,res) => res.json({ status:"running", agent:STORE_NAME+" SAV Bot", lastCycle:lastCycle?.toISOString()||"jamais", cycleRunning, stats:totalStats, summaryPending:dailySummary.length }));
app.post("/cycle",         async (req,res) => { if(cycleRunning) return res.json({ok:false,message:"Cycle deja en cours"}); runCycle(); res.json({ok:true,message:"Cycle lance"}); });
app.post("/summary",       async (req,res) => { await sendDailySummary(); res.json({ok:true}); });
app.post("/test-telegram", async (req,res) => { const r = await sendTelegram(`🧪 Test — ${STORE_NAME}\n✅ Gmail API + Shopify + Claude\nSigné: ${SIGNATURE}`); res.json(r); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${STORE_NAME} SAV Bot port ${PORT}`);
  setTimeout(runCycle, 8000);
});
