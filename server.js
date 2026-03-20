const express  = require("express");
const path     = require("path");
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
const SIGNATURE = "Cordialement,\nDaniel\nCo-fondateur des Délices de l'Afrique 🌿";

const POLITIQUE = `
POLITIQUE SAV OFFICIELLE :
- Livraison France, Belgique et Allemagne : 3-5 jours ouvrés, traitement 24-48h
- Livraison GRATUITE à partir de 65€ d'achat
- Retours : 14 jours après réception
- Remboursements : 5-10 jours après réception du retour
- Code promo première commande : CONAKRY10 (10% de réduction)
- Si un client demande un code promo ou une réduction : proposer CONAKRY10

POINT RELAIS :
- Si un client dit qu'il n'a pas pu choisir son point relais : "Pas d'inquiétude, le système choisit automatiquement le point relais le plus proche de chez vous."

RUPTURES DE STOCK :
- Ne JAMAIS dire "je n'ai pas accès aux informations de stock"
- Ne JAMAIS rediriger vers téléphone ou formulaire de contact
- Répondre : le produit sera bientôt disponible, nous faisons le maximum pour l'importer rapidement
- Inviter à s'inscrire à la newsletter pour être alerté dès le retour en stock

LIENS PRODUITS :
- Quand un client demande un produit spécifique, chercher le lien exact sur lesdelicesdelafrique.fr et l'inclure dans la réponse
- Inclure le lien direct cliquable vers le produit ou la catégorie concernée
- Site : https://lesdelicesdelafrique.fr

RÈGLE "JE RESTE À VOTRE DISPOSITION" :
- N'utiliser cette phrase QUE si le problème n'est pas encore résolu
- Si on a donné une solution complète (lien produit, info précise), NE PAS l'utiliser
- Terminer directement par la signature dans ce cas
`;

const STYLE_REDACTION = `
RÈGLES DE RÉDACTION STRICTES :
1. Si la réponse est simple et positive (produit disponible, info claire) : répondre DIRECTEMENT sans phrase d'empathie inutile
2. Si le client a un problème ou une frustration : UNE SEULE phrase d'empathie au début, puis répondre
3. Aller droit au but, réponse claire et concise
4. "Je reste à votre disposition pour résoudre cette situation rapidement." : SEULEMENT si le problème n'est pas résolu. Si on a donné une solution complète, NE PAS l'utiliser.
5. JAMAIS de phrases creuses ou fleuries
6. JAMAIS dire "je n'ai pas accès à cette information" — tu es Daniel, tu as accès à tout
7. JAMAIS rediriger vers un téléphone ou formulaire de contact — tu ES le contact
8. Quand un client demande un produit : inclure le lien direct vers le produit sur lesdelicesdelafrique.fr
9. Signature exacte (respecter les sauts de ligne) :
${SIGNATURE}
`;

let dailySummary     = [];
let cycleRunning     = false;
let lastCycle        = null;
let totalStats       = { total:0, replied:0, urgent:0, partner:0, tg:0 };
let gmailAccessToken = null;
let gmailTokenExpiry = 0;

// ── GMAIL TOKEN ───────────────────────────────────────────────────────────
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
  console.log("✅ Gmail token OK");
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
  const encodeSubject = (str) => {
    if (/[^\x00-\x7F]/.test(str)) return `=?UTF-8?B?${Buffer.from(str,"utf-8").toString("base64")}?=`;
    return str;
  };
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
  const encoded = Buffer.from(lines.join("\r\n")).toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await r.json();
}

function encodeQP(str) {
  let result = "", lineLen = 0;
  const bytes = Buffer.from(str, "utf-8");
  for (const byte of bytes) {
    let encoded;
    if (byte === 0x0D || byte === 0x0A) { result += "\r\n"; lineLen = 0; continue; }
    else if (byte === 0x09 || (byte >= 0x20 && byte <= 0x7E && byte !== 0x3D)) encoded = String.fromCharCode(byte);
    else encoded = "=" + byte.toString(16).toUpperCase().padStart(2,"0");
    if (lineLen + encoded.length > 75) { result += "=\r\n"; lineLen = 0; }
    result += encoded; lineLen += encoded.length;
  }
  return result;
}

async function gmailMarkRead(id) {
  const token = await getGmailToken();
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] })
  });
}

// ── TELEGRAM PHOTO ────────────────────────────────────────────────────────
async function sendTelegramPhoto(photoBuffer, caption) {
  try {
    const { FormData, Blob } = await import("node-fetch");
    const form = new FormData();
    form.append("chat_id", TG_CHAT_ID);
    form.append("caption", caption);
    form.append("photo", new Blob([photoBuffer], { type:"image/jpeg" }), "photo.jpg");
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
      method: "POST", body: form
    });
    return await r.json();
  } catch(e) {
    // Fallback: send as text if photo fails
    return await sendTelegram(caption + "\n\n[Photo non envoyée: " + e.message + "]");
  }
}

// ── PARSE EMAIL ───────────────────────────────────────────────────────────
function parseEmail(msg) {
  const headers = msg.payload?.headers || [];
  const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
  const from = get("From");
  const emailMatch = from.match(/<(.+?)>/) || [null, from.match(/\S+@\S+/)?.[0] || from];
  const fromEmail = emailMatch[1];
  const fromName  = from.replace(/<.+?>/, "").trim().replace(/"/g,"") || fromEmail;
  const subject   = decodeEmailHeader(get("Subject"));

  let body = "";
  const extractBody = (part) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data)
      body += Buffer.from(part.body.data, "base64url").toString("utf-8");
    if (part.parts) part.parts.forEach(extractBody);
  };
  extractBody(msg.payload);
  if (!body && msg.payload?.body?.data)
    body = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
  if (!body) body = msg.snippet || "";

  const attachments = [];
  const extractAttachments = (part) => {
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId)
      attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType });
    if (part.parts) part.parts.forEach(extractAttachments);
  };
  extractAttachments(msg.payload);

  return {
    id: msg.id, threadId: msg.threadId,
    from: fromEmail, name: fromName,
    subject, body: body.slice(0,2000),
    hasAttachments: attachments.length > 0,
    attachments, snippet: msg.snippet || ""
  };
}

function decodeEmailHeader(str) {
  if (!str) return "";
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
    if (encoding.toUpperCase() === "B") return Buffer.from(text,"base64").toString("utf-8");
    return text.replace(/_/g," ").replace(/=([0-9A-F]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  });
}

// ── CLASSIFY ──────────────────────────────────────────────────────────────
async function classifyEmail(email) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01" },
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:20,
      messages:[{ role:"user", content:
        `Classifie cet email pour "${STORE_NAME}":\nDe: ${email.name} <${email.from}>\nSujet: ${email.subject}\nMessage: ${email.body.slice(0,400)}\n\nCatégories: client_reclamation, client_suivi, client_question, partenariat, partenariat_suite, non_client\n\nRéponds UNIQUEMENT avec le mot.`
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
      { headers:{"X-Shopify-Access-Token":SHOPIFY_TOKEN} });
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
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id:TG_CHAT_ID, text:message })
    });
    return await r.json();
  } catch(e) { return { ok:false, error:e.message }; }
}

// ── SUMMARIZE WITH CLAUDE ─────────────────────────────────────────────────
async function summarize(text, maxWords = 20) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01" },
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:60,
      messages:[{ role:"user", content:`Résume en maximum ${maxWords} mots ce texte:\n${text.slice(0,500)}` }]
    })
  });
  const d = await r.json();
  return d.content?.[0]?.text?.trim() || text.slice(0,100);
}

// ── GENERATE REPLY ────────────────────────────────────────────────────────
async function generateReply(email, category, clientInfo, orders) {
  const fn = clientInfo?.firstName || email.name.split(" ")[0] || "cher(e) client(e)";
  const orderInfo = orders.length > 0
    ? orders.map(o => `Commande ${o.name} — statut: ${o.fulfillment_status||"en cours"}, paiement: ${o.financial_status}`).join("\n")
    : "Aucune commande trouvée dans Shopify";

  const systemPrompt = `Tu es Daniel, co-fondateur de "${STORE_NAME}".
${POLITIQUE}
${STYLE_REDACTION}`;

  const userPrompts = {
    client_suivi:
      `Rédige une réponse pour ${fn} qui demande où est sa commande.\n\nEmail reçu:\n${email.body.slice(0,400)}\n\nInfos Shopify:\n${orderInfo}\n\nCommence par "Bonjour ${fn}," avec UNE phrase d'empathie. Donne le statut exact. Termine par "Je reste à votre disposition pour résoudre cette situation rapidement." puis la signature.`,

    client_question:
      `Rédige une réponse pour ${fn} qui pose une question sur nos produits ou notre boutique.\n\nQuestion:\n${email.body.slice(0,400)}\n\nRÈGLES IMPORTANTES :\n- Si le client demande un produit spécifique, inclure le lien direct : https://lesdelicesdelafrique.fr/search?q=NOM_DU_PRODUIT (remplace NOM_DU_PRODUIT par le nom exact du produit)\n- Si la réponse est simple et positive, répondre DIRECTEMENT sans empathie inutile\n- "Je reste à votre disposition" SEULEMENT si le problème n'est pas résolu, pas si on a donné une réponse complète\n- Produits importés de Guinée Conakry, méthodes traditionnelles\n- Livraison France, Belgique et Allemagne\n\nCommence par "Bonjour ${fn}," et termine par la signature.`,

    client_reclamation:
      `Rédige une réponse pour ${fn} qui signale un problème produit.\n\nRéclamation:\n${email.body.slice(0,400)}\n\nCommence par "Bonjour ${fn}," avec UNE phrase d'empathie sincère. Demande des photos du produit. Termine par "Je reste à votre disposition pour résoudre cette situation rapidement." puis la signature.`,

    partenariat:
      `Rédige une réponse professionnelle à cette demande de partenariat.\n\nDe: ${email.name}\nMessage:\n${email.body.slice(0,400)}\n\nSois enthousiaste. Demande la nature du partenariat et les stats si influenceur. Termine par la signature.`,

    partenariat_suite:
      `Le partenaire a répondu avec les détails.\n\nDe: ${email.name}\nMessage:\n${email.body.slice(0,400)}\n\nDis que nos équipes vont étudier la proposition et reviendront prochainement. Termine par la signature.\n\nRetourne UNIQUEMENT ce JSON:\n{"reply":"corps complet","partner_name":"${email.name}","partner_proposal":"résumé en 1-2 phrases"}`
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01" },
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:800,
      system: systemPrompt,
      messages:[{ role:"user", content: userPrompts[category] || userPrompts.client_question }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error("Claude error: " + d.error.message);
  return d.content?.[0]?.text || "";
}

// ── PROCESS EMAIL ─────────────────────────────────────────────────────────
async function processEmail(email, logs) {
  logs.push(`[${email.category}] ${email.subject}`);

  // Remboursement = URGENT — alerte Telegram immédiate
  if (email.category === "retour_remboursement") {
    const clientInfo = await getClientInfo(email.from);
    const fn = clientInfo?.firstName || email.name.split(" ")[0];
    const demandeSummary = await summarize(email.body, 20);
    totalStats.tg++; totalStats.urgent++;
    await sendTelegram(
      `🔴 URGENT — Remboursement / Retour
${new Date().toLocaleTimeString("fr-FR")}

`+
      `👤 ${fn || email.name}
📧 ${email.from}
📋 ${email.subject}

`+
      `💬 Demande : ${demandeSummary}

`+
      `👉 Action requise de ta part.`
    );
    logs.push("📲 Telegram URGENT — Remboursement !");
    dailySummary.push({ ...email, replied:false, demandeSummary, replySummary:"En attente de décision", clientName: fn, isTask: true, taskType:"remboursement" });
    await gmailMarkRead(email.id);
    return;
  }

  if (email.category === "non_client") {
    logs.push("📋 Interne — résumé uniquement");
    const summary = await summarize(email.body, 15);
    dailySummary.push({ ...email, replied:false, demandeSummary: summary, replySummary: null });
    await gmailMarkRead(email.id);
    return;
  }

  try {
    const clientInfo = await getClientInfo(email.from);
    const orders     = await getClientOrders(email.from);
    const fn         = clientInfo?.firstName || email.name.split(" ")[0];
    logs.push(`🛒 Client: ${fn || "inconnu"} — ${orders.length} commande(s)`);

    // Résumé de la demande client
    const demandeSummary = await summarize(email.body, 20);

    // Photos reçues
    if (email.category === "client_reclamation" && email.hasAttachments) {
      totalStats.tg++; totalStats.urgent++;

      // Alerte Telegram avec infos
      const tgMsg =
        `📸🔴 RÉCLAMATION — Photos reçues\n${new Date().toLocaleTimeString("fr-FR")}\n\n`+
        `👤 ${fn || email.name}\n`+
        `📧 ${email.from}\n`+
        `📋 ${email.subject}\n`+
        (orders[0] ? `📦 ${orders[0].name} — ${orders[0].fulfillment_status||"en cours"}\n` : "")+
        `\n💬 Demande : ${demandeSummary}\n\n`+
        `👉 Action requise : va dans Gmail pour voir les photos et décider de la solution.`;

      await sendTelegram(tgMsg);
      logs.push("📲 Telegram alerté — Photos reçues !");
      await gmailMarkRead(email.id);
      dailySummary.push({ ...email, replied:false, demandeSummary, replySummary: "En attente de décision (photos reçues)" });
      return;
    }

    // Génère la réponse
    const replyText = await generateReply(email, email.category, clientInfo, orders);
    const replySummary = await summarize(replyText, 20);

    if (email.category === "partenariat_suite") {
      let result = { reply: replyText, partner_name: email.name, partner_proposal: email.snippet };
      try { result = JSON.parse(replyText.replace(/```json\n?|\n?```/g,"").trim()); } catch{}
      await gmailSendEmail(email.from, "Re: " + email.subject, result.reply || replyText, email.threadId);
      totalStats.tg++; totalStats.partner++;

      await sendTelegram(
        `🤝 PARTENARIAT — Détails reçus\n${new Date().toLocaleTimeString("fr-FR")}\n\n`+
        `👤 ${result.partner_name}\n📧 ${email.from}\n\n`+
        `💬 Proposition : ${result.partner_proposal}\n\n`+
        `✅ Réponse automatique envoyée`
      );
      logs.push("📲 Telegram alerté — Partenariat !");
      dailySummary.push({ ...email, replied:true, demandeSummary, replySummary: result.partner_proposal });
    } else {
      await gmailSendEmail(email.from, "Re: " + email.subject, replyText, email.threadId);
      dailySummary.push({ ...email, replied:true, demandeSummary, replySummary, clientName: fn });
    }

    logs.push(`✅ Réponse envoyée à ${email.from}`);
    totalStats.replied++;
    await gmailMarkRead(email.id);

  } catch(e) {
    logs.push("❌ ERREUR: " + e.message);
    console.error(e);
  }
}


// ── RAPPELS TÂCHES ────────────────────────────────────────────────────────
async function sendTaskReminders() {
  const now = Date.now();
  const pending = tasks.filter(t => !t.done);
  if (pending.length === 0) return;

  for (const task of pending) {
    const ageMs   = now - new Date(task.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Rappel à 3 jours, 5 jours, puis tous les jours
    const shouldRemind =
      (ageDays >= 3 && ageDays < 3.5 && !task.reminded3)  ||
      (ageDays >= 5 && ageDays < 5.5 && !task.reminded5)  ||
      (ageDays >= 7 && task.lastReminder && (now - task.lastReminder) >= 86400000);

    if (!shouldRemind) continue;

    const daysRounded = Math.floor(ageDays);
    let urgencyIcon = "⚠️";
    let urgencyMsg  = "Rappel";
    if (ageDays >= 7)      { urgencyIcon = "🚨"; urgencyMsg = "URGENT — En attente depuis " + daysRounded + " jours !"; }
    else if (ageDays >= 5) { urgencyIcon = "🔔"; urgencyMsg = "2ème rappel — " + daysRounded + " jours sans traitement"; }
    else                   { urgencyIcon = "⚠️";  urgencyMsg = "1er rappel — " + daysRounded + " jours sans traitement"; }

    const msg =
      `${urgencyIcon} TÂCHE NON TRAITÉE — ${urgencyMsg}

`+
      `📋 ${task.title}
`+
      `🏷️ Type : ${task.type}
`+
      (task.clientName ? `👤 Client : ${task.clientName}
` : "")+
      (task.email ? `📧 ${task.email}
` : "")+
      (task.summary ? `
💬 ${task.summary}
` : "")+
      `
📅 Créée le : ${new Date(task.createdAt).toLocaleDateString("fr-FR")}`+
      `
⏰ En attente depuis ${daysRounded} jour(s)

`+
      `👉 Traite cette tâche sur ton dashboard.
🤖 ${STORE_NAME}`;

    await sendTelegram(msg);

    // Mark reminder sent
    if (ageDays >= 3 && !task.reminded3) task.reminded3 = true;
    if (ageDays >= 5 && !task.reminded5) task.reminded5 = true;
    task.lastReminder = now;

    console.log(`📲 Rappel envoyé pour tâche #${task.id} (${daysRounded}j)`);
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
    logs.push(`🏁 Terminé — ${emails.length} emails traités`);
  } catch(e) {
    logs.push("❌ " + e.message); console.error(e);
  }
  console.log(logs.join("\n"));
  cycleRunning = false;
}

// ── DAILY SUMMARY ─────────────────────────────────────────────────────────
async function sendDailySummary() {
  const date  = new Date().toLocaleDateString("fr-FR");
  const items = dailySummary;
  const clients  = items.filter(e => e.category !== "non_client" && e.replied);
  const urgents  = items.filter(e => e.category === "client_reclamation" && !e.replied);
  const partners = items.filter(e => e.category?.includes("partenariat"));
  const internes = items.filter(e => e.category === "non_client");

  let msg = `📊 RÉSUMÉ SAV — ${STORE_NAME}\n${date} à 20h\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📧 ${items.length} email(s) traités\n`;
  msg += `✅ ${clients.length} réponse(s) envoyée(s)\n`;
  if (urgents.length > 0) msg += `🔴 ${urgents.length} réclamation(s) avec photos en attente\n`;
  if (partners.length > 0) msg += `🤝 ${partners.length} partenariat(s)\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Détail par email client traité
  if (clients.length > 0) {
    msg += `✅ RÉPONSES ENVOYÉES :\n`;
    clients.forEach((e, i) => {
      msg += `\n${i+1}. 👤 ${e.clientName || e.name}\n`;
      msg += `   💬 Demande : ${e.demandeSummary || e.snippet.slice(0,60)}\n`;
      msg += `   ✉️ Réponse : ${e.replySummary || "Réponse envoyée"}\n`;
    });
    msg += `\n`;
  }

  // Réclamations en attente
  if (urgents.length > 0) {
    msg += `🔴 RÉCLAMATIONS EN ATTENTE :\n`;
    urgents.forEach((e, i) => {
      msg += `\n${i+1}. 👤 ${e.clientName || e.name}\n`;
      msg += `   💬 ${e.demandeSummary || e.snippet.slice(0,60)}\n`;
      msg += `   👉 Photos à traiter dans Gmail\n`;
    });
    msg += `\n`;
  }

  // Emails internes
  if (internes.length > 0) {
    msg += `📋 EMAILS INTERNES (${internes.length}) :\n`;
    internes.forEach(e => { msg += `• ${e.subject.slice(0,40)} — ${e.demandeSummary||e.snippet.slice(0,40)}\n`; });
  }

  msg += `\n🤖 ${STORE_NAME}`;
  await sendTelegram(msg);
  dailySummary = [];
  console.log("📊 Résumé 20h envoyé");
}

// ── CRON ──────────────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *", () => runCycle());
cron.schedule("0 20 * * *",  () => sendDailySummary());

// Rappels tâches non traitées — tous les jours à 9h
cron.schedule("0 9 * * *", () => sendTaskReminders());


app.get("/dashboard", (req,res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(__dirname + "/dashboard.html");
});

app.get("/", (req,res) => {
  const accept = req.headers.accept || "";
  if (accept.includes("text/html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.sendFile(__dirname + "/dashboard.html");
    return;
  }
  res.json({
    status:"running", agent: STORE_NAME+" SAV Bot",
    lastCycle: lastCycle?.toISOString()||"jamais",
    cycleRunning, stats: totalStats,
    summaryPending: dailySummary.length
  });
});

// Tasks storage (in-memory, reset on restart)
let tasks = [];
let taskIdCounter = 1;

app.get("/tasks", (req,res) => res.json({ tasks }));
app.post("/tasks/add", (req,res) => {
  const { title, type, clientName, email, summary } = req.body;
  const task = { id: taskIdCounter++, title, type, clientName, email, summary, done: false, createdAt: new Date().toISOString() };
  tasks.push(task);
  res.json({ ok:true, task });
});
app.post("/tasks/done/:id", (req,res) => {
  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (task) { task.done = true; task.doneAt = new Date().toISOString(); }
  res.json({ ok:true });
});
app.delete("/tasks/:id", (req,res) => {
  tasks = tasks.filter(t => t.id !== parseInt(req.params.id));
  res.json({ ok:true });
});

app.post("/cycle",         async (req,res) => { if(cycleRunning) return res.json({ok:false,message:"Cycle déjà en cours"}); runCycle(); res.json({ok:true,message:"Cycle lancé"}); });
app.post("/summary",       async (req,res) => { await sendDailySummary(); res.json({ok:true}); });
app.post("/reminders",     async (req,res) => { await sendTaskReminders(); res.json({ok:true, message:"Rappels vérifiés"}); });
app.post("/test-telegram", async (req,res) => { const r = await sendTelegram(`🧪 Test — ${STORE_NAME}\n✅ Tout est opérationnel !\nSigné: ${SIGNATURE}`); res.json(r); });

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌍 ${STORE_NAME} SAV Bot — port ${PORT}`);
  setTimeout(runCycle, 8000);
});
