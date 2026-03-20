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


// ── DASHBOARD ─────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>SAV — Les Délices de l'Afrique</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=Nunito:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --creme:    #fdf6e8;
  --creme2:   #f7edd4;
  --creme3:   #f0e0bc;
  --terre:    #c8773a;
  --terre2:   #a85e28;
  --ocre:     #e6a830;
  --vert:     #2d7a3a;
  --vert2:    #1f5a29;
  --rouge:    #c4272e;
  --rouge2:   #9a1e24;
  --brun:     #5c3d1e;
  --brun2:    #3d2810;
  --text:     #2d1e0a;
  --muted:    #8a6a42;
  --border:   #e0ccaa;
  --border2:  #cdb68a;
  --shadow:   rgba(92,61,30,.10);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Nunito', sans-serif;
  background: var(--creme);
  color: var(--text);
  min-height: 100vh;
  max-width: 520px;
  margin: 0 auto;
  position: relative;
}

/* ── TEXTURE BACKGROUND ── */
body::before {
  content: '';
  position: fixed; inset: 0;
  background-image:
    radial-gradient(circle at 20% 20%, rgba(230,168,48,.08) 0%, transparent 50%),
    radial-gradient(circle at 80% 80%, rgba(196,39,46,.06) 0%, transparent 50%),
    radial-gradient(circle at 60% 10%, rgba(45,122,58,.05) 0%, transparent 40%);
  pointer-events: none; z-index: 0;
}

.wrap { position: relative; z-index: 1; }

/* ── STRIPE ── */
.stripe {
  height: 4px;
  background: linear-gradient(to right, var(--rouge) 33.3%, var(--ocre) 33.3% 66.6%, var(--vert) 66.6%);
}

/* ── HEADER ── */
.header {
  background: linear-gradient(135deg, var(--brun) 0%, var(--brun2) 100%);
  padding: 18px 20px 16px;
  position: sticky; top: 0; z-index: 20;
  box-shadow: 0 4px 20px rgba(61,40,16,.20);
}

.header-inner { display: flex; align-items: center; gap: 14px; }

.logo-wrap {
  width: 46px; height: 46px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--ocre), var(--terre));
  border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px;
  box-shadow: 0 4px 12px rgba(0,0,0,.25);
  border: 2px solid rgba(255,255,255,.15);
}

.header-text h1 {
  font-family: 'Cormorant Garamond', serif;
  font-size: 18px; font-weight: 700;
  color: var(--creme); letter-spacing: .3px;
}

.header-sub {
  display: flex; align-items: center; gap: 6px;
  margin-top: 3px;
}

.pulse-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #5dffaa;
  box-shadow: 0 0 0 0 rgba(93,255,170,.4);
  animation: ripple 2s infinite;
}
.pulse-dot.offline { background: #ff6b6b; box-shadow: 0 0 0 0 rgba(255,107,107,.4); }

@keyframes ripple {
  0%   { box-shadow: 0 0 0 0 rgba(93,255,170,.4); }
  70%  { box-shadow: 0 0 0 7px rgba(93,255,170,0); }
  100% { box-shadow: 0 0 0 0 rgba(93,255,170,0); }
}

.header-sub span {
  font-size: 12px; color: rgba(253,246,232,.65); font-weight: 500;
}

/* ── MAIN ── */
.main { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

/* ── STATS GRID ── */
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }

.stat-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 8px 10px;
  text-align: center;
  box-shadow: 0 2px 10px var(--shadow);
  transition: transform .2s ease, box-shadow .2s ease;
  cursor: default;
}
.stat-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 24px var(--shadow);
}

.stat-icon { font-size: 20px; margin-bottom: 6px; display: block; }
.stat-val  { font-size: 22px; font-weight: 700; line-height: 1; margin-bottom: 3px; font-family: 'Cormorant Garamond',serif; }
.stat-label{ font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }

/* ── CARD ── */
.card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 2px 16px var(--shadow);
}

.card-header {
  background: linear-gradient(to right, var(--creme2), var(--creme));
  padding: 13px 18px 11px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}

.card-title {
  font-size: 11px; font-weight: 700;
  color: var(--muted); letter-spacing: .9px;
  text-transform: uppercase;
}

.card-action {
  font-size: 12px; color: var(--terre); font-weight: 600;
  cursor: pointer; transition: color .15s;
}
.card-action:hover { color: var(--terre2); }

.card-body { padding: 16px 18px; }

/* ── CONNEXIONS ── */
.conn-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.conn-pill {
  display: flex; align-items: center; gap: 9px;
  background: var(--creme);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  transition: border-color .2s, background .2s;
}
.conn-pill:hover { background: var(--creme2); border-color: var(--border2); }

.conn-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  transition: background .5s, box-shadow .5s;
}
.conn-dot.on  { background: var(--vert);  box-shadow: 0 0 6px rgba(45,122,58,.5); }
.conn-dot.off { background: #ccc; }

.conn-name  { font-size: 13px; font-weight: 600; color: var(--text); }
.conn-val   { font-size: 10px; color: var(--muted); }

/* ── CYCLE PROGRESS ── */
.cycle-rows { display: flex; flex-direction: column; gap: 0; }

.cycle-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.cycle-row:last-of-type { border-bottom: none; padding-bottom: 0; }

.cycle-label { font-size: 13px; color: var(--muted); font-weight: 500; }
.cycle-val   { font-size: 13px; font-weight: 700; color: var(--text); }

.progress-wrap { margin-top: 14px; }
.progress-bar  { height: 5px; background: var(--creme3); border-radius: 10px; overflow: hidden; }
.progress-fill {
  height: 100%; background: linear-gradient(to right, var(--vert2), var(--vert));
  border-radius: 10px; width: 0%;
  transition: width .5s linear;
}
.progress-label {
  font-size: 11px; color: var(--muted);
  margin-top: 6px; text-align: right; font-weight: 600;
}

/* ── BUTTONS ── */
.btn-stack { display: flex; flex-direction: column; gap: 10px; }
.btn-row   { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.btn {
  position: relative; overflow: hidden;
  border: none; border-radius: 12px;
  padding: 14px 18px;
  font-family: 'Nunito', sans-serif;
  font-size: 14px; font-weight: 700;
  cursor: pointer; display: flex;
  align-items: center; justify-content: center; gap: 8px;
  transition: transform .15s ease, box-shadow .15s ease, filter .15s;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

/* Ripple effect */
.btn::after {
  content: '';
  position: absolute;
  width: 0; height: 0;
  background: rgba(255,255,255,.35);
  border-radius: 50%;
  top: 50%; left: 50%;
  transform: translate(-50%,-50%);
  transition: width .5s ease, height .5s ease, opacity .5s ease;
  opacity: 0;
}
.btn:active::after {
  width: 300px; height: 300px; opacity: 0;
  transition: width .4s ease, height .4s ease, opacity .4s ease;
}

.btn:not(:disabled):active {
  transform: scale(.96);
  filter: brightness(.95);
}
.btn:not(:disabled):hover {
  transform: translateY(-2px);
}
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none !important; }

.btn-primary {
  background: linear-gradient(135deg, var(--vert), var(--vert2));
  color: #fff;
  box-shadow: 0 6px 20px rgba(45,122,58,.35);
  font-size: 15px; padding: 16px;
}
.btn-primary:not(:disabled):hover {
  box-shadow: 0 10px 28px rgba(45,122,58,.45);
}

.btn-terre {
  background: linear-gradient(135deg, var(--terre), var(--terre2));
  color: #fff;
  box-shadow: 0 4px 14px rgba(200,119,58,.3);
}

.btn-ocre {
  background: linear-gradient(135deg, var(--ocre), #c8880a);
  color: var(--brun2);
  box-shadow: 0 4px 14px rgba(230,168,48,.3);
}

.btn-rouge {
  background: linear-gradient(135deg, var(--rouge), var(--rouge2));
  color: #fff;
  box-shadow: 0 4px 14px rgba(196,39,46,.25);
}

/* ── SPIN ── */
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin .8s linear infinite; display: inline-block; }

/* ── LOG ── */
.log-wrap {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 240px; overflow-y: auto;
  padding-right: 2px;
}
.log-wrap::-webkit-scrollbar { width: 3px; }
.log-wrap::-webkit-scrollbar-thumb { background: var(--creme3); border-radius: 4px; }

.log-line {
  font-size: 12.5px; padding: 6px 10px;
  border-radius: 8px; line-height: 1.45;
  word-break: break-word;
  animation: slideIn .22s ease;
  font-weight: 500;
}
@keyframes slideIn { from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:translateX(0)} }

.log-error   { background: #fef2f2; color: #b91c1c; border-left: 3px solid #ef4444; }
.log-success { background: #f0fdf4; color: #166534; border-left: 3px solid #22c55e; }
.log-gmail   { background: #eff6ff; color: #1d4ed8; border-left: 3px solid #60a5fa; }
.log-shopify { background: #f0fdf4; color: #166534; border-left: 3px solid #4ade80; }
.log-tg      { background: #eff6ff; color: #1e40af; border-left: 3px solid #3b82f6; }
.log-info    { background: var(--creme2); color: var(--muted); border-left: 3px solid var(--border2); }
.log-ai      { background: #fffbeb; color: #92400e; border-left: 3px solid #f59e0b; }

/* ── ESCALADE ── */
.escalade-list { display: flex; flex-direction: column; gap: 0; }
.escalade-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  transition: background .15s;
}
.escalade-item:last-child { border-bottom: none; padding-bottom: 0; }

.esc-left {}
.esc-level { font-size: 13px; font-weight: 700; margin-bottom: 2px; }
.esc-types { font-size: 11px; color: var(--muted); font-weight: 500; }
.esc-action {
  font-size: 11px; font-weight: 700;
  padding: 4px 10px; border-radius: 20px;
  white-space: nowrap;
}

/* ── TOAST ── */
.toast {
  position: fixed; bottom: 28px; left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: var(--brun);
  color: var(--creme);
  border-radius: 14px;
  padding: 12px 22px;
  font-size: 13px; font-weight: 600;
  box-shadow: 0 8px 32px rgba(61,40,16,.35);
  transition: transform .35s cubic-bezier(.34,1.56,.64,1);
  z-index: 100; white-space: nowrap;
  border: 1px solid rgba(255,255,255,.1);
}
.toast.show { transform: translateX(-50%) translateY(0); }

/* ── FADE IN ── */
@keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
.fade-in { animation: fadeUp .4s ease both; }
.fade-in:nth-child(1){animation-delay:.05s}
.fade-in:nth-child(2){animation-delay:.1s}
.fade-in:nth-child(3){animation-delay:.15s}
.fade-in:nth-child(4){animation-delay:.2s}
.fade-in:nth-child(5){animation-delay:.25s}
.fade-in:nth-child(6){animation-delay:.3s}

/* ── TASKS ── */
.tasks-list { display:flex; flex-direction:column; gap:8px; }
.task-item {
  display:flex; align-items:flex-start; gap:10px;
  padding:12px 14px;
  background:var(--creme);
  border:1px solid var(--border);
  border-radius:12px;
  transition:all .2s;
  animation: slideIn .25s ease;
}
.task-item.done {
  opacity:.5;
  background:#f5f5f0;
  border-color:#ddd;
}
.task-item.done .task-title { text-decoration:line-through; color:var(--muted); }

.task-check {
  width:22px; height:22px; border-radius:6px; flex-shrink:0; margin-top:1px;
  border:2px solid var(--border2); background:#fff; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition:all .18s; font-size:13px;
}
.task-check:hover { border-color:var(--vert); background:rgba(45,122,58,.08); }
.task-check.checked { background:var(--vert); border-color:var(--vert); }

.task-content { flex:1; min-width:0; }
.task-header { display:flex; align-items:center; gap:6px; margin-bottom:3px; flex-wrap:wrap; }
.task-title { font-size:13px; font-weight:600; color:var(--text); }
.task-badge {
  font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;
  white-space:nowrap;
}
.badge-remboursement { background:#fef2f2; color:var(--rouge); }
.badge-retour       { background:#fff7ed; color:var(--terre); }
.badge-partenariat  { background:#f5f3ff; color:#7c3aed; }
.badge-reclamation  { background:#fef2f2; color:var(--rouge); }
.task-summary { font-size:11px; color:var(--muted); line-height:1.5; }
.task-client  { font-size:11px; color:var(--terre); font-weight:600; margin-top:2px; }

.task-delete {
  width:24px; height:24px; border-radius:6px; flex-shrink:0;
  border:none; background:transparent; cursor:pointer; color:var(--muted);
  display:flex; align-items:center; justify-content:center; font-size:14px;
  transition:all .15s;
}
.task-delete:hover { background:#fef2f2; color:var(--rouge); }

.tasks-empty {
  text-align:center; padding:24px 16px;
  color:var(--muted); font-size:13px;
}
.tasks-empty span { font-size:28px; display:block; margin-bottom:8px; }

.tasks-counter {
  display:inline-flex; align-items:center; justify-content:center;
  background:var(--rouge); color:#fff;
  width:18px; height:18px; border-radius:50%; font-size:10px; font-weight:700;
  margin-left:6px;
}
</style>
</head>
<body>
<div class="wrap">

<div class="stripe"></div>

<!-- HEADER -->
<div class="header">
  <div class="header-inner">
    <div class="logo-wrap" style="background:none;border:none;box-shadow:none;width:52px;height:52px;padding:0;border-radius:50%;overflow:hidden;flex-shrink:0"><img src="data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAH0AfQDASIAAhEBAxEB/8QAHQABAAIDAQEBAQAAAAAAAAAAAAYHBAUIAwIBCf/EAFIQAAEDAwMCAwYCBgYGBwcDBQEAAgMEBREGEiEHMRNBUQgUIjJhcUKBFSNSYpGhFiQzcoKxF0OissHRGCU2U5Kz8CY0RGN1g9JUc8KTlKOk4f/EABwBAQACAwEBAQAAAAAAAAAAAAADBAIFBgcBCP/EAEERAAIBAwIDBQcCBAQFAwUAAAABAgMEEQUhEjFBBlFhcYETIpGhscHwMtEHFOHxI0JSYhUkM3KCFiWyNJKiwuL/2gAMAwEAAhEDEQA/AOy0REAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAReVVUU9JTvqKqeKCGMZfJI8Na0epJ4Cq/V/tDdI9NSmml1bTXSsztbS2ljqx7nfsgx5YD9C4IC1UVE/wDSBvd1/wCyXQ/qFdGn5ZayjFHE7/Gd4X6NYe0teObX0n0xp5jvldeLyKjA+ohc138ggL1RUc2H2ranl9Z0noh6NZWuI/iCP5r7Fg9pub+217oSl/8A2LXI/wD3ggLuRUi6ye0/B/Y606e1f/79vmjz/wCFq83H2rqXkDpPXgeQ99aT/uoC8kVFf6Q/aCs3N86H0V3iHzTWe+Rj+Ebtzivw+0hTWof+2XSvqJpxo+eeW1eJA0eZ35GR9gUBeyKAaK60dLdYbGWLW1pknf8ALT1Evu8xPoGS7XH8gVPwQQCDkHsUAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAQkAEk4AVPdQ+vNjs9+OkdE2qs11q0ggW+1ndHCQO8soyGgeeM488KOz9O+pXUCF1x6062j05YPmdp2xTiGPbk/DPUE/F5ZGXD0IQ+NpLLJdrTr70+0/dHWO3VVZqm/chtssNOauUu9C5vwDkjPOR6LR+/e0Jr44t9ts/TGzyA/r60iuuRb2yIx8DD34dgjjlelDq7pp02tRs3T3TtMdowXU7PDY8+r5XZfIfrz91g0nUbWUOq7RcdRRS0NoqZC0QCAxxujPwlwzy7buB7+SidaCeDn7ntRp9GoqcZcW6Tcd0svGW+XwyZ3/AEeNFzf9adRdSak1pNF+tkkvN1e2nZjzEbC0NaPQkhfFHrTphobNNoXRlCwty0y0lKymD/u/bvd9yFI/aNlrGaIp2U5cKeSsY2o29iNri0H6ZA/MBRXpHfenNrsLW3uKCK773eJLUUrpdwz8O0hp2jGPTnKxnUfFwp4KOrazXjf/AMjRqRpLGXKX0Wdvj/eweluvRrUV7X0DaGWkLCGCXfua7PPYdiP5qbKvenNHoOl1BXV+m762oq67dmmMwAa0u3YYwgHj8+FYSkptuO5u9GqV52kXcTU5b5aaae+3LbkUx1zbqyy1zr9Rajq6e21MscEVNBUyMLHeGSTgcYJaT+ajWk6Hqdqe1vuVq1FcHwMlMR8S5PadwAPbP1CnftKf9iqD/wCos/8ALkXt7OH/AGCqP/qEn+5Gq7jmrjJyFewjca/K2c5KLXFtJ8+fwIJDrfqBoa9Ci1F41WzALoKtwdvb+0yQZ/zI9QrztV1hvenI7raHteKiAvh3HGHY+V3oQeD9lXXtL00DtNWyrIb48dZ4bTjna5jif5tasz2cJJX6DqGPJLY7hI2PPkNkZ/zJWcG4zcM7F7SqtxZarPTZ1HODWYt7tev505EHqupXUDTd5mtFzmoa6pp3Bj2yQtcCSARgx7c9wt5Sdbqmnk8G86aLHj5jFMWEf4XD/iq5rLrSVHUyS81xe6jN1M8m0ZJjEmcAf3RhXZdNS6L19Z5dPU16ZBVVm1kXiUzt7XbgeNwAJ4xwVFCUnnEjSaXe3ld1VSvOFxbUIyw3LnhZk/JZMKLR/Szq1ZX3e6aDt82+V0TpZ6VkVQSAMkSRndjn9r1WgPQKXTbfG6XdRtU6Slj5jo5an36gOOwMMnl5ZyePJWloTTzNL6YprK2oFSYS8um2bN5c4nOMnHBA7+S2d1jq5bZVRUErIat8TmwyPGWseRwTj0Ktxzjfmei2kq6toSrr38bpd+N13FLHXnWnQh2a96exartked130q8ulDR+J9M/4s474wOFNunPV/p9r6T3XT+oIf0i3PiW6qaYKphHceG/BOPPbkKs7B1W1PYaySguMsF9p4JHRlznEPcGnGWyYyQcZy4FTS8aF6d9atOwXu7ackpasuIguEWIKyJzSPibKz5gCON2RweFjCrGfI1+l6/aak3Ck2prmmt/2+ZaiLn827rx0nw60Vjeqml4sf1Ssd4V1gYMcNk58XHPfcT6BT3pN1i0d1G30dtqJrdfIARVWa4s8GrhIHxfCfmA9W5+uFIbssNERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREARFVXWTrBBo+6U+kNLWibVWuK5uaW00xyIQRxJO78DPPHBI54HKAlvUvX2lenWnX3zVd0joqflsUfzS1D8Z2Rs7ud/IdyQFTIpur3XWPxLjLU9NOn8oDhBGf+tLhGRnLnf6thBHHA+jxypD016L1s+omdQOr1zZqnVzgHU9M4ZobWM5DIWdiR+1jHGRk/Ed17RGo6m2WSlstHI6N9wLjO5pwfCbj4f8RP8AR5rGclGOWUdSv4afazuJ7qPzfJL4kcsuoemvSa3HT3T3TsU+0gVFSx+PGcONzpSC6Q/wCz6Ke6n01aOplmtFyjuM8FO1rpGOiAJcHDBaQeAQR+XIUa6YdM7HW6IFdeITPV3OEuY/P/ALuwn4Sz97scn7euZ3090rHpCxfoyOvnrN0hke6QANDiADtb5Dj1Kiipz/VyZobGnqOoL/3CMXRqRzhbcO+V4vPm/Tkc+6JqmaP6kwsvMMRZTVDqapMjA4R87d4z2wcHI8vurN1P1d04K+nitlodeZYpRsnkjDQzPBMeRuLsfQKN+0bp/wBzvtNqCBmIq5vhzEDtK0cH824/8JUp6OVOjaDQ0N7lit9vq4nOhqqiZw3l454LueWkHA9eyihxRk4J4Oe02F5Z3VbS6dSMIp8XFJZeNuWduWHvy3LGudDb75aJKOvp21FHUxjcx4I4PIPqCO/qCqrm6Nacr55v0PqSZojdh7Pgm8MnyOCMfmsS09RZanq94IustbYKt/usLHM2MbuAwduB+PjJ5wStLRab6l6XvNyptM0lXFTTzFokYI3NkY1x2Oy7OOD9Dys5zjPfGTZahqNjqDjN2zqxjKUW4/qWOTWHun03NJ1F0ZV6DuVC6O6CpE+6SCaNpjexzCPLJx3GDldF6Nr5rrpO1XGox41RSRySEebi0ZP8VU9p6Xaq1Fdo7lri5OawfNH4wkmI/ZBGWsH2J+yuqmgipqaKmgjbHFEwMjYOzWgYAH5L7Rg028YRZ7M6dVt7itXVN06UscMXz83/AF7yovaOvdrms9PYY6oOuUFYyaSDY74WGN/OcY/EPPzWm6Q9QrBpTS01uubax07qt8zRDEHDaWsA5JHOWlWzetFaXvNxfcLnaIqmqeAHSOe8EgDA7HHZYY6baHBz/R+n/wDG/wD/ACR058fEsC40fVXqUr6jOCfJZzy8duZTPUPVtf1FvdFbbPb6gU8biKeDvJI893OxwMAeuAM88q1aI23pv07jttbcIIq80s0zAXYM023JDfXBLWj8lLbLYrNZWObabZS0e7hxijAc77nufzWu1joyxar8F13gmfJA0tifHM5paD347eQ7hfVTksy5smt9FvLb2t25qdxNYy9opbcvTl/cofolZ7detaGC6wwzU0dM95jlPD3ZDQPv8WfyVq3TT3TfRN5t16qmutk3iu8DD5JGOcG85b8WAM/QdlqLl0NtUmTbr5WU/oJ42yj+W1ad3R3UrLjQia70ldQQzt3NdI8OazcN2GkEdh6+SjjCUFjhNHZ6ffabb+ydnGc08qeU8brpz28y82kOaHDsRkKJ9W9Qf0e0RWVEb9tVUD3anweQ9wOSPs3cfyCkV5r4LVaau5VJIhpYXSvx3IaM4H1XOHVvXEWsqyh9yhngo6aInw5cZMjj8R4JBGAAPzUtaoox8Tpe0usU7C0nBS/xJLZee2fQ3vs56f8Afb9U36ePMNCzw4cjgyvHJ/Juf/EFfUMUUEYihjZFGM4axoAHn2CivTO30OnOnlH/AFiAsEJqqqdjw5u4jc45HBAHGfRq2uldS2fU9C6ss9SZo2O2yBzC1zHehBX2lFQil1Muz1rS0+zpUJNcclxY6vPP4bL0NF1Y1dbLBp2son1rmXOrp3x08cJzI0uBAef2QPX+CpfSvQ+n1/aJLrfZK+zzRgOtFxpH+HVRSf8AeNPcs+nn3GMAroO7aV07dbnBc7haKWoq4Tlsjm8nHbcOzgPrlboAAYAwE4G58TJHpdavqSvK8lww2glnrzcv2RzrT9Q+pXRiphtvV+kOpdKF4ig1bboiZIs/KKmIc/n39C8q/bFdrZfbRTXezV1PX0FVGJIKiB4ex7T5ghaLXOr9J2VgtWoJYqgVQ8OWl8ITDw3dzI3ttx5Hv5AqnK3QGqullZJrboTOL1pyrcZq/SUkxfFI08l9K7na793v5fFw1SKSbwbandUalSVKE05R5rO68zo1FCukfUvTXUuwOuNjmkhqqd3h19uqBsqaKXsWSN+4OD2OPUECar6ThERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREARFTfXfqPfKa70nS/pnFHW68vDMulJzFZ6Y/NUynBwcHLQR6HB+FrwMbrH1ZvJ1KOl/SSkjvOuKhp96qDh1NZouA6WZ3I3DIw08AkZBJax3lpewac6D6dnrKyol1Fre9Zlr7lUEmarkzk5cclkQPl3J5OT2m/Rfpxp7pnpt1ltcvvt0n21F2uM2DU10xz+sk5JDc7trcnAzySXOMuulptl0fTPuNDT1TqaTxIfFYHbHYxkf+vIegWMstbFW8jXqUJRtpKM3yb3x3/neUj0m1XV3nqc6uvt7mimqYXRQwAYhkPlHz8oHceZPnk87n2l7TNLRWu9RNLo4HPgmI/DuwWn7ZBH5hRnrLoN+m7h+nbPG5tsmkyWs/8AhZCe30aT2Pl29Mznplqyh15pyfTOoQyWuEOyUO494j/bH7w4z9cEfSrHLTpy5nAWqnUp1tFvXipJ5jJt+8+a+OPr15ugurqS4aei07VTNjr6IFsTXHHixZyMepHYj0wfVWDe7tbrLb5K+6VcdNTxjJc89/oB3J+gVB6o6SantNwdLZGG5UoduikjeGSs9Mgkcj1H8l6WTpZrO/Vcb7/NJRU7eDJUzeLJt9GtBP8AMhZRqVIrh4dy5Y6tq9rRVnK1cpx2T6Y6ZeMbd+dzfaz1NW9QNDtprFYH1TpLgYpRy6SDb8UbwBwNzcgknA5HmCsLSnROvqNk+o69tHH3NPTkPk+xd8o/LcrLfPo7pho7xbjcqOzWmnyX1FXKGmR5Ge/d7zjhoGTjAHkue+o/tVVtwMtv6V2PMJy39OXeMsj8xuhg+Z3GCHPxzwWL7KEV71Rm+s+x1TVq8Kl0nVq4Swto7eW/m3t6HRVm03pLRtBJVwU1HQRwsLpq2peNzWjuXSO7D+AUKvXtBdPKe5m16fmuesa9o+OHTtIatrMnAzLkRgHnndgYJOOM8Zaorb9q6r981nqO6agm3Oc2OpmIp4y45Phwtwxg7cAeQ9AuwrNbrfa7fHSWyhpaKna0Yip4mxsHAHZoA7AD8lyvaTtStIhBUqfE5Zx0Sxj9z0aXY2pplKmqmIp52j0xju26+Jq5Op/WG+7TYOn1i0zAT/b6guLqiRzctyRDAAWnl+AX84BOOx11XR9ZLtGRcurot7JGkPgtFihi25z8sry5/HHIwf8ANTFF5zdduNXrv3ZqK8EvvkkhpdvHmskGd0/r6h/iXHqh1IrHEYe39Pvhjdxj5Ig0Afz9SV+N6YWk5941HrSq9PG1HVHb9sPCnQIPY5Raip2g1Of6q8vjj6FhWlBcoogsnTK3jHuuq9c0WB8PgakqhtPqMuPK+4dD6goQH2jq11Cp5RnmqugrGHI82SsI/wAvNTdFlT7RapT/AE15fHP1Pjs6D5xREYJuu1qc6Sk6kWK/ABu2K72FsIJzzl1O5p7fT6fVbKk6x9QLKwDWPSuorImgeJV6brG1QPyZIgftk7l3GSePPut4i3Nr281ai/fkprxWPpj6MrVNKt5clg2Ok+t3TTUdQ2gGoYrPcy1pdbr1G6hqAXdmhsuA8/3C5bLVPTLSl/DphR+4VLufHpMMyfUt+U/wz9VUvWmx2a76Fr3XO10lW+NjWxySxBz4wZG52u7t/IhU1o3UWu9BTCTRWqqllIMZtNzc6qo3AfhAcd0fYctOeF6n2c1ta3aOtKHC08Y59E8/M4LtHU0+0uFZ3keJSWU2tt215p7c/mXjqDplrXT9LVR2StluNunaRNHTPLHPb+9Hn4vyyra6V6f/AKOaKoqKSPZVSjx6kEYPiO5wfsMN/JVV099prT9dLDbeoVrl0dcJHbGVT3+Nb5TwB+uH9mTycPAAA+ZX3TzRVEEc8ErJYpGhzHscHNc08ggjuFvYUoxeUUdK0WxtazubaTaawlnKW++P7iomhp4Hz1ErIoo2lz3vcGtaB3JJ7BU11E6vFzn2vSOXOJ2Ori3kn0jaf94/kOxWj6yWLWVtqqyqrLlV3Cy1c/i7mOIjjd2a17M4bgYAPY4HnwsyydLIrroehvtgvFR+lnDxmGRpiYSD8rfNpBBw7JB+3IinOcm4xWDS6nq2qXlWdnaU3BxWXuuJrOPd/p8e+MXfRlxtulJ9UanmlhqamRrKWmeczSvdyXSE9sNDjjv64U/9mimr/wBG3SskqJvcTI2KGEu+DeBl7gPI4LRx/wAFW+vtSaluopLLqRhZU2svY4Fu173HHLscE4AwR3Bz5rojp1Zf6P6MtttczbM2IPn9fEd8Tv4E4/JY0Ypzyuhr+zdpQrar7S3TUKcd883J88/PblsVl1l6Q3aXUo6ndJ62Oya5pm5ngJDaa7sHeOUdtxAxuPB4yRgObJOh3Vm19SLfU0VRSyWXVdrPh3ey1ILZqd4OC5oOC5meM9weDjjO26t6puek7HTV9tpaabfUtjkdM/5R3wG9znBGfL/KvOoGk2dRKSg6qdL6mK1dQLOMxk4aKsAfFSVHYEEcNceMHBwDltrjXFw9Tv46hQldStM++knjvT7u/wAS9kUA6I9T7Z1L05LUMp5LZfbdJ7tebTPkTUU4yCCDyWkg4P0IOCCBP1kXQiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiKI9W9S1Gl9Hy1tGwmqnkFPC/GRG5wJ3H7AHH1wvkmorLK91cwtaMq1TlFZZH/aC6lT6GsNLatOQNuOtL9L7pY6ADc50h4Mrm/sMznngnHlkiO6Uslq6HaNqLjdKr9Oa7vx8e5V0zt0lVOeSM9xCwngef0zxidMLPPTV9868dRqmGpvFW2SC008WDHQ0TXFsccf78nmfrz3crGsV40Z1FgpppKeCero3iUU1SB4sTvt+Jvb1B4zysZSzsnuUbu9jVh7C2qxjVmsxz3Pr8ORVvSHVNJ/pCqbrqa41DauuZsjmc/bFuJ7PHkMABvkP4EdDqkurnS7w/Gv2mKfLOX1NEwfL6ujHp6t/h6LD6R9T323wbFqOZz6LhlPVOOTB6Nd6t+vl9u0FObpvhmcxpGo1NFrPT9QWE22p9Hnvf36dSxLzrbS82qKjRV2adssfhSyTNxE57v8AVkntwRg9s+aoy8WepsvUWW1aTrJqypgqNtM+nz4jHebSe2W8gntwc+YEg6oXOHX2uKW16ZoGVEsWYRVNGDPzySe2xvPJ+p7K4dH6Yt2lbYKqqlimuDacCsuEuAS1oz8x7NA9fIDPZGnVeO7qR1aFXtBdSpprhpy2qJYeP9K72n15deqz+dM7Fd7BpwUt6ucldVSSGVzXO3CEu5LQ48u5ySfUnHqa164+0PZNFVU+nNKU8OpdUxlzJYGy7aehOCMzPHcg4/VtO7gglvGa09oD2gbhqapqNJ9MLo+itUTjHXX+H56g+cdMfJo85Byfw8cuoygoqahh8OmiDc8vd+J59XHuT9Ssa1zGkuGPM9v7K9iZ3FGDqZjSXLO7fln6vbuzyWdqe7ak1leBedb32ovlY3PgxSANpqbt/ZRD4WngZOMnueV4oi1k5ym8yZ7FZWFvY0/ZW8eFfnN9Q4gAknAHmr21l150XYaCtFonOoKyigD3spHfqWkuaxoMvbkuHy7uxXN+sYKqptIgpvFDXyATGJpc4MwfIckZ25xzjKi+nLHqSK5XTTUmlrvUVVRRu8WkbQymeMgb4n7AMgbtnJGMFa6+0Ky1NwqXctoZeM4znGcvn06Y8zgO2+pVadenQhHGE9+9vHLy7/PuLPk629RtYGV8V1g07QyVMNDDHQU4Mj5pXENHiP3OAa0OcS3HYDjdkbS469us2sGaUjlZUVAmbGKyqqnyMEYbuLTk5MuMjGe/P0VXUVquun5rBS6kZRWFlvubq2QVtRif4vB4dTsDpmjEQwSzB3KW1vVTRcUMgpNPVNVI2p94a10MUUb5M58XdlxDvPO3K3+mWmnWkM2sIrxis/Pr477dTmNMvY0oSlVq8Msrnltrqkunmu41PUjqBcKXWNZTWutradtFH7vE+mqnwlkm4OkdlhBzloZ37A+q/bX1p6n6csVua3UtTVGpbJKwV0Mc+Yg7Y1we4F5O9koIJ8hjuobUWCtvNPPqOkAioZ6uVrpaypjY1rxtcQXuLdziH5ADQTh2BwcfdrkjqKRlkbdI/EqnCmMscUs0ngh29sMbAwfNISe/xHaPhAJdld2dpeb1qUZd+Umaevd1q1eVVtri5fYsvTvtD9QairZHV3endO94bFCLM2WN5J4BLHteM/uglWhob2lLJV1clr1hbpbZWQlzX1VFHJPTu29zsx4jPth3buFztHp20UDmmm1U+grZWmKKSpZB4RLgWua50U0jozgkEkfDnktyvqv01qC12SGz0TaJldVNL66np6+F9TUNJzGwNDtzmFuHBjA4HhxLjgM0V52U0i7XD7NR7nHEcfLf1yZ0rq6p75z8zs229Wum1w2e76ztDd5w3x5vByfT48KaQyxzRMlhkZJG8BzXsOQ4eoI7r+b7aV1ko5mXSrraapnaW/o6B+x/HAM2fkGeQ0guOOzQWuMy6M9VtQ6FqWU1BNNU2kMdJWUVRumYQDuc6FrQDE7bnknae7vLHKaj/DrhpudlUba6Sxv6rH0x4ot0dWfElVWPI7K6pf8AYS5f3Wf+Y1UErJh6lad6j9LLvW2V8sNRTiNtVRzgCWEmQYPHBacHBH8jwq2W97BW1W1sqtGtFxkpvKf/AGxPLv4izjPUaUovK4F/8pHnUQw1EL4KiKOaJ4w5j2hzXD6g91ndPtWa36Xz50VXMrLM526exXGRzoD6mF/eJx/hnvnGFiou5ONstQuLKfFRljw6M636RdV9I9U7VNBQu92usDNtystYB48Hk7I7SR88PHByM4Jwtz1CGpaDTEQ0XTwNlpnNLomsBd4TR8rG4wew4747criGroZTcKW72uvqbReaN++luFI7bLGfQn8TT2LTwRkLpHoF14j1JXQaJ134Nv1aGkU9Q1uymujR2cz9mTHdnqCW99o+NZR31jqtHVqUqXE4VGunPzTItoeGTVPVSlku72NknrHVNQ1/wgubl2wA+pAbj0XQus9UWvStpdX3KXk5EMLT8czvQD/M9gox1T0IbrGb9p1jaW/U53h8fwunx9fJ/o78vTFNU8OpeoWsI6OsqjLXkbHunwxsLG/N8PGMegGcqtl0sxxuznY1rns8p2sYcdWrLMZdHnv8U+njzxz9bjXam6m6sZFHGZHnPgwNJEVNHnkk+Q7Zd3P8ApBV2zUPSG/0tzp5vf7ZUNaycgFrJDj4mOHO09y0/wD/AELI1Xo679Na2j1NpqrmqaeINZUl45a7gEOA7xu/kfPsVO9X6cruoumLLM6eosvxCaopJm54PBOB+Ifhzjg8gFYxg98/qK1tpVeXtnUUv5yLUk87NeD5Nc8+WF1RXnVHT9TJNB176QuH9IaOLN2tzRhl2pm43xSNH+taBwe5AGOQ1W/0y1pZuoGirfqqxTB9LWR5dGXAvgkHD4347OaeP4HsQtLeL1YeltBarTT2uo91qZMPnbjAxgPe493PwQcenpjCrLUkbuhHUh2vbOxsnTbVU7G3ynh+S21Lz8FWwDjY7POPUj9kC3GWdnzPQrO69pmjUkvaxS4kuja8eh0Wi+IJYp4WTwSMlikaHsexwLXNIyCCO4K+1kXgiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiALnzVs1y6ydbJ9JWS4PpdK6Mje+5VTMllTcpI3MZF6ERguJ+u76Kde0dr2o0F03nqLS3xtRXWZltssAwXSVMvDSBnnaMu+4A81iaI6c3PQXRBuldNyxSX+aMzXCskeQ6oqZOZn7jn4vwtJPYDlfJcmVrxRdvNSjxLD2XN7cvUh+qXt1PqS1dO9MPDLTb3eEH5yHvGTJKfXHxY9STjuFObpadH9LKZ+pKakllrHRtpoIXzZL3fiIyDtJAyT28gBnBrDUnTbVWmqCnu7WGZrWNkldSuO+md35xzx+0OOPJa0ahl1Nf7Q3WV0nfb6YiOSRrMuDM5JIHcngF3fHrhUuPhbytzy+OoSs6lT+ZocNeTXA5Y4YrksZ5KK8/HkdExazsw0fT6prHTUVDPtDRNGd+ScYAGc+Z48hlVB1isVrrr9aqvSdJJUSXjJLqYAwSvz+Ejs/uXDy7nzUz6zXzTcXTuGlhjo64VjQ23NjILYw0Y8RpHbaOPucdsr26DaXqbNpt1yrnStmuBEscDnHbGzHDtvbc4Hv6YHqpp+++A6TUVPVbhabLElwxk5pbxfXw95cku/PI2/TDRFHo60mSYxy3OZuaqo8mjvsafJo/mefQDlX2justX1Lus+k9J101NoukeY62qiJY+6yA4LQe/gj/a788YlPtbdXKi73eq6V6Vq3xUUI26ir4HcuJA/qjHA8f8AzPP8P7QND08MVPAyGGNscbBhrWjgBQXFdUlwQPauxHY2jKlGpUjilHku9+Ph39727xTwxU8DIYY2xxsGGtaOAF9oi1p7LGKikktgsO43S325ua2rjhJ7NJy4/kOVGNUaiqnuqae2SeDBTnbNU+bn/sN/nz9D5Baa00IuNkkqHxMhLZZBVXOseREwO8IsDe5e8bZfhaC7D8+XFuna5WZvBwus9tYWs3RtIcUu9/p2226vz2XiSGs11bY2kU1PUTuB4yAxp/Pk/wAlMtW9Yup+sLbK6kqKbSFjaze6aKR0cjoy8NDt/MrxuIbmJoHOCq5o6CmpqNtbbYGRU24tN4uzQ1hI7iGH4tx+we7sfhXxdNVwgzCihNbPNHHHLVV0Ydu2fiEZJBJcS4l5fyRgNwMKul2lecZzpqTjyzvjOOnLp5nBalr97qOP5meEuSSxz+b+OPE/Kt0UdgpPd56lxfK0Nn9xbDFPOx0pDzM95Ly3xnAna3gMzjAX3pqXTtv1DR0ZhpK8iTEtbVt3wOfggNYx2G+EXEBzn5JbyNh4X3SUj7nBG69+/TXStY6OnGDNUSguj8MRxZGG7RIMnAw7jOMLNntsunaeKuMtttdIHuY99LVR1VeZG94g4cMfyMlga1oPOTgG82sYNOk8qWNka2/U+qdTz++upqw2mDLKKWoYympoYs/CAcMiaSAM4xkrL0JocXe7tZPcbXMIWOkkpmTSPBcGnY18kbS1rC7aCdw4Jwc4WVdrrV3C1UF9vFsmgt8LnNoo2vfMak8h5eZdzeT3kIJJGACB8Oitlyqb1f4YHUDHUn618dso6YmJzix2Ghgycu4b4hy5vBz8IT3nFpbB8Cmm98mXruxahtGr6Wg1G1twqpGs8GClcQwsJIbHGA0Brc8BrRgdhhbC/wBLSXTSL4C60wXays8SKkop5Z3mnLv1jHOduadhdvAa8gAyZA5I/dT1NbaNNV2l70IrtTQTltpm8RrpqLDhy4tJLGvZnEbvNp4GOdbZNMXumdRupZGtut1jkp6ShEZe98ckZa8vPysHhv3cncAQSACCvieUm3yPrWJNJc/ivzp3nvK20aotzauouFbNeqSlD61zaZofPG3G54Bf+tfG3uSWl7Rk4LCXeFfHBDo6oZQ1Ec9DujDZqcOaZJN2cVDO7XgZ25cWDBDASXOGbpq71dnloq66WewVdNStY8Bk1NT1Xh7eQQxwc8lpIIe1xOT58rHtr4NL6wvFqkr6OOlbM6nd71Q+PHUQhx4LgC9gLcHLRn+AX3dbIbNZfXY2fSK1miuNJd62/wAdrhuLX0tPC2Q76pxcA1j2gEGMvAyfwloJ2naVZNouNPdKFtVT7wCS17HjD43g4c1w8iCqS1TSUdNfn2K2whjYJyIq2qqsukjPLHZ4Y1haQ4cZ57+Sl7q+40mo2agtLhXU90pI6qsjijeIpZwXRzYJA2vL43ubkDOcDyC+x2lnvOY7R6LG+oe0p7Th811Xhh9fHfvLKRY1rrqa52+GupH74Jm7mnz+x+o7LJUp5ZKLhJxksNBYN6tVHdqQU9W13wuD45GO2vieOzmu8iFnIh9p1JU5KcHhovL2autNXcLlF0419VB18jj/AOqrpJ8LbpGPwu/+e0d/2sE9+XXDVaFsc+tKfVQZLFWRfE5kTtrJH+T3Y5zjOfXz888O3u1wXSnYyRz4Z4XiWmqIziSCQHLXtPkQcLqb2ZerE2vLTV6d1IY4tW2QNbV4w0V0J4ZUsb9cfEBw0kdtwANJ8z0XSNRoatTjTuIpzhh7965Nfn1Lhe+EyeA9zC9zS7wyRktGATj05H8VA+oHVCzab8Sjoi25XMcGJjv1cR/fcPP90c+uFEOvdiuVruzdXWurqo46lnu1UY5XAxkjA58muHGO2fuo/o3plJddNzajvNzjt9uFO+WEsw9x2g/E7yDQR27nBHChnUnnhiilqet6k7idja0cTW/E3tw9HvhL15cuZqJHay6k3pzg2auezJDW/BBAPQZ4b/mfqp10muFHqjTF16Z6rp/GidTyQiKUcuiPwvj57OaTkeY/wrV9IepVBpq0S2a9Qy+7teZIJYIwTz3a4cZ57H8vRaezXp1562Ud4tVM+nbVXFhEecHYcNeTjzLdxP3KhhJRaknlvmc3p11StKlC8p1nOrUlicXzw/2fLv25En9my+XHTl0u/RLVVSZLvpr9ZaaiRwzXW1x/VOHqWZDT6ZA/CVeCpX2otO3Okt9s6taTYf6S6NcagsaSPe6E/wBvC7HcbSXfQbvMq09Gaht2rNKWvUtpk8ShuVMyohPmA4fKfqDkEeoKvHrJt0REAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREARFX/tEa0Ogej2oNQwy+HXNpzT0GM5NRL8EZGPQnd9mlAV7px3+lv2m63UJPjaV6eB1Fb+cx1Fyf/ayDnB2AYz+6w+anuterdksFfJb6OmkutVEdsvhyBkbD5t3YOT9gojpe3O6PezZabOz9TfKyEOqHZO/3qYb5XE98tGWg/utXt0m6YWy62GO+ajjln96yYKcSFgDM8OcRg5Plz2x68Q1Jy4uGHM5nVtQvZ3KsdPxx4zKT5RXTv39Gbew9bbLVztiu1sqbc1xx4rH+MwffABx9gV9a96cad1Fa5NRafq6WheYzOZGH+rStAyScfKfqPrkLy1j0YtU9HJPpqWWkqmgltPLIXxyfu5PLT9SSo/7P16q6TUVXpOuDjT1DHkQyc+HKz5hj6jOfsFHmWeCp1NLOpdyrR0/WYKantGS7/TH0T9DR9GdHnU+oBVVsZdaqBwfKD2lf3bH/AMT9PuFM/am6pO6e6LZbLHKw6pvYdT25g707MYkqCPIMB49XEdwCrOZDY9K2KrqGRU1sttKyWrqHNbtZG0Aue8/QAfwC/n3rbV9d1I17cNd3Br4o6ke72ymcc+7UbCdg/vO5cccZccd0k1b0/E9C7Adj0qkbbn1nLwXd9F4vJprbRtoqbwhJJM9zi+WWR2XyPJy5zj5klZKItQ228s/StKlCjBU6awlskEOSCGkA+RPZeVZUwUdM+oqZWxRMGXOcoDqHWdTVboLYHU0PnKf7R32/Z/zUtKjOq9jU6zrtnpVPNeXvPklzf7ebMiitNDFQ2ufUkk9HaBLtcyMfrqmUuxIf3WsA2lx/ZIaCc42VHI66T2Cp1HDSUlmoB717jgtb7s+djHOaxoLgzBafiOX7HHJJypV0j0tb7HpSu15ry3VNdBbhNNbLVJC58bqgxBwfUbQ4xtfta1peA04yfLOT7RVpaeoVVerKKea1avtMcza3xQIIPDfEZXEjPbwmZ88yYGTwbft4ut7Pz38eqXozxKo5SXG/DbwWyz8PuynHPvmrb9FEBNcLhPiOKNgADWgcNaBhrGNGeBhrQPILZ0tvfRVTKK0wx1lwdGZZK6UAQU7ASHOZu4AaQQZH4wewBAcf26Vgvd9nsukLe6npK6pcWxNAbJPl24byOGxtxkM+VoaCckFykPUWKosdsm0nb/El4bWX66S5Brpy/AAceXxteeAM5cHHGQSrTluo/IqxgsOWc46/t+/49XaL1SUBqoLXRPvE7yZLjWyOkiknhb8UhZKHh0bT25bl3d3zCNsavlfNVSmnqIKRjqd5ZH7u8uZEwcCNmHFpYDk7hkuJJLjnKk4dY3WQ2O0Ohlgkd41bXudI2RkcYJc98ZDQck/AwPcPlGN5ydBdn2u4CnZaaOZtW97Y2xNZg45DWkDIkd8o3DZnBJaS7I+wxnODGpnhxkaQnvAuDqGyMc6pqmOjDmSOjcwY5dva5uGgAk7jtwMkYC3vUSS36auE2ldMvfDHFEIrrUCbe+pm7vj3gDMbchu0NbktJcCQMb2zQT6Bra9r2OimtVE2qrJZKcEVNU8tEFO0n/VsedxLfmMbz+FpbGND2dmrNQ260PvFSZqyr8Srgma4Ne0fE9zXgu3P2Bxy4N+5WPEm+PojPgcYqC/UyaaX0xUae6fU94mqzAbszxqqGttzqq3vg/1QmLAXRnneH/vAcKT27TktqsTqoaPs9fSVQD/0npWrfJUwbHBzHxNlyXEPDThrsccggYVh6h0hTVdWy72WRlovcWA2qjj+GZoAHhzMGPEYQAOeRgYIwo5Dpi52iR1ZbrZcbRLIc1MGnrhC6nlJABeIalgY08fhGfuqHt+PfP5+eZtla+z2xsvX8+XmVhW2q33eSeoquqsdRZpXD+o07JW1Er9w/VspCcNy7tjIBxgAdsXWdJdaTV12ZYrpaGRPqd0sNdNTU88R2t+B/j4LhjHylzT9DkK7bromgEVXdam53SsnbTvLhV1JEbwGn4ZBG0OLPVo4I4wVBrvbLX1FuNBIy+zWKqro9tXbaml8WGZ7WgGSne74C7a0APYSS0A8YOZIVk3np+dyIKts0sdX4/uypNXVrxqh8skkcfvNtpGzuhp43gZpYi7Y3hreeMtxgduOFlzTxU2iLHvFLFP4VTNT1ErZC9rhMcNYWHAdlvG4Ec9x57HVlPaKy93izR0UQutHPJSU7JHOhe6OImOIRvLyxxDGsGxzAXBvwu3O50ddfrra7XZbfRVdVSiGie2pgJPhyONRK4tew/C8YLQQ4EcEFW1ulj82NfNJOXFyf7k26VXhlZV3CmZhrZWtqxGBxG8/DKPoC4AgehU+VI9M7q+j1k2cwNENY7wJBG3DYy9w24HkNwA+yu5TnkvaW0VvetxW0kn9giIvhz4WK+outjvtt1hpyUxXuyyGaBvO2pZ+OB4Hdrxlv0zxhZSIT21xO2qxq03ujs3QOptP9UenNHeqeKKeiuEIbVUj3bnU8oxvhf2Ic13Hl5EcEKrOsGqr5ST12jDb6S22xrmeA2BpG+EZI57YJxkAcFuPXNa+zdrR3T/qgzTtZLjTmr6oRxhziGUVw24YQP8A53DT9Q05AC6G686cpbppR13Mcgqrbh4fGwOcYiQHA8jgfN9MH1KjrRbjlHd6u56lpTuLWWJY38VvmL69/wCbkd6adLrRdtEsrb9DO2prXeLC+OQtfFF2b6j4uTyDwQp7ozQOndKTPqbdDLLVObt94qHh7w30GAAPyChUXWSzW/StvipqKpq7iynbHJE4hjGOaNvxOxznGfhHn5KAXrV+tdc1ZoIXVD45O1FQsIbj97HJH944UanTglhZZqoajomm06XsKaqVUljC3z4vv8stci3bPr6G8dQbho+to6QUhbJFA9sniicjuD5YLc8eWCOVX/s+TSdOOqOp+iFe9woA9150w9/46WQ5kiBxyWO/iQ8rEo+mOubOLfeqSCF1eypYWU8coL48chzj8uMjB5PdZ/tb0NZZ7RpTq9bqQtuuj7lFNVMj+Jz6SUhksZI7jJA+zndlLSlJ54joez15e3EKkb2DjJPKyuj5L0/Yv1Fj2utprnbKW40UolpaqFk8Lx2cxzQ5p/MELIUp0QREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAXP3W0/0/8AaF0F0vjPi220k6jvbMnaRHxCx2PU5GPSQLoFUJ7N/wD7UdX+q/UZ5dJDNdm2Sgk/D4VM3Dtv0P6ooDw63Vlx1Nrh9mtVJUVbLTAd0cMZcdxwXuwPIZa38lhaQ6r6i0/HFb66GK4UcAEbYpB4ckbRwGhwHl9QV0Z4MPvHvHhR+Nt2eJtG7b3xnvj6LSan0dpzUjD+lbZFJMRgTsGyUf4hyfschV5UpZcovc4y67O3yuJ3lrcYqSfLGFjouvLlumabTnVHSV4hJfXfo6drS50NX8HYc4d8p+2c/RV90Ugkv3VG66lEZZBGZp+3Z0rjtb/Au/gtT1V6bw6QomXOkuvj0sswibDMzEoJBPccHgHyCtnovp/9A6GpTKzbVV39amz3G4fCPybjj1JWMeOc0pdCpay1HUNSpUL6KXsfeeOv+nv67/HYqP25NbPpNNW7pvbJyyt1A7xrgWOw6Khjdzn08R4DQfMNePNczRsbHG2NjQ1jQA0DsAFvuqeq/wCnnV7UuqY6n3i3sn/RtrcB8Pu0OQHN88OeXO+5P2WjVK7qcU8dx+qexWmK0sFWkveqb+nT9/UIiKodgaDVFvrLlXW+CGISw5k4cQIxJt+F0hPZgGSSeAAcrXXCKh0ha6ev0/BDdqiQNJvM7N0cTnGQAQxO4B3QyAPfk/ASA3gnXauvtyZXV9PA/ZSTMdRH1w1zHvwfLJDQfpwtTYaSqukT6eeukpbPSYmqpXZdHEOww38TySQ1vmSeQNxG2o02qay9jw3tNfQudSqumnzxl+CS28Nsr47FrezTqyajuGrItS+81On7rQOF2rZJR+qfhwa5znHkuD3twMkkjg4WL1evcV9go9JaYtXudrhkY2hp6RjN1VMdoL5g3GfEZ4cjXjg4ORnOyudQ399yp4LNa6d9FZqZ39XpGnLpHngyykfPIfXsOwAC3RqqyxU0FhoHSVOp6hgo5JG8uoY3OP8AVYz/AN4S47z+HOwfiXz+Xiqvtcbv8yaSNX3PZ9O/7I39ho6XSgNFQeDcbu94hq5o5WAPmJGKWEuIDwzLXSYzuOxh+FxUJ1hW4d+iaKSR1tjnfMH/ABhlRKeHSNDifhxwOTxk/iKyp6mCio6yso3h0NOz9GW2RrSBI5wPjzgkDOWk8O5b47P2AlDPLNb4oJ5iyy0tN71UxQ1BBqMODWsewPcGuMmADgEBxfggBSxWHxMwnLiXCtjW1pFrsjLcwkVdc1k9WeQWxfNFF+fEh7g/q+xaVtentJNRxVurA+GI25vh0JmkbG2SreDtwXcHY3c/A5yGjzUZqJam5XKSZzDLU1MpdtjZ8znHs1o+p4AVq3JtHa4qO309RbKq06RHvNcImP8AEmuBwA17nNALXS/CA0n4I3E9gF9qPCx3/n9DGjFSlxdFy/PmRXUdXFZKT+iVXHPK/DZ7m9kga91U7DiCS0k+G3DMcfF4n7SnHsxafgqNVXPUEYklo6GLwKaSeDa4ySdyMEgFrQQQCeJB2yq1dc7fepan9J0LIa2qmMjaikp3yyl7jnGHTNbyfMgnldUdLNLR6P0ZSWnvUuJnqnYxuldjPmRwA1vBwdufNV7mfs6fD1ZcsaXta3F0X4iUoiLUnQBVBr6gkoNSVFn086ClnkZT3m30krwyOWsjnd4jYt3Ac5mMtHfj1JVvrV6n0/adSWuS3XejjqInA7SR8UZ/aYe7T9QpKU+CWWQV6TqRwuZQuqtOjVeu3ahsx2y1skcElBV0Ze+mq/DLXMlYflaAzfuOQRuIDtuFX9np4NTXGoF0rKhle1pexsUbNskbG8sjaMBrmtGWtGAQ3aNpxm3dP2S+3RwuMVQ46t0+xsNbSTzGE1UsMwMEhwPiD6d00e93B3DyyVD4NKUcVwfqS1UN4e6kuH9Yt1Q00htp4kD5JQXOMbQeXANOBkluRnaU6iSazyNJVouTUsc93+d66nhpmzRzXSmjt8VGGsmjknlpnvkYYoyHB5LjwZHj4WYBAa7I7K0lo7HT0dlfSUNAx4tN0g9+tj5GYk2uAc6OT1cM8HzaPpk7xWYPKyeQdqa9SpfyjKOFHl4+PyCIiyObCIiA1+oraLtZ56ISGKVwDoZQcGORpy1wI5GCB2XY/QXWTepPSO33O5Ma+4CN1vvEJGAKmMbJQRgD4uHYHADsZOFyQrC9ka/nT/WG86Tnm20OpaMV1I1zSf63BxI1p7DdGS45/YHI7H6df2UveGrK2k9pbrz6/FfQnek+mHidQbha71Q177TSFxiqGfAyXkFgLvPLTzt5BU6vGtdD6BY60WykY+ePh9PRMHwu/fefP8yVuurF6qLDoS4V1I8sqXBsMTx3aXkDcPqBkj6qmelfTmTV8ct0uFVJTW5khZlnMkz+CcE8Ac9+eVWa9m+GC3PtanLSa6sdMpqVWeZcTS92Leyz4ePw3JZF12pjOGy6alZDn5m1gc7H93YB/NTX3vTXVDQt1tUU3i0dfSyUlVE9uJId7SOW+o7gg4yODwsQdJdDClMP6MmLyP7X3qTePr3x/JVlZ4ajpx1igtrKl0lHPIyFzj+OGXABd9WnB/w/VZcVSDXHyLcb3WNLqU5ahKM6c2k2ucW+XRfc3fsd3ysn6a1WirySLzoy4S2epaQQSxjiYnfbGWj6MV2Kg9OD+iHtpahtmDHR60sMVxhAPwuqIDscPvtbK4/f6q/FYO1CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgI91L1ANKdPNQ6lJG62W2epYCPme1hLR+bsD81XnsxUVv0H7Oul5r1Vx0jrjF+kJ5pnY3yVJMjc/XYWj/Cvn21LjJQ+ztqCngyai4yU1FCB3cXzsyPza1ywOvMJtGndJ6Xpz+opafYAOx8NjI2/wAt38VhUlwRbNZrOoPT7KdwllrGF4tpF0Wu72q6tLrZcqOtDRl3gTNft++DwvSqr6CkkbFVVtNA9/ytkla0u+wJ5Vdfom1dJNJXK70tRPU11XHHExs5aQZQHYDcAcclxz5NVUaa0pqfX9XX3GGaOV7HbpqiqkID3nnaCAeceXYDHbhRyqyjhY3NNd9obm29nb+x4q8t3FPZLz8Vv4HUFVT09XTugqoIqiF4w6ORgc1w+oPBUH9oTVUuiei2qNQUkjoauChdDSPZw5k8pEUbh9Q57T+Si3s9Xu5Mulx0ncHyObTRuliY85MLmvDXtB9MuHHbg+qh/t63kN03pHSLGv33W7OrJHA/D4VMzLmkfV0rD/h+yyVROHGdH2euY6yqc6ccOT4cdU84x8TmKzUYoLVTUY7xRgO5zz3P88rLRFo28vLP1BSpRo0404ckkl5IIiL4SET1jYqR0E9dJXmlh3eK9nhb8vxj4eRjPHHqFjaar6S5aUGnhGZvAL6iegc1jXVOMkzQSBocJmNJ+B+4OaPPAasnUMMV91EyzTV0kDIA13hRxb5JSQSSwZAc4DbhuQXAuxzgHRHR90juNGaOphnoKh7TBc4XEQgbuSScFrmAFzmkbmhpOMDK2tH/AKaU2eH9pp0HqVRW0MJNp783126JPbuPSmiptO0T78x0hqqhzhZWygCRjASDVOA7EYwz97JHyc/FJdL3PZ6isrLhXV0k7zR0Uc0zpcyPH6x7Q7OSGO28YIMrSOy9btfrfXXOtuFO+SKaT9XS0klrgqIo4mDbFGHPdluGhoJDe/qsTXdU83KG1kQN/RsQglEELImOn7ynawBud3wZA5DGqdJt7nOtqK2exh6iljjdTWqmkY+CgYWOewgtlmccyPyCQ7nDA4d2xsKwGnbROAmlaXvGYw34HAA85z3BPbHn3W2slPS3GpiZVW+KmpKWI1NXPE6QPkiYOR8Ti0F7sNBAA3OHktdDcK2Jk0FLUTQwT5DoGSO2EHyIzz+azXcRPvZuLBUQsqJ7+ykjpja4Q+EMe4NdUE7YcE5O5riZcEnIicOy3Wo7izS1otOl6Txffac/pC5vZM6Nwq5G/CzLTnMbCG8HuXcZyvO0w01srY6GpjbLS2Nhud2aeWzVLcNjgcPNoe6OI8cF8pzg5WBpm7XW8X4W2WpidPc5i0Sy07ZB4z3Ehzxj4gXHBJBwDnBxhRPd56InT4Vw9X+f09GTD2ctLfpzV0mo66N76W3P3xl+TvqDyMnz253euS1dMKJdMI9PWrTkNitV2tlZU0zS+t91mYT4rjl7i1vyjOQBjgADyUtBBGQcgrVXNR1J5N/ZUVSpJdeoRFgX29Wqx0E1dda6GlghjMjy93O0EA4Hc8uaOPNwHmFAk28ItNpLLM9fm5u4N3DcfLPK5i1/1X1Jq+5i06XFZQ0MjtkUNPn3moJ/aLeRn9lpx65W80f0Hrq2Jtfqq7S0cr/i93p8PlH955yAfsD91adqoRzUlgoK+dSfDRhxePIvt1FSOuDLgaeP3uOJ0LZsfEGOIJbn0y0HH0XP3Wm7vor8b/Y5S10dykp5Nh3NEzI2xzNmaRjD2xxhrckFrXn8WBbGmtF1emqiAWnVd2loWn9dR3DbUNeP3DhpjP2yPoVT2oLTU0OsNSVEsNTcILjXVDJbZTN8Q1LN2WABuS2RuS/d+ABuf7QA5Wyipt5yYXrm6aWMbmVDVtuGi59UQZ8GmuUddBGHbfd3bNtRTD90Mjy0Y+V7fPKmKr7UMlFpi0SWCrjnp6Suo5p7bHIHNdDiF7WvlGMmWRz5GOHAbsZ5BuJnp5zn2C3PeSXupYi7PrsC2NH9PgeT9trbgrQq9Xz+H9M+pnIiKU4UIiIAtVf66Wx1Nq1RTzVEMlnr4p3ugkcx5hcdkzQQCRljnAkcgZW1WLeKNtwtVVQvDSJ4XR/F2yRgFCzZ1lRrwqPknv5dfkXnoj3+/wCidWaeEr6qRjGXCD4i8uexw34PnuaAApT0J1vZrdY5LBeKyKhfHK6SCWV21j2uxkFx4BBz39VBPYrvBq3Uhqjtnmtb4CDwTJFI1ruP8DirP1z0dortXS3GxVjLdNK4ukgezMRce5bjlv2wR9lWjGS96PNbG/sLK+o04Xdpic6blTlF9UpN/LP0JVe+oujrVA6SS901U8do6Rwmc4+nw8D8yFSP6QreoPVejqo6cxCSojDIwc+FCwgkk/YE/cqQUHQ29PmArr1b4Ys8mFr5HfwIb/mrM0tpTT+grPV1sDJJHxwOkqaqQbpHMaNxAA7DjsPpnK+tVKj97ZFupb6vrFSCvIKlRi8vvePV/ZddytPaib/R3WnS3qTH8AtOoW26se3v7tVN2vJ9QA1w/wAf1V8Khfakr6DXHsv6mutldK4UEsM8bns2ua6KaMuOP7hcrp0tc23rTNqvDMFtfRQ1LcdsPYHf8VZTT3R3NKrCtBVKbynyZsURF9JAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAov2tP+sq3pfpY/2d01pRvm+sUWdw/wBvP5KS9ftK3C+Wuiudrp31M9CXtkijBL3sdjkAd8Edvqov7QxM3XnofQ4yH3aunP8A9uOE/wDFTnWvVC2aWv8AJaKq21k8kbGvL4y3adwz5lR1eHhxI0+uq0lZSp3k+GEts+PNfQpetqtb64raO11Tayulg+CNhh2BnkXPIAH3c5XKy52HpRpW2WmuM0k0zHvLoWZ8WUY3k9sDLgB9B9FJbZqm0VOnqG9VdZT22CtZuiFXOyM/bJOCfsoh1kv+nrb+jP0vpqC+R1Mb3RS+KG7B8PZwB75B4PkolFQTlnc5+lYU9KoVL2NwpVGl70k3hPGNll7r7Ec9nWnqK/Ut91FODlzPDLscOfI/e7H22j+IVQ+2pczW9cbHaA9r4rXYXVGAc7JJpi08eR2xt/8AWF0t0YuNouWlJpLJZv0TSx1j4zD4xlLnbWOLtx5/EB+S5E9pSd1T7S2rtxP9WpqCFuTngwB3HpyVhU92g8Hf/wAMLGEattBS4styzvu95dcPp3EIREWpP0oEREBXOvad1NqmOskhfJDNsdgEt37cAtBHY4A/iF6UtRUUVjvlZJPPLMQ2CSR0ri4VNRuzuyfiPgsqGE4zmR30Up1Rc5KWAUFG4+/VY2xgH5G+bz6Ac/8AoKH0UdLPpi4U5uMFFSyXGAtklZIQ7w45QOGNcckSE+nf6BbWhNyprK5HivaiypWl/UlTlxObbf8Atb3az1fJ9MJrvNXpeWCnv1LV1G0spiZw13Z72NL2s/xOaG/msdjq2LFzwT4kj2CaRocHPwN3fuQHA57jIPBwts6wTR2eO50Tqqch00hmgheWCFmA1/Ay3LhIMuxwxfN2pp5XWOwUjHPn8BjvDzw6ac7wR9Sx0Tf8KtcSbOT4Wlhn3XVdXHpYTVlVNPWXaQDfM5znilhOGjcTyx0mRjyMA+i2fTmzujZWatqGQyU9ohE0EbntcJKlzi2Frhn4QHDcc44b6HK+LffqSC+mjpI5xExraOhraLeJmtADc+EXbXtkdl7oyOS92CFILmaynvlq6fUDbZ71U1LJbs73GF8QqpAAQ1paWtEbOPhxyXqKTeOHv+n5sTwim+JvOPr/AH3IvKYotMRi4yPiku9Sa6odExm4RMLo4yxmWjBe6fLRj5WHgd990R0XLqi7V8rKt9JTwwPiZUGIl2X/AAu2j5d2xxHfgvaRnCjmsb6KnVVZLbPCFuhkbBRxujEjPBiaGR/C8EHLWg8+ZKuLSmuNM9OtDW+G4RCW73Nn6QnpbewYZ4oBYXAkBmWBnwj8hjCwqymoe6t2Z28acquZvaP5/UzK/oXbqOJtXpW/XK33SHJikqHtex3B4O1rSM9ieRjPBUh6b2fV1G5kV+2UTaCQsY2F7XwVMbmkO8Nod+raXCNwaWjYWkNw15Yxozq5pDUk7KQVMltrHkBkNYA0PPo14JafsSCfRT9a6pUqpcMzdUaNBvjpP4BVl1J6ZVuqXVj6W7RUz6moikPiNcRtAcHjj1Hhcdj4Lc47izUUMKkoPMSxVpRqx4ZciHdPtA6f0JbnSQBktZ4f9ZuE4AcQOTjyY36D0GScZWJcOr2gKKv9zffPFLXFr5IIHyRtI/eAw4fVuVqesVs1HqaxXxtM2qgtltjHgUsTSJLhKC0ve4EZMbBna0fM4Z5AauabRba67XOC226mkqKud4ZHGwck/wDADzPkrtGgqyc6ktzWXF1K2ap0o7HWruqWhMwNhvzKmWoLWxRQU8skji44A2tbkH6HBUY1JqSu01XXuntbDUXSorXVFRVys8UW+gAYN5bkZAc5+1mf2ie/O60f0n03p3UFNfoGyvq4acMEbnZibLgB0rQeQTzwSQN3GOMfmuIrXb4tQWqmb49/1XGWQQxU5Ly3wmwgucMgMadzySRjcfzhj7NSxHLLE/bOGZ4T8PzryIx1nsV5u2g3m9xU811tM0j6atiLIxVwBge52zJLTtDiWjzi44ORkWlrWWqkYw5a2BgB+m0Lz9pC7Vllp9NNoWF0UNQ98pJOCNmwRux5PaZR9QHfVfdmhlprVTUlQ5hqKaMU8+05Akj+B4z54c0j8lftG/Z7nm38Qof9Nro8P4LH3+BloiK0eZBERAEREBcnsOWyxzac1F41JC+72jUM7IpC5xfHBIxjoz3wMkyD8irO606+qtLxwWu0eGLjUxmR0rhu8FmcAgHgkkHv2x2VUexHMW6y6lUmcN322YNx6xSAn8yP5KQdeY2QdTrfUVzN1G+nhc4Yzlge7cP8/wCKjrPhhsd/ql3UttFjVt/clPhy1/u5vz8TQR1HU2/sFVDLqSqik5D4jK2I/bGG/wAEl0R1Eq4nyVFsuMjQ0l3jVA7f4nLpminpqikino5IpKd7QY3RkFpb5Yx5LzqLhb6fPvFdSxeviStb/mVh/LrqyD/0dQnHir3EpZ65WPnko3RVE2+ezvryxuwTPS1rG58i6mG0/k4ZUx9lu5uu/s96Kq3EkstjKb/+iTF//BbLSep7TrG036gtVudRsp4jE4ENAfva8AgN/ulQ72IJvF9mfTDScmJ9Yz//AG5T/wAVNTworB0ehwpwsKcKc+NJYzyzhsupERZm1CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiICk+s0bZfaY6HteQAJL47n1FJGR/MLw1maVvtCURrTCKcGHxDLjZjZ554X514lNP7RvQ2b8Pvl1jJ/vwwt/4rB6r2Ws1D1kdZ7f4fvM8DNniO2t+GIuOT9gVDX/SvM5btY5q1pOEeJ+0jhd7329Tde0TXWypsdoht9ZSTCOoflkErXbRt9AeFLb/AHe0SdKaunbdKF0xsxaIxUMLi7wu2M5zlVf/AKGNYft2z/8AuHf/AIrxrej+raSjmqpHW4shjdI4NnJJAGTj4VDxTy3w8znXd6tGvXru0f8AiRSfPbCx3FhezZ/2Frf/AKnJ/wCVEuVfaCJPtJa9z5SUIH29ziP/ABK6q9mz/sLW/wD1OT/yolyx7RMZi9pXW+RgStoJG89/6qxuf9lfK3/0563/AAof+Jaf9r/+MiGoiLVH6LCIiAgV+rKdlfdXVMskTqiUUrXxxh72RtYC7AJHcloPPmVh1dH+i9KeHcKScmevlbEHgxO+GJhbIAR2/WA4xyD5d1gazeH6mrtvYSAfmGgH/Jb2y2imvGjrPRy1b6aWS513hbWRnefDpBj45Gc+gbuJ7ALcwSjCL/OR+f8AV68695Vjz4XJL/7nn4t/Y+K+OkmvFu09PStDKejgZJPveH04LBNPxnaQ1z5TjHrysG3vqrrdLtdI4WNnmhmNO172MjbnAcAXkD4Y3HAHIO0gcL2utXDU671DUxva11RNVspQ5waD4jiwAk8AbHHk4HClkmn7jUaJ0pYYq+OkoZffq271EMzZYY2RytBkc6MlrsNDQBnkkDuvrlwpZ6/3Zr4xc28dP7I9PZ+05Siat1xeGA0VpY91Mw4/WStYXucBn8Defu4H8Kiug6qqn1Jeb69z31UFsrqsy55bI6NzQ/8A8UgW3bqSpuH6YGmxW262Wiz+7W2NjyHsa6pha+R5bgB78uc4/lk4yp17MFQzS9m1Xf6q1xXWuq6iis1BTeMzbUTVDnfq3P5aGk+GSeeAeFBWqSpwnUay9lj88yWKi3CEeSy8/nlsUTaqOS53elt8OGSVc7IWcEgFzgBwMk9/urm1502ukHTJ10FB7xf6i4e/3NkLQ50bHB/6tmPws3DIGfM8gDFtaTtVkuV51HR6j6f6WtOptK1NM5lVaI9sMnjgujc0YBLg0Z+LJ5Bw0hbqtu1FSPLHyF7x3awZI/4KrU1DLTxjH9/obLTdHncqUYJyb7lyOVekOg6/VWp6U1VvmFmhfvq5ntc1jmj/AFYPHxHgcHIznyXUOkrPUWK1G2zXWouUMch92fO0eJHFgbY3O/Hjn4uOCB5Le26nfX21tfCQInte5ofw4hnzEDzGSB9ylXA+mqHQSFhezAdtOQDjt9x2UNW79u9i1QsFZtwl+pc+h4otJqO81FDPFRUFpu1wq5G+JikhaGBozw6WQiNuSMYyXY8uxXpp6s1BWbn3ix0trjLcsa2v8eXPo4BgaPycVHwvGSbjXFwm3Wsqqm1W2ofJ4MTal/L/AAoxvd9z/wA1l26tpbjRsq6OYSwvyAcEEEHBaQeWuBBBBwQQQcEKH3RkrLjOJc7vEJyfMZ4KhrTcFsdBoGmUdRrNVZbJZwuv9CfW6OKtt0NWydjHSxySiN5G4MYduTz5u4Ci2stZ2XTNbLbppH1tzbTuqIqOmbmSZgJGWk4B7E4znAJAOFi6YjlfdGyMB2MB3ny5BA/mqz6iacu126vXOUUr44ZaFsdvq5JWxbahkQkj8IuILj4jdp2ZI3H6qWzXtW3Nmv7SWi0yv7Oi+LPyznb4YIPqTVFfedUy12qoHUlrvcLGCnB3OpoWu/VStb3y12Xc43AvAwHKx7FWwVVTdo4pBI6K4zPeQ7IJlcZfh4HwgyFoPIdtLgcEKqtWVc+otOf0ggMe8VA/TELYGh7KgjDZt4G7w3jPBOGvyABuatpoKXU8tnF4tFCav3NwpaprnjFTE1pczHnvYDtzz8LoxjDSt9ThywjzHX9Pq6laTpUt5L3l6Zz5bN+RaqLAsN2pLzbmVtIXBpJa9jxh0bh3a4eRCz1IePVKcqcnCaw0EREMAiIgLX9i0BvUXqDgfNR20n7/AK8K9epuiKbWVsiZ4zaWupyTBOW5GD3a76Hj7fxBor2J2Z6gdSJgQQIrZGfodkx/yIU+64anuNi11ZDRVdUyKCFlRNBFO6Nsw8U/C7HcEMxyD3WNVpR949Fr17ahokHdR4oNRTXnj6cyLS9IdcRuMLIqSSPPdlUA0/XBwf5L2p+i2rpP7Se1Q/353H/JpUppeulA7HvWnqmL18Ooa/8AzAW2petOkpcCWC6U5898LSP9lxVdQovqc/S07sxN5Vd+rx9UjU9A7NdrFf8AUFFcKKoiYNrBM6Jwjkcx7hlriACOcj6LWew2NnQOlpx8kF0rY2H1AlJ/4qZ9Ltc3DVUF7qq6mpYaegLTCYmuBc07z8WSeQGjt6qH+wxGW+zhY5nfNPU1khPr/WHt/wD4qxSSUdjsez1OhTsIK3k5Q3w3t1f3LwREUhugiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAor2mgKXqV0Yuz/hji1UKUv8AIGYNAH57Veqoz22430/R2k1HE0mTT1/obm0juC2Qx/5yBTvqbrmbScFpqaWihq6aue7fI55G1o2kYA75BP8ABfJSUVlla8u6VnRdas8RXP44Jwqu6mWnqNV3msqbFd5Ke0shD2sZUeE4EN+IDaNx5BPfzW1uPVvRNJkR19RWOHlBTu/zdgfzUbuXXK2hrm0FgqpwRj+sTNj/AJAOUVScGsNmg1bVNKr0vZVLnHX3G8//AI528DK9nK8Vdxtd4pq2rnqZYqhku6aQvdh7SO5/uLnX2t7ebb7R9RPlxbdrFT1WSBgOje+ItH5NB/NXD7N9aI9YXCjHwsqaQva3OeWvGB/BzlEfbvtXg6k0JqNlMdj/AHu3VE4acAlrZImk9vKXA+/ooX79uzof4XX7/wCVnJ7qXC/V4+jKEREWpP1EF+OIa0uJwAMlfq8q14jo5nu7NjcT/BfUsswqS4IOXcVDcGT1HiXWR0OyomccCdheCSTywHcB9SMKZ9PxDX1WiqBs0Qmpr5U1czPNsLW0z9x+4ikx/dURqLS+K2MrxcLdK1zWkxMqWmVufIsPORnnGVuOmsb2Xmqr9/hintVwfGf2nCleMD7bwVvJ44Nuh+cISk6uZdefxyam30k1QKi6vnipYISSZZBnfIQSI2t/E4/wHc4ClMt2rWaFtNqq75StpauaSuqKSp8bEzd+xjXGNuQwGInAcO4OOAVG7yPC0/YoGnDZIZqlwz+J0zoyf4RNH5LX19XJWPic5oa2GGOFrR2Aa0D+ZyfuSvrjxczBT4MpdUb6CQVOir7UU1DHTNNdRMdHBvLWt2VJPzOccZaO59FaOl9e6W0j0/8A6Aai09T3Smmp4q2qY6WSCQzyNEo2vY1x3hpjaPlwW8u8hXWn2VR0EaehjYJbneWUT5HZ84sNHBx+N/cHutd1Dmkbrq/wMkJhZcp2NZnLcNc5jeO2Q0YyoKlKNZ8EuXP4YJlN048S58vjlnW2j7ppuq6Yw1ekbNVWqmqzLVye9SGWeSUbm7nvLnF544JPbA47KMnk5KxelmqY6e8Hp5Xwx0tVbLfSinzwZXCBjpWnn5g4k8eWT5KY1WnoJZS+GZ0IPO3bkD7LQXNu4y2/MnpnZLWLWypShW2zjfHVc1tuYNqulynuFHAah7o44xAIx8LfDHOCB39cnzAUirzVChnNEIjVeG7wRLnYX4+HdjnGcZWPa7XT0GXMJfIRgvd/w9FnJRg4Lcq67e0Ly44qEcRSxyxnrkg1l6kWuw2q223WNh1HDWCCOKorpaZwibKGgOJeMhwJBOWg91l601VeWvs9Poiww3X9J5cKxz3OpoWDHxPe313eo+XgE8Lc1V9ooJTG0SSkcEsAwsWp1GzA92p3E+Zk4x/BSOtSUuLHz2KtHs9qVZJRi8Pk9l9X9jN0zbZrVahT1VX73VPkknqJtm0Pke4udhvk0E4A9AFmVVJTVWPHhZIR2JHI/NR+XWdsog0XR4p3yHbE1mXvld5NawDc4n0AK2GmZ75VQ1NTeaenpWSzF1HAwHxY4cfCJeSN/mQOB2X3/qLiIa1Gvp1ZUpZjJdz+6NnBDDBHshjbG30aMLnvqbrSOh1VHdKenkifKHPjdTRxRukfBUzRDxHuYZC3ETDtBHB8le99u1PaY6UzAukq6uKkhjB5e97gOPs3c4/RpXN3XwSS1kdRLRPpnw3OupgXubmSPcyRj8Na3AJkeRkE+ZLs5VyzgnLDRptTrTcHLO569QY6TTerXX62UgltFf8A1e4UgOxk0crBI0cdtzHDB8nxOPcKRX+tqbNoW2Q6NdA+2VrY6WmewkVIle4kuB+UuPxZB2kOz9hHZZ4rlbtL0lfKxlHqCyC2l7+0VTTyvZBKfsdjSf2XO9V59IbzW0U9fpSppIpa+Bz5rfDVnaIqhmRI3OCWnbuPH7Lh3ctrbTUItS+JhYXUKVScG+FTXNc11+DXzJZdY2abvf6b8N8FovIa6djxtdTTgDLnN8mkOAcfI4z3W9a5rmhzSHNIyCDwQqX1hrSqrtSUtRSVJqae37mse9ha2pc7+1eWns12A0N8mhoPOVYnTurhqrNOKSRz6SKpLKYO7sYWMeGf4S8t/JZt5eTyvtvYUXdSu7ePDF426d3p9MeW8lREXw4EIi+ZHtjjdI9waxoLnE+QCDmXd7DlBvpNe6i//V3qOgHP/wCmhb/xlP8AD6Ld9QKWnvvXugtNVH41OBDFKzJGW7S8jI57FZfsVWp9v6BWyvljMc95q6q5SAsLT8cpa0/mxjDn0I+6z9a9NtT3LW1VqazXqkpZpHNdETJJG9mGBnzNB8h/NR1k2lhHoutWVWVhQo0qbmoyjlL/AEpPPM0nW/RmmdNWCkq7PQvpqmarEZ/XveNmxxPDifMNX1VdK7JD08GonV9wjq22sVb4y5hYZPD3bR8OQM8d1Yt90TT6n01arfqOsq3VVHE3xJqeQAvl2AOd8TTnkHyWh6rW7XE1HDZdLUvj2Z1EIagbog5xBIx8RDvlDe3qsJU0svBr77RKNOda5lb5i4pRjFbqWN3hcsPmR3pE9lt6PavvEh2NjjqHOcfIR0+7P8ytl7HFG6i9mvR8L2lpfBPNz6SVMrwf4OCjWv467RPshaw/SMD6SqmpZoHsfjI8d7YB29Q4fxVsdIbV+g+lWk7OW7XUlmpInj98RN3H8zkqWksQSOk0ChKhptGElh4+u5KURFIbcIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgK79payv1B0F1nbYo/EkNrkqGMHdzocSgD65YFC66eTWvs0aKvdDFLV1PulI6QRsL3F4iMUoAHJw8H+CvWeKOeCSCZgfFI0se09nAjBBVGexrLLatKap6d1Rd42kdRVVFGCckwPeXsd+bvEKxlHiWCnf2cb22nbyeFJYMnS/RanrbVSV11u1ZC+eFsj6ZtMI3xEjJaS4nkduwUtt/SDRVLjxqWrrSPOeoI/3NqsBFgqMF0Ndbdm9Mt4pKim+97/XJB7N04t1n1yzUlrqfdYGRlgoWRfDyzaTuJz9e3dQ/wBtLT7r30FudbCyR9TYqmC7QtY3P9m7a8ng4AjfIc+WPTKuhYt5t1HeLRWWm4wCeirad9PUREkB8b2lrm8c8gkLNQSWEbextqNi/wDl48Kb4tu9/T02P5vwyNmhZKw5Y9oc0/Qr6Xiy2VmnbrddJ3LPvtirZKGR2ch7WuOx4OBwW4x248gvZaKceCTifpawu43ltCvH/Mk/XqvR7BfFRE2eCSF+dsjS049CML7RYlqUVJOL5MqanrYbSaiinsdtrKiOVwFRUeKXsI4wGtkDCARnDmnvzkLOt90fNR1U8j6aCSOmqRtiiZCHCRsceNrABn4j5eX0W5vlZbo9RT0V7oqCWDYH008sMm9pOMhzontcW53ckPxjAAUdr22yngrTb531AkZskeyJzIGOMjXNZHuJeRhj+XYJx24yd1FqaTwfnq5t5WtxVoZ/S5L4PP2PK801Wy2WyaaNkcLKYRxgzMLyHPfJnYDuAO48kenqgdeK9zrHbW1VTA2RxbS00ZO8hxIc5rR8ZGfmOSBgZwAFsL1USVVNYYpWU7KSppIml7KePxRseYnZk27vwZxnsQvmgtcohuVDHPc/Hikc2aGPbHTx7SQ180rnBo5zwR+YJWWdtyjjfCJb0/oquCl0/a6ymmp5/wClQqHwyxlrwIIGPILTyMh6i2hqKO5ahlvl4J/RVud77cJD+PnLYh6ukd8IH1J8lbPsz3K20ejboblNSwspK19UJJcDwx4TGudk9uOOPUqrNTVlHdZ22HS0D6KzwF1RDHVytZJVSHu9xOATt4aM9hxyTmGMm5yj8y1UpqFKnN9eS/PHP0Nlr2uuEmr260orjTw3CSno6p8MLJC+FzqaM4OWbC0g9txyDg+YXRGhtUxXeloaWtlporlVW+K4RwseSTC8eh5y0gtPfIw7zIHMGuRV2nVkNLU+9QOp6KgEsTJDG8EUsIcAcHa7jGcHBHZZeurzX09607cbfO+jfS2akFG6J53Rt2kkF3mdxfn1WFSgqsYrwM6N06E5yffujr5Re8W3UdFR1Utr1LJI17nPMdfSNm8MF2SI3RmMgAH8RdgDjCgsfWdtogsf6etstTT3C2xVBrKcgO8TlkgLOAfjY7sRgEcKydM6osWpIPEtFwjncGB74XAslYCMguY7DgDng4wfIla2dKpBbo3tvdUZVYy54aeM4z1IVS0Oo6tsVLT3C2e+PefidRuDC3HbBmGD35LvyWPcNK6jkracXfV9NDQvdtmhtjGNdj1L2yPc38u/bhWPNZ7dK8vNOGk/skgfwX5HZbcxwd4G4j9pxI/gqShUi9sfBfsdzW16xrJcXHjuy/rx4a8089SMaT01b6S7OqaCljEcbzmqLD4k2Dxlzsucex5JUxuFXTUFDPXVkzIaaCMySyOPDWgZJXjdbjbbLbn1lxq6eipIhy+Rwa0fQfX6BUf1iv2pdYw2+0WOglpLJXCSZr6hwidURxbSZpN2BHCC4EbsZxn0Ct29ByeG/U5LWdWVeXFGOElhRX3x3vmaCp19cNX9TRd4GS09FbaCvdQxZ5iApZTvcRwHkhp47YA5xktfxWauOqBO2sohRajEtRLG0TuLJmSjc1hLBguYzjdwD3PZYdgsd6tNPK6Osrqu1xW24yVEke9tDudSSNaIy7AkdkjJAxyMZxlZ9PX1FTd9Tl3gyPr9K01wcJoGStM0UEMhJa4EHs/uO5W1wk/d6L7nKZlKL9pzb+xgT0+l6vp/YHTV9zdQUlwq6X3mSJsDo5HsjkbuY3xTs4IyMkZJwcYOr1Q2oq7xaNT2Sshmrap+yaohOxnvsG3fIN7WYDmmOUlw7vfnssue9jUvTS80crZo5bVNS1sTXTukBaS6F+AeGNzI04aP8lp7JUV16sdztNX4kwdCKmkkcz/XU7S4tLvP9SZeD5hqkimst9PuRTknhLql8tvt8zbXKtsVVbaivo6USPnZ4tZa6SFwDajdguklB4pw4tc1rDgkgHBAcZ104tclp0lSQVEBhqJN0szXd8uPGR5HbtGPoqetkVZZrpbqyKvigkkLXCWJ+8Q7uweRx2IJbknBwcHhXhpu5uulvMk0PgVUMjoKmL9iRvcD1HII+hUsY45HDdsq9aVGEFH3c5b/AKd337uuzREWR52FpdbSzN05UU1KN1VWltHTsHd75XBgA+vJP5LdLe9F9PP1h1707QuY91vsDTfKzBwN7HbacZ9fE+LHmAV9Nno9s7m9pw6Zy/Tf+h2VpCywab0naNPUry+C2UMNHG4jBc2NgYDj64W0RF9PXEsLAREQ+lE+2q83Dp1YtGQEuqtUajoreyNvct37ifsC1n8Qr1a1rWhrQGtAwABwAqH1yf6W+2JorT4DpKTSVnqL1UgfKJZSI2A/UERuH3+6vlAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAFQFE8aD9s2up5g2K29QbQyWB27DffKYYLfuWhx+8g9Vf6o/2yLJWv6dUGurKHC86LuMV2p3NOCYw4CVv2xtcfoxAXgi1ekb5Ram0va9Q254dSXKkjqojnOGvaHYP1GcH6hbRAEREBx17Z+kXWHqbbdc0tOGUGoIG0NfI0OOKuIHw3O/CN0eGjnnYeO5NOLunq1pix9Wumt+0pS3GiqJ8Ygnima/3SsYA+IuLcluDjcBztc4ea4Nt8lXskpLlTvpbnRyOp62mkbtfDMw4cCPLkLWXtPfjR6x2E1TNOVhV2cd15Pmvv45ZkoiKgehmtvdjt93DDWRu3s4a9jsOA9PstTqmz0VJpGWmpIAwMlY5pLvxFwbucT9CQpQvieKOeF8MzGvjeNrmkcEKWFWUWt9kae/0W2uadVxglUnFrixvuiprdeqmgpfdm09JN4cniwOni3ugecAubnjnAyHAjgHGeVl6inuTqektVRGSXSOqQ5oO6odKQQT6kcgccEu9VLmaNscdT7yW1Dmhxd4T5MsA9O2cD6laG/XK53C50BoYyyd5LqGJjAZQDw1wPfe7u0DkENxzgrZQrRqSXCjyi+7PVtMtJyupYk8KKW+VnfPLHTHXwwfYntdm07PaS6guVdHUCariqBJ4RI+HZC+Nw3FuTuccA/gJAy780lXwTVdQblRmp07QMdUeBUPD3Q4OY42SYBG5+1paMAhziRxkQ/BzjBz6KS3KSa22uio2WWU25rhLUOqo3tbVVOzBy5pHDNxa0A+pPzEKVxS26s5uNRvD6I975Um60Nq1BdqSsrYzBJT1U0UrYi+cTvfy4td+CRg7fbsvzqHWx3Gl0vVxUsVK11lbH4UWdrdlTOwdySeGjkkn1XrcKu21mkKFxhp7XE6oqWOho4DPtcBAWkmWQvj3fFyHc7MYIzj9tMNCNOMfVvtcsdNVH4q2nqBFI2RhLB4kQEgO6KUbfl4Jzxz8W2HgyeXmOeaR626Wlu3TiOOribNNYK07Q+YsaKeoONzgAXFrZWjIbz+sUu6b3yxVFbS6VvlzppQ07rRdreZoZaBznH9R4kjWu2EnjO4c4OeNsK6TQm5audYS0iC80s9HKGx79mWF7H4P7D2MdnuNq8LFUu0/VVFLdtOxzU0dQ6iuk360va0nD4+H+FuG0ubkHDmhw+UYxnBPMfUzpVHHhn6P0/pg6g9z19RMbFS3ix3RgGA+tpJIZfzMbi0/cNCxp6fqfUu8MXHS1BG7gyQ0800jfqA4hp/NenSO7S3TR7IamsZWVVtnkoJahhJE3hn4H5PJ3MLHZ885+il61MpOMmml8DoIQU4qSbw/EhFp6c0P6SZd9UXKr1PcozmN9YAIYv7kI+Fv8+eVVXVy9yXLXs1UzUTLFSUTZLfBIY5XOmLHNMuAxp/Gcc4H6sea6MXHvUWvraDWN+tLXU0lPHW1TGeJTskLGSSFxDS4EtPPzDB+qs2mak22UtQ4aNNKK5v8APEytBXKp/pRdrpLFU6kfTUby0TFzpJYzLGxzsHJ+Rzjg581Y8lPWv1FTwT0cVObjp98M1NT2qLbE4wSN8Px/nABaOBx2HZVToWrZabTfbxK6sazwoaJppKgQTB8kniDa/a7b8MDs8cjI4zlSmuN0rdQdPtTxw11RSiOmhdVytLxuZWSNAe/tuIx91frNOPD+civSuF/Lxh1zn548zQdF6iUazNsjqI6f9K0U9EJJIw9rXuYXRktIIPxtZwsSt1LNBqK13CK83K8Mt8zZP603w48h2XMjZuIawgY8s55aFn6W/S1h1pVyW6GzFtBcwJo62SkY8COQ8MMxDm9iMsx5c8BSHrDZ4KLUtSy76ouUNlq3++2yCGnNTE4PHxeGN7WAtcSPXaWnJysXKPtN+qKkYy9jt0f518CL6nt1LbLne7DUV0UUNM/xbYap0zx4T/1jRG2MFoc9pZku4+3cTfp1NI6pndUCRk9VRwSuY8EHfHvheT9csbn7rPmsdHeLVpjUun6z3aoZbxTGoraCOd8gid4bXmNznNa8bDgjJ5HKy9NWN9p8WWqr319TKA0zPZtO3LnHuSSS57nEk8k+WAs6TbRxfay9tHSlQUvfXTweHz+HojcoiKQ82POpmip6eSoneI4omF73Hs1oGSf4Lof2MNIzWvQNbra4xvZcNWzNq2Mf3jo2ZFO382uc/I7h4XPli05U6/11adA0QlMdbIJ7vJFwaegYQZHE/hLuGN+rl1Dr7rBp3p3rC1aQNv3UEVM0VTqbA9ybgCJrWDuA0ZLeMAtxnsvkpxgsyZ6V2G0K4uuKpShxSaeF4Ln8f2xzLaRYlnudvvFsgudrq4ayjqGb4ponZa4f+uCPI8LLWZ08ouLcZLDQX45zWtLnENaBkknAAX6qp9q7WEukOi12dQOd+lrvttNuYz53SzZadv1DN5H1AQ+EX9l5ztYa/wCpHVpwc6kvFybbbU9xzmmpm7dw+jvg/NpV/KJdHNIQ6D6Y2DSkTWh9BSNbOW4w+Z3xSu49XucVLUAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAWLd6ClutprLXXRiWkrIH087D+Jj2lrh+YJWUiAoD2UbhXaUumpuiF/mc+t0xUuntUsnept8rtzXD1wXAnHA348ld15vtlspgF3utFQGoeI4RUTtYZHE4AaCeeSqV9p63VWkNRaZ642Sne+o07O2kvccQ5qLdK7a7OBzsLjj03Z8lKeuej6PqZ01hudjdHVVsEIrrXNHz47HNBLAfR7cY+ob9VhNyUW4rcuafRoVrmFOvLhi3hvu/OpNdWaw0xpSn8fUF7o6AEZayR+ZHj91gy535BUhrr2mKFrJaTSdiNXkFvvNw+GM/aNpy4fct+yrDo90xruqFwuE9TqGKkFG9nvXitdLUu3ZwQDgY+EjJdxjspV1Jj6e9J4nWPS1Ey86sLcS19cWzihz5hmNgk9BjI7k9gaUq9SUeJbI7607P6VaXStZ8Vet1S92K65b7vV+RGegWvZdC6/aLiDTWe7FsdZGQWtiBOY5QD5Nz/AOEnvwpB7Z/T6Sz3+LqvZ4S+hrfCo79HG0nY4DbFVE8jbgNYe2Ph77ipF7P/AEbnuFTHrfXcUkzpXePSUdTlzpXHnxps8n1DT37njg9E3q2UF6s9ZZ7pTMqqCtgfT1ML/lkje0tc049QSs7elJ0nGfJlDtLq1vS1aFxZv/Eh+prk2unjts+9bH84muDmhzSC0jIIPBX6t71T0FcOlWu5dMVQmlsVTmWw18uP10fG6FxHHiMJx5ZGDgAhaJa6pTdOXCz0/StSpalbRr0+vNdz6r86BERRmxPoWu4XiGegtkT31MsTmsLRw0kYBJ8hnzUQunTDX9Zey2PTk0Q+CNrjPGWNDWgfNuxjhTOiqqmiqGz0k8kMrezmOwVYGmdfRybaa9tEbuwqGN+E/wB4eX3H8ApqVeVL9KOL7WaLcagozhvGPRc+v79PmR+3dHc2CqqL3c33DUc1FJCybIEbHFpDcuI3PIJxuPOMDgBVDqqnu1TqbZFZax9yqKVja+2Gnk3CWNrWueAz5mO2hwIPmR5AnrmGSOaJssUjZI3jLXNOQR6grTap03S340k5qamgr6GQyUlZTFoliJGCPiBBaR3aRgr7SucT4pHn9zZ8dNQjtw/j9fMorTvT+71ForLHqCigtlTf4W1VryCwQ1NPuxG5o4aXxveec8AnBI4zb7pAWvTty0wYY566m0vTV5a47tsrKmZ0rm9s4EjwD6FXPd7LVVulXW6WtFXcomiWmrJ42s21LDuikIYMABwbwByARzk5j/U0R2S9WPWJAEMM4t1zLm5YaOY4Jf8ARr9p+uVJG4lOWCGVnCnHP5h8/hzObunWoTpzUEdc3wI9pD3zOaTIGMy90TD2BkwGE488ZALltOtUL/6UU12DWQxXu3090EEYw2J8jAH/AHJcwknzzysbX+iaywamq6SnfRvonOdNSu99i3GA8tJBdkccZI5PbKsjQlBd9b9IGVFJO9t7sldNHSPE74/eGO2Svie5rhgO3AAgjG1vI5KuznGLVVGsp05yUqD5rdeh4+zteKyk1NHYqhskb6qjcZ4X5/1YaYZeexLHFmPRjCugFy10g1FPSdWKCK5UMUEss0lI5jYhG6Jz8g7uNznbw0ZeSRz+XUq195HFTPebfTZ8VJruZ5VtRHSUc9XNnw4Y3SPwMnDRk8fkuQLrY577WVV5Ze7T75Vv96qaeon93MTpv1gG6TDCMOHZ3qMLsRwDgQQCDwQVyPfLTqHR3UO42W1XNtGc5jfNWMiilpzywPMhDHfCcbTnkHgqSxeHLD3ItUWVHKyjTWu0XWqivFipqmnkdBE2vfBDLHMKh0WRhj2khxayWV2Gk5DT3ICl15t5hp9BWKqtszbjNRsdHIJix0W+pe4Zbgg8HPkQp3pXQ8t+0G670rrTbtRCpdNbrla4zAxwa0NLXbQPhLvEaSBjsRkYzKtK6AibNRXnUI33SAVAjhjndJHAyY5273fG9wy87ic7pHeQbiWpcxzv0+uCtSspNbdfpn6lE322VElRQXyjqbY2C9W5hmkrmsMYqWsYJmbnghryfjB4OHHBV7UejLXqzpdYrVf2MkdDRQ+DUUsuSwhgaHscRjBaASMEH+BWuv8A0oE0tXBZrlTwWqvcHT2+spzNFA/cT4kG1zSwjc7gHHxHnHAnmm7ZFp7TdFajWSTxUMAj8ed3JDR3PoB5DyAA8lBWrqUVwvdFu2tXGcuNbM/NP2C3WTTtJYaSLfR00exolw4u5ySeMZJJP5rR6j06KeN1XQAmMcvi7lo9R9Fn2PVlJe71PSWujq6i3wxFxuoZile8EDYxx+fz5HHC1uqb770XUVG79QD8bx+P6D6f5pbKr7Tb1Od7Yf8AClYOVylxcoY/Vnwfd39PXBHFiXe4U9rt01dVOxHE3OB3cfJo+pPCyiQASSABySVIfZj0/aupPVs1923TWawRe+UNI4YZWVDXholcPxMYSCB5nGeMg7bKXM8n0XSKup1+CCfDHeT7kW10L01H0h6S3jqJrGn8PUV3jFXVxO4fBHjFPRj0PIzwDudg52gqMdAdE0nU+8ak1jrRrK+OaR0QiEhafGf8RfwctDW4DfLn91SPrnWf6TtaUHTbTl7pYnUNQH17JDgPf2JYc4eYm7iWcHJOM4O2orpbtf8ARLWIlhmfSvfkRVMY3U1ZH6EHg/Vp5Hf0Ko16mZptZij9PdnNIVvpsrehUVO4qJNLdNQXJLuz3rO3kdIaW17pWx6/pukVnoKjwqGnbBDURfG3xmtLnseAM9uS/wDaLs4xlT63aislxvdfZaK5081xt5aKqna7448gEHHmORyM4PB5XPPsdssdVfb3eLhc459TzktjhlP6zwj8UkgJ+Yudwccjbz8y0Oo6Ft79qF1J08qKm3VHveayshkyGSjJqJB+73BacguyOxAWca8lBS73yKd12ft6t9Wt+KUXThxSk+Tlzbed8Pw67nXC55vgd1b9qaitDP1ml+nAFXWOxlk1yfyxnbnbtHH7j/VWh1v1zB056Y3bU8mJKqGLwqGI8mapf8MbcDv8RyfoCtT7Neg59B9MaWC65fqC6yOud5mePjfUy/EWk4/CMN+4cfNXThSzEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQGNdrfRXa11VruVNHVUVXC6GeGQZbIxww5p+hBVH+z9XVvTzW116F6gnllipQ+4aWq5c/1mhc4l0WT3dGc8fR3kAr5VWe0VoO5aosFDqTSZZBrPTE/v9nmxzKR89OfVrwMY9QPIlAWVSW+ho4ZYaKkgpGSuc+QQMEe5zuS47ccknOe65Uvns869j1NV1VorKKopxVOlpqmeqImcN2Wudwfi9T6q8+m+tqHq10wlr7RWT2i5SRPpK2Jh21FtqwMOaQeQQeRnuMfXHNFx111asE1V0/N5uXvkFXIx3hgyVUjnHOGyYLy0/MMc/F6KndcCxxL4Hb9kFfTdV2lWKltxKeXtvv6cvXckWqbF1e01D4uoeqUNtBGWtl1BMHuH7rGjc78gVCrL1N1pp/VNHcDrG53uClmDnxS1074J2dnNLZMdxnkjg4PcKS6T6C9QdU1Hv8AfnCzxTHdJNXvMlQ/67Ac5/vFquXTvs76CtttmguDay7Vc0TozUzS7PDJGNzGN4BHcbtyrxpVZvMVjzZ09xrGkWUHTuZRqyezUILHx/8A6z4Ej1xpfSnWvpZHR1T3voK+NtVQ1UfEtLMAdsjfRzSSCP7wK4c1Fp/UOiNUVGj9XwiK5043U87c+FXQfhmjJ75wcjuCDnBBA7v0Hpmx9L9Hm2uvkooWSGV89xnYxrHOAzt7BreM4+/qtd1N0No7rRoWOB9XFMAXS2u70bg99LKONzHDuMjDm9jjyIBFupS9rDEuZxOlavLR7yVW3zKi3jdYyunr+d6OGkWVq7Tmpen+qDpTWlM2Kqxmjro8+717PJzHED4vVvcHyWKtTUpypvEj2XT9RoahQVag8p/FPuf55bBERYF42+ntRXKxy5pZd0BOXwP5Y7/kfqPRX5c7TV0LRI5viQkZEjew+/oubCuzYgDAwEAgtGQfsuX7R61V0qdGUEnGXFleWOT6cziu1VvTjKnOKw3nL78YKovVfJbaI1UdtrbhtPxR0jWOkAwSXbXOGe3ZuTyMArXW7UOl9SMmt0NdR1b37o5qGobtl+rXQyAOx9wrNu2nIZ8y0REMn7B+Q/8AJQDV2jLPdSIdRWOnqHgYZI9mHgfuvHI/IrY6XrllqMf8OWJd3X4dfQ4upGa5FadQujlvudlezTwNNWUx3UbZqh72BhyXQjdnY3PxDyyTwMkrfdCtKXTSOi30N4bHHV1FW+pdEx4d4YLGNDSRwT8GeMjle46dQU21to1Vqm1wt4bBDcC+Jv2Egdj+KyIdJ32AYh6gX7H/AM2Knk/3o1vpVXKHA5bFSFBQqe0UMPwax9jLrtD6YrdVU+p57Yz9KQODmyte5oc4fK5zQcEj1I9PQKRqGVVu6iW1xnt2obdfGDvTXCjEDiPpJFgZ+7cLO0/qmatro7XeLDcrNcX52slj8SCQgEnZMzLTwCecH6KKUZNc84J4SjF44cN/nNbElUW1roDTOr6ulq71RvfPTYAkikLC9mc+G4ju3JPoRk4IyVJ5pGQxPlkdtYxpc4+gHdRGv1PerkTSaRsFTNI7j3+4xOpqWMftAOAfJ9mj818p8SeY7GVXgaxNZ8OZIqmptNhtcZqaijttDA1sUZke2KNgAwGjOB2HA+ij8OvrfcHhunrTer61wOJqWk2QZHl4kpY3+BK+LJoGgZWtu+pah+o7z394rGgxRc5xFF8rAD24z9RlTEANAAAAHAAR8C8T4vaS8F8/2+pGIptc3FjSKKz2BjmnPjyOrZR6fCzw2A/4nBfT9LW9zTValuNZfNgBIr3tFO3A/wC4YGxnk8FzXO7c8BbW73ijtrD4r98uPhib8x/5KE3i71dzkzK7ZED8MTT8I/5lWKNGdTdbI5bXu1FnpUXDPtKv+nOy/wC7ovLn9TO1DfnVgNJR5ipRwcDBf/yH0WhX49zWML3uDWtGSScABbXpLoG+dYrwW0jqm16Kp5AK27NaWyVpB+KCnz9sF/Yc/QHa06caa4Ynkzd/2gu3UqPL6vpFdy+y9e9n50w6e3LrFqGS3wSzUWj7fMG3e4xnDqlwGTSwnzJyNzuwH5B1qdSHaZ6IxXWDR0cUWo780R0rYm4FsowAMNHqXNOPUgH8PNu368aM6P6Bp6aKGntlupIzFQUFO0bpXd8NbnJJJy5xPckk5K5Pvulda6r0pX9Va4Pq45qx4qBscHiMAfrWjGDED8PHy7fQHFe6qYXDHn9D3rsD2epWsOKrLhpNpb/55Zyl4rK39FyLL0B7P1bLZbRqW8X6qs9196bWTxt4dFAMOHxd2y8ZyeBnBGQr7q6bSvULSXhyCkvVmrAdr2nIyCRlp7tcDnkYIXJz+rWtdS6Co+nUDH1NdVTNpTVsf+uqYjgNhP1J4Ls8gAHzJup2l710o9n65x6cq4nXtsfvdbUSSfCwnAkMQPGWtGBnvjPfAWNGcEnwLbG5u9ds76VSm7yslVc8U0tkot/qyt0s4x1+1K9ZOl146XXWnvlouMslqfUAUdWyTZPBJguDXYwc4Bw5vfHl2Vx+yZoh1m0tLq64xn9I3kfqS/5mU+cg/wCM/F9QGr80VXWDr/oWOh1PTVEV0s80bqh1OSxrnH8bT2w8BwLTyOcY4KzvaB1rXWmit/S/QMXiay1FH7tRRwjDbdS42vqX/sta0Hb9iR8uDlRoR4/aR5dCtruvXf8AJf8ADrhYrJ4m8c0t4+eefTy3I9St/wBNvXx1Y/E2hNAVBZTjAdHcLr5u/ebHxj6geTiug1GOlmi7X0+0Ha9J2loMNFFiSUtAdPKeXyOx5ucSfpwPJSdXDhgiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIDnzq9bbl0f6gO6z6Vppaiw3BzIdY2uJuQ5mcNrGAdntJ5/5OcVNtQaZ0JqestnV2OqrKmOipG1cM1scSKljPjY4hoLnEcjAx6HsrJq6eCrpZaWqhjnp5mOjlikaHNe0jBaQeCCDjC5tgNd7NOuTHMamp6RX6p+B/MhsFU89j5+E4/8ArcPjxlFSWGWLW6qW0+OnJro8bZT5r1JFV+01o9lqE9NZ7vNWlzgKZwYxoAPBc/JxkY7A4Vbag9oLqDqOsZbtOU1NaTUPEcMdNH407y44Ddz+M/ZoKn/UToVT33V1u1Roua1R0dZM2esgnG+mc0/F4jA35muHdoIznIIB43XW7pbpK86VmltZtVhutlpTOx8TWwxiIZO2RrezSQ7DvI578hUpxuGnl8vmd7ZV+zdCdJwpcTnz4ve4H0TXJrPrjcpbUnTXXBslRq7qVfjb6aIfD75UmqqpHH5WRsBxk+hcMeeADjZ+yTe9Vw62dZLVGaqyTNMtwjlcQynAGBI0+TycDH4vPtkQO5aj1t1Kq7FpypqZrnPABTUcQHL3E/O8+bsYBcfJuT5k9i9ItB2/p/pOK1U2yWslxJXVIHM0uPL90dgPT6kqKhDjqcUOSNr2hv5WGmyt7zhlUqbRjFYjFd/f4+fLkzY9QdGab15pqbT+qLbFXUUp3Nzw+F47SRuHLHjJ5HkSDkEg8WdYej+relUs1cxlTqLR4efCuMTN9TRtPZtQweQxjxBweM4JDVcHW3qxqfRvV1sdmvlDX2+nga2a2tjOxhPzNkP/AHnmC08DAx3zbHSzqlpnqDRhlDMKS5tZme3zuHiN9S09nt+o/MBWpSpVm4PmcnbWuraJRp6hQ3hJJvGcLwkvvy7mcHU08NTA2anlZLG4ZDmnIK9F1H1c9mLT98nnvvT6oi0tfHkvfThpNBVH0dGP7M/vM4HPwknK5l1nY9V6CuAoNd6eqbQXO2Q1rR4tHOf3JRxnHO08jzwqVW0nDdbo73R+2VlfJQrP2c/Hl8enr8WYxXZ0P9iz+6Fxex7JIw+N7XscMhzTkFdoQ/2LP7oXmfb3lQ/8v/1Hatpqi1/u+x9L4miimjMc0bZGHuHDIX2i87jJxeU8M480Ffpmmly6kkdA79k/E3/mFpKux3KnJ/UGVucboviz+Xf+SnSLpbLtZqFslGT41/u5/Hn8cmLiis3AtJDgQR3BX4rIqKanqABPBHLjgb2g4WsqNN22TGxssP8AcfnP8crqLbtvaz2rQcX4br7P5GPAyFIpnDpq3Mdl5ml+jnYH8gFn0tsoKUgw0sYcDkOI3EfmeVJX7a2UF/hxlJ+iX7/IcDK+rWTUlqmuc0EopoWhzn7e+TgYz35KhN01RVVGY6Nvu0Z43d3n/l/65VudUv8AsJcv7rP/ADGrni5XChttOZ6+qip4x5vdjzA/4hdN2U1D/i9tO4qQSxJpLwwn8dzzDt1rF/bXULO2m0pRy8c222ufPp0Mt7nPcXOcXOJySTklYF4u1BaYWyVs20vcGRxsaXPkcezWtHJJW+0TorqH1D2P0jYhQWt5wbzeGuhgLcuBMUeN8hy0jsADjPByumekHQ3R3Tuobd2e8XzUZYWyXe4O3ygHGRG35Y298Y5wSNxC6/ByGm9ma9y+O492Pzf7FOdJegF71m+G/dT6eqstlaWvptPslxNVDh26qcPlb5eGMO9dpHPTsdz0zY6ug0xHW2y2zOhDaK3teyI+G3gBjOOPIAehx2Krnql1rtVk95smkQy+6gDSGthG+KF2cHJHzuGc7W+hyRhcr3em1NfNcVFJfZZhqCom2yCud4bzL+FmTgNzwAOB2HAVWtdKDxHc9v7N9hvaUW6j9lBLK7344e+PF8/mdGdfujl31VdLrq2gvM1Q+GiYaW2vaXEvZ87GHOGgtGQAOXE9lqfZG142opp+n14ka/a18tu8TkOYcmSHn83Aehd6BQTR3WLqF09r/wBDX2Kor6enO2ShuYc2aMejXn4h9M7hjsFH9dXuy/0zp9daFqJLfJNOKmSikAbJR1IOXYxw6NxyRj1IIHANZ1YKXtI8+qO1paPeVrSWm3bUoYTpzXJNLZPG+/f13WXlEu9ofpRPoq5/0q0zHI2ySyhzmxE7qCUnjkchhPynyPHpnAr9e666uUFi6fQRtdO5wFXMwke9Fp4klwPha0DJ9Tz6BdF0l5f1R6L1VTp+WlgrrlQvp3snbvZDPjD2OH8cE+Ra7B7KKdOdOaf6FdNK/WOs6iKCvMIfWyghzox+Cnj/AGnE47d3eeACpXQzP3H7r5mpp9oY0bJ/z8FK5oy4YZ55xzfl39Wl13NterlpP2fOkG936+VnwQQtH6+51rhwAO/JH12tH0WP7POgLva21/UTXpNRrvUmJKvf2oIO8dKwfhDRjOPQD8OTGulGkr71S1tT9Z+pFE6kpIRnSlgk5bSQnltRID3kdwR/HgBgHQavJKKwjz2tWqV6kqtR5k3lsIiL6RBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBYN/tFsv9lq7NeaKGut9ZEYqinlblsjT3B/59weQs5EBzvZbjfPZ1ukOndSzVN26W1U+y1XlwL5rK554gqMd4snAf5f7I1XtH9Mqoir6g6Rqpq233CMS3KGKYyAsOHCVpBO+I4aSOQ3AI4+XpO722gvFrqbXdKOCtoaqMxTwTMDmSMIwQQe4XO8sOrPZxuEjqWnuGqOkkzy58IPi1dh3Hnbnl8PPn+ZB5dHVpKpHDNppGrVtLuVXpb966Nd37Pobf2QdHWul0vJrGRj5bpVvfAx0kRaII2nswkfFu7lw4/D5OWb7Q/WSPSsMumdMzskvsjcTzt5FE0j+chHYeXc+S+eocN/1/py0a16O6yE1vo4iIaGikETXHscdvjAw0xvAx5Yzg89dPKLT7+pEVP1JqK2ipWzONUJmO3Pmz8spPxNBOdzsE/bORTqTlSiqUVjxO206zt9YuKmrXM+NLf2a3axyTWFlY5YWG+fXM59n/pDU60rm6p1QyYWRshe1shO+vfnnnvsz3d5ngeZGz9onpjSaDdS640dUTW6L3trH08chBp5CCWvid3A4Ix5ZGOOB0j+nNMW2yRVQu1qpbZFEPCkbUMbEIwONuDjGO2Fyr7SHVaDXFXDYLAXOslHL4hmLS01UuCAQDyGgEgZ5OSfRKtOlSpY6mWkanqur6sqsU40ls1/lUe598n8fQvzoh1Cbq7pmb9epooKm3F8NxlPwsyxod4n0BaQT5ZypXbrlpbW1hlFJUW2+2yobsmiIbLG4H8L2Ht9nBUppu3W7pf7N9e7WdCyepvT3Sfo2Ulpke9oEcRwQRgMD3diOfMKlukml9d3+5VldoWSalqbfGJHzR1BhySeIw7sScHgnGAcrP8AmJQ4YtZbXqUH2btL13NxTqezhGeIt44PHfOeeyfLlz6XlrX2VdAXN8tZpKquOkK94JHuknjUrnE5y6GTPHoGuaB6LDltnXHSjmRXLTVm1vQNAHvdmqRSVLWh2Mvhl+FziMHDCAOefXAsPXjWOkLi2ydTNOTyPZ3nZEIajH7W3hkg+rdo+pXSFsq2V9upq6OKaJlRE2VrJmbHtDhkBzfI88hU7/S7DV4cNxDOPRr1W/zNHf2upaSoRqSzB54WnmL78f2Ob/8AS3pqgnipdV0V80hVSkNbHe7dJA0uw04D8Fh+bvnyJOApRZdU6ZvQabRqG1XDcAQKarjkPJwOAc9+FdB9yuFO+M+71cBdte04e3IPYjtkFQu/dGulN8i2XDp9p0/Dt3QUTIH4/vRhp/muQuv4cWs96FVx8919n8yCGsVI7TiaNF4j2cel0DnG20N7tYOdraO+VcYjOMfCPEOP8vy4Xx/0fNMs4pdZdQ6Rncsh1JMAT6855/5LU1P4b3CfuVk/TH3J1rMOsfmZK/Huaxhe9wa1oySTgALw/wCj1pR53VWqtfVb+wfNqOckD04xx/zXrF7OPSPc11dp+sumw5Y2vu1VM1p9Q0yY/ksqf8Nq7/XXS/8AHP3EtaiuUfn/AEI9edfaJs0XiXPVllp+Mhrq1he4Zxw0HcfyC0tJ1LF9n8DQ+jNV6rLi0NqaWgMFJyW4JmmLGgEOyDyOCe3KunT3TLp1p9rBZtD6do3MAAlZb4vEODkZeRuPPqVtNS6q03pmISX690FuBGWtmmAe4fut7n8gtxa/w7saXvV6jl8l+/zIVqlxWlwUYbvuWX+ehRdV096y9QKKWkvlTZOn9omaxr6aE/pOucfhc7LxtjbyMAtyR8XfgqbaD9n3prpSrNwktcuobmf/AI29vFU9vA+VhAjb27huecZxwvS+deunlFa6uptlymvFVTtDhSwU8jC/kDO57Q3AyMnJ+xVOS9YeoXUbV9Bp2w11JpqKsqAyIRuOfUb5cFx7Yw0Nz2wuvsray0yl7G1jhdy7/F/uyzQ7LahqE5XFeHAoreU1jCW/LGcdeWDo3X3UDSuhqZkmoLk2GWRpdDTRtL5pQPRo8vqcD6qiNR631z1rrJbBoShq7TZoo3mqlkl2iYYyGyPa34c8gMBIOeeBxb3Wjp7aNaacqayspHS3eht9QKBzJHNAkLQ4ZA+b4mjGfUqmvYsvXganvdge/DaylZUxg/tRu2kD6kSf7Ks1pTdRQbwmbXRKFnS0yrqFGHHXpf6v0rL5pLntvv1RHvZQu1DaeqzaC5UsPi18D6enlljG+CYcgAnlu4BzT6kgKwPa70Aamjj15a4f19OGw3JrBy6PsyX7tPwn6Fvk1Vv7Q9hqdD9Yn3e2Zp46yVt0o3tHDJd2Xj8ngnHo4LrLTNztuttDUdyMMc1FdqP9dC7lvxDbJGfsdzT9lHRgpRlRl0Nlrd9K1urbW7feM0k19V8PmslV9HrjpvrH09Fn1jQU9wu9paIZZJOJiw/JK14+IE4wcHkjJ7hQvqL7Nl0ojJWaKrhcoO/uVU5rJm/Rr+Gu/Pb+ar2z2a+s6oXXTvTG51VUJXy0rKuneWA0xcMl7/Jo4Bd5kcdwun9XdQbP0i0BbW61vX6UvQp2QwU9MzNTcZhgAMZnJycAuOB59zhfaUVXjia3XUi1a6r9n7hVrKt7lT3vZvOye/Los92H06Gh6aWG2dCem9z1BrbULads2yarZuzFC4AhscY7vkOccd8AAcZOm0vpjUPW/VNv1/1Gt0lr0VbpPH03pacfHUu/DWVg7HI+WPtg/s7jN7aF0JqvqXqqm6i9YqL3Olo379P6UccxUfpNUD8cv0PbzA4aL6V2EFCPCjg728q3teVxWeZS5hERZFUIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgC/Hta9jmPaHNcMOaRkEei/UQFF6u6R37RuoKjXXQ+qhttfK8S3HTcx22+5Dz2jtE/0xgehbznWw3Xpl1xndYtS2+p0hr+lb4c1FVgQ1bHDjDC4bZ2eg748hnK6GUI6rdLNHdSbeyHUVvxWwD+p3KmPh1dK7OQWSDnuM4OR9FjKKksMntrqta1FVoycZLqik6z2Xbw2qIpNV0ElPnh0tM9j8fYEj+asPpr0M0poicXy8Vn6Xr6YGVs1QwRwU+BkvDMnkftOJx3ABUXZqLq90UlFLq6hrOo2iWcRXmgizcaNmf9ezPx4B758vm8li6qobB17kGo+nXUeKWtjpPAfaKhxiMbD8zS0Ye3J7ktcD64AVd0IU/ejHLOopdor7Upfy13c+zg+bUefg8Ye/w7yuur2rrn1Z6kwW6xxyz0bJfdLVTjjfk8ynPYuxnJ7NAz2Kkmh9ba06It/o7qXRoNtlnMniBux73HglsoyyTgDjvwBkLQaQk1L0P1mbpqTRhqA9hgZNI4hrQe5ilblm4jv3OOOMlW5B14pNVarsendNaTlusde4CqjrCGOidnORjcMMALiT9MYwqlPm5SliR2GoKUaMLW3to1bRRzniS3W7fEnt6831Jbcumtk1lrKy9Qbr+k45Y4I3/ousDNjcDcxrmjO0hxyW5IJ/NWRI0ujc0OcwkEBze4+oyv1V77Qerv6IdMrhUwS7K+tHudJg8h7wcuH91occ+oC2L4aacjzOErnU61K2Tz/liuiWft1ZyZ7tWf6VJ7LoK8XPNRcTTUdX7yWyy/FjxHPZjjOXZx25Vo6y1D1y6VUNM68XyjuNFNJ4bKiQsny/BO0bgJCMDOSMZ/JefscaR991DXawqosw29ppqQkcGZ4+Ij+6w4/+4v320L0arVNk09E4uFJSuqHtb+3K7AB+oEf+0tdGLjSdTOH0PT7i5hd6zT03gjOMY++5JN5Szz+Hqzc9E+uuo9S69odO6kitgpq1r2RywwuY8Shpc0E7iMHBHbuQp71x6oXPp3PbjR6bfc6WdjnVFQ8vZHEcgNbvDSNx+Lg/Rc39VrDV9NepNrkpG+E+CloqynPl4kbGtd//AJI3H81aXtb6sp7loPStLQSZgu5Fy4PPhtjG0H7mQ/m1SRrTVOSk90au50Wyr6laVaFJOjVTyllLZN528PmiUdJ+uU2u9V01hbpCWiErXufVNrfEZGGtLuR4Y7nA7+audV77Olk/QXSCxxPZtmq4jWy8dzKdzf8AY2D8lYSuUeLgTk8s4fW3aK9nC0hwwi2ubecN779/cVV7RfU2TQVgho7SWG+XEOEDnAOEEY4dIR5nnDQeM5POMGn+lfRe89RYP6XawvNbT0lW8uYT8dTVD9vc7Ia30JBzjtjBWp9rapmn6w1EUpJZT0UEcWfJpBf/AJucumbtPeLR0khk0Tb46q4QW+mbQUz27mlvwNxgEdmEnv5KrtVqy4uUeh1ylPRtKtlaYjVr85vGyeNsvkt15bsqXQ/R26aV69xVVDbZarSVKx2KqrljcXbqcjBbwXESHybxhVj1ip5dE9fq6vpWFvhXGK6QY4B3Fspx9N24fkt3N1I6qR9UrVY9U3iooXw3OlbU0VOI427XPY7aTH8wLXDIJPfBUq9s/S87prRq+mhc+JsZoqtzRwz4i6Mn77njP0A8wopqLptwXJ5NxZ1bqhqdGN/OMlVp8Kcc4eN023zb35bPOx0hSVEVXSQ1UDw+GaNskbh5tIyD/Arj3p7AdJe1Iy2QHbDHdqika0djG8Pa0fwLT+S3uivaLlsGgKSyVNgdW3KhgFPBOZ9sT2NGGF4xnIGAQO+O4ysr2btHX7U2v5ep2oo3xwCWWeFz49vvU8gcC5o/YbuPPbOAOxxLOoq0ocHM1NjplfQ7e9lebU5RcVuvee+MfH5+DJH7aBsx0nZm1TpG3YVT3UW2MkOjwBKC7sBzGfXIHHcjVezHpjqPR1dDd7lWVFs0tTRyllFVOI8cSDO5sfkN2HbnflkEqb9YurPSvTNdSUV78HUmoaSbfQ2mggFXUtmwQPhHDD/eIPYgHCibNKdV+tkpn6gVFToLRLzlmnqKTFbWs3dqmT8IIHbH+Ed1O6GavtGznodonS0pafCGeeXLfGc/pXTbr3tnteOo9no9QXbSXQXTNNqPVtwndLcK+Af1Che52DJNN2dgkkMacZz55BlXSro1SadvUms9Z3N+rtc1ODLdKpuWU3HyU7Dwxo7A4z6bRwp7ozSmndG2OKyaYtFLa6CLtHCzG4/tOPdzvqSSt0p0kuRztSpOpLim8vxCIi+mAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAFVXUnoJoLWVabxBSz6c1C074rvZn+7Th/7TtvDj9SM/UK1UQHPFT/0gtAUslvutotXV3TPyueAILh4eTw9hy2Q48sPJ9V59IOovQik1bVTw0c2hNTVLGwzW++ROpvDyeQwuOxuSBxkZwOByui1odZaM0prKh9y1Tp63XeHGG+8wBzmf3XfM0/UEL44pvLRPTua1OEqcJtRlzSez8zaz1jG2ySvpWmsa2EyxtgIcZcDIDfIk+S4t666u1vqqsoG6s07PY2ULXtjhNPJGxznHl3x9zgNH5fVXJL7Ndss0pqOnGv9YaKkySIaaudPS/nG4gu/NxXjLb/ad0vE6Jtdo3qPQY2mKrh9yqnt/LbHn6uLlDXpOqsZwbfQdZp6TW9tKipvo84a5p45rfPcSf2fLvpe2dFLdVsqBbKGBxZVVNwLIGvqCRvcHF2C3c7aDnyA8lRVVWUmvvafZUPqoH2592aGyGQeG+CnHGD2w5sfHru+ql2sNbXy46XZprXfs860tVrhmEzhpuSOrYHDcc/A0NAy4nv35yoDT1fs1y1jIbpf9caYqMjNPdqEt/I7InY++VFVpVGoxS2Ru9J1jTqNa4uaspRqVeJLbiwnvnO2XnyLg9svTordIWzU0DN0luqDDM4f91LjBP2c1o/xrnqOrr9Z3DSemsuL6eNlshPfO+oe4O/ISNH2aumNV9Xuh2r9H3HTcnUOzQQVtOYWveHN8I/gcA4D5SAccdlW3S2w9J9Ma7t2opOtej7jBROe9sMlTFTkuLC1p+KU9ic/ksK9vKVTMeT5lzs92ktLTTHSry/xKfE4bPfKeN8Y5trc6so6eGkpIaWnYGQwxtjjaPJoGAP4BeqgNT1q6SU+fE6j6Ydj/u7jHJ/ukrVVftD9FqYEydQLY7H/AHTJZP8AdYVfPO223lkA9sDQlfVVNLra2Usk8MVP4FxDBkxhpyyQjvj4iCfLAWg6a+0RV6a0rTWK8WI3T3KMRU08dT4bvDHDWuBac4HGR5Acean03tRdPKt7odL2nV2rJPlDbTZnvBP/ANwtP8lG6nUmrtRVhqdM+yrA2pkORW3/AN3pS0/tOjewE/8Aiyqs6ElNzg8ZOutO0VrOxjZahQ9pGH6Wnh+X4+XQgdHS6s6t9WnartGnXwskqoJZXBx8CARhjeZCACcMzgcnnAXX+q6jT9NYap+qZ7bDaXN21BuD2NgI74dv48v5KlodGe0ZqeNkd96h6e0PbyP/AHPTlAZZGN8m734LT/deR/ks+z+zPoT36K56xuWotcXBhLjLe7i+Rhcf3Bjj6ElSUqPs85eWzW6zrb1GVNQhwRprEUm20tuvoiCT616J0t9ko+lnTKs6g3xpwG0VPJJSRnvl0ku5rR+8GkfVSR2jeu/U8BmuNR03T3Tr24daLA/fWSNx8r5skN/Ikfuq+LJaLVY7fHbrLbaO20cYwyClhbFG37NaAFmqSMYx5I1Ne6r3LTrTcmu9t/UhHTLpRoPpzTbNL2GCCqcMS10362ql753SO58zwMD6KboiyIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgC8K6io6+A09dSQVUJ7xzRh7T+R4XuiAjVT0/0HU5950TpqbPfxLVA7/Nqwj0o6Wk5PTXRpJ8zY6b/8FMkQEOj6VdL43bo+m+jmOHm2x0wP+4tjS6H0VSkGl0fp+Ajt4dthbj+DVIEQHzFHHFG2OJjY2NGGtaMAD6BfSIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgP/2Q==" style="width:100%;height:100%;object-fit:cover;object-position:center;transform:scale(1.08)" /></div>
    <div class="header-text">
      <h1>Les Délices de l'Afrique</h1>
      <div class="header-sub">
        <div class="pulse-dot" id="statusDot"></div>
        <span id="statusText">Connexion…</span>
      </div>
    </div>
  </div>
</div>

<!-- MAIN -->
<div class="main">

  <!-- STATS -->
  <div class="stats-grid fade-in">
    <div class="stat-card">
      <span class="stat-icon">📧</span>
      <div class="stat-val" id="statTotal" style="color:var(--ocre)">—</div>
      <div class="stat-label">Emails</div>
    </div>
    <div class="stat-card">
      <span class="stat-icon">✅</span>
      <div class="stat-val" id="statReplied" style="color:var(--vert)">—</div>
      <div class="stat-label">Répondus</div>
    </div>
    <div class="stat-card">
      <span class="stat-icon">🔴</span>
      <div class="stat-val" id="statUrgent" style="color:var(--rouge)">—</div>
      <div class="stat-label">Urgents</div>
    </div>
    <div class="stat-card">
      <span class="stat-icon">🤝</span>
      <div class="stat-val" id="statPartner" style="color:var(--terre)">—</div>
      <div class="stat-label">Partenariats</div>
    </div>
  </div>

  <!-- CONNEXIONS -->
  <div class="card fade-in">
    <div class="card-header">
      <span class="card-title">Connexions</span>
      <span class="card-action" onclick="refreshStatus()">↻ Actualiser</span>
    </div>
    <div class="card-body">
      <div class="conn-grid">
        <div class="conn-pill">
          <div class="conn-dot on" id="railwayDot"></div>
          <div>
            <div class="conn-name">Railway</div>
            <div class="conn-val" id="railwayVal">Serveur actif</div>
          </div>
        </div>
        <div class="conn-pill">
          <div class="conn-dot off" id="gmailDot"></div>
          <div>
            <div class="conn-name">Gmail</div>
            <div class="conn-val">lesdelicesdelafrique59</div>
          </div>
        </div>
        <div class="conn-pill">
          <div class="conn-dot off" id="shopifyDot"></div>
          <div>
            <div class="conn-name">Shopify</div>
            <div class="conn-val">f588e3-2.myshopify.com</div>
          </div>
        </div>
        <div class="conn-pill">
          <div class="conn-dot off" id="tgDot"></div>
          <div>
            <div class="conn-name">Telegram</div>
            <div class="conn-val" id="tgVal">Bot SAV</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- CYCLE -->
  <div class="card fade-in">
    <div class="card-header">
      <span class="card-title">Automatisation</span>
      <span id="cycleStatus" style="font-size:12px;font-weight:700;color:var(--vert)">✓ Actif</span>
    </div>
    <div class="card-body">
      <div class="cycle-rows">
        <div class="cycle-row">
          <span class="cycle-label">Dernier cycle</span>
          <span class="cycle-val" id="lastCycleTime">—</span>
        </div>
        <div class="cycle-row">
          <span class="cycle-label">Emails traités</span>
          <span class="cycle-val" id="lastCycleEmails">—</span>
        </div>
        <div class="cycle-row" style="border:none;padding-bottom:0">
          <span class="cycle-label">Résumé ce soir</span>
          <span class="cycle-val" style="color:var(--ocre)" id="summaryPending">—</span>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill" id="cycleBar"></div>
        </div>
        <div class="progress-label" id="cycleCountdown">Prochain cycle dans —</div>
      </div>
    </div>
  </div>

  <!-- ACTIONS -->
  <div class="card fade-in">
    <div class="card-header">
      <span class="card-title">Actions</span>
    </div>
    <div class="card-body">
      <div class="btn-stack">
        <button class="btn btn-primary" id="btnCycle" onclick="launchCycle()">
          <span id="btnCycleIcon">🚀</span>
          <span id="btnCycleLabel">Lancer le cycle SAV</span>
        </button>
        <div class="btn-row">
          <button class="btn btn-terre" onclick="testTelegram()">
            📲 Test Telegram
          </button>
          <button class="btn btn-ocre" onclick="sendSummary()">
            📊 Résumé 20h
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- JOURNAL -->
  <div class="card fade-in">
    <div class="card-header">
      <span class="card-title">Journal en direct</span>
      <span class="card-action" onclick="clearLogs()">Effacer</span>
    </div>
    <div class="card-body" style="padding:12px 14px">
      <div class="log-wrap" id="logWrap">
        <div class="log-line log-info">En attente d'activité…</div>
      </div>
    </div>
  </div>

  <!-- ESCALADE -->
  <div class="card fade-in">
    <div class="card-header">
      <span class="card-title">Escalade priorités</span>
    </div>
    <div class="card-body" style="padding: 4px 18px 16px">
      <div class="escalade-list">
        <div class="escalade-item">
          <div class="esc-left">
            <div class="esc-level" style="color:var(--rouge)">🔴 URGENT</div>
            <div class="esc-types">Réclamation · Perdue · Collab/UGC</div>
          </div>
          <span class="esc-action" style="background:#fef2f2;color:var(--rouge)">⚡ Immédiat</span>
        </div>
        <div class="escalade-item">
          <div class="esc-left">
            <div class="esc-level" style="color:var(--terre)">🟠 HAUTE</div>
            <div class="esc-types">Retour · Remboursement</div>
          </div>
          <span class="esc-action" style="background:#fff7ed;color:var(--terre2)">📩 Résumé</span>
        </div>
        <div class="escalade-item">
          <div class="esc-left">
            <div class="esc-level" style="color:#b08000">🟡 NORMALE</div>
            <div class="esc-types">Suivi commande</div>
          </div>
          <span class="esc-action" style="background:var(--creme2);color:var(--muted)">🔕 Auto</span>
        </div>
        <div class="escalade-item">
          <div class="esc-left">
            <div class="esc-level" style="color:var(--vert2)">🟢 BASSE</div>
            <div class="esc-types">FAQ produit</div>
          </div>
          <span class="esc-action" style="background:#f0fdf4;color:var(--vert2)">🔕 Auto</span>
        </div>
      </div>
    </div>
  </div>


  <!-- TÂCHES À FAIRE -->
  <div class="card fade-in" id="tasksCard">
    <div class="card-header">
      <span class="card-title">
        Tâches à faire
        <span class="tasks-counter" id="tasksCounter" style="display:none">0</span>
      </span>
      <span class="card-action" onclick="refreshTasks()">↻ Actualiser</span>
    </div>
    <div class="card-body" style="padding:12px 14px">
      <div class="tasks-list" id="tasksList">
        <div class="tasks-empty"><span>✅</span>Aucune tâche en attente</div>
      </div>
    </div>
  </div>

  <!-- FOOTER -->
  <div style="text-align:center;padding:8px 0 20px;font-size:11px;color:var(--muted);font-weight:500">
    Signé par Daniel · Les Délices de l'Afrique 🌍<br>
    <span style="color:var(--border2)">Cycle auto toutes les 5 min · Résumé à 20h</span>
  </div>

</div><!-- .main -->
</div><!-- .wrap -->

<div class="toast" id="toast"></div>

<script>
const API = "https://sav-delices-afrique-production.up.railway.app";
let cycleTimer = null;
let nextCycleIn = 300;

// ── TOAST ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3200);
}

// ── LOG ────────────────────────────────────────────────────────────────────
function addLog(msg) {
  const wrap = document.getElementById("logWrap");
  const ph = wrap.querySelector(".log-info");
  if (ph && ph.textContent === "En attente d'activité…") ph.remove();
  const line = document.createElement("div");
  const cls = msg.includes("❌") ? "error"
    : msg.includes("✅") ? "success"
    : msg.includes("📧") || msg.includes("✉️") ? "gmail"
    : msg.includes("🛒") ? "shopify"
    : msg.includes("📲") || msg.includes("📸") ? "tg"
    : msg.includes("🤖") ? "ai" : "info";
  line.className = "log-line log-"+cls;
  line.textContent = msg;
  wrap.appendChild(line);
  wrap.scrollTop = wrap.scrollHeight;
}

function clearLogs() {
  document.getElementById("logWrap").innerHTML = '<div class="log-line log-info">Journal effacé ✓</div>';
}

// ── STATUS ─────────────────────────────────────────────────────────────────
async function refreshStatus() {
  try {
    const r = await fetch(API);
    const d = await r.json();

    document.getElementById("statusDot").className = "pulse-dot";
    document.getElementById("statusText").textContent = d.cycleRunning ? "Cycle en cours…" : "Agent actif 24h/24";
    document.getElementById("railwayVal").textContent = "En ligne ✓";

    // Stats avec animation
    animateNum("statTotal",   d.stats.total);
    animateNum("statReplied", d.stats.replied);
    animateNum("statUrgent",  d.stats.urgent);
    animateNum("statPartner", d.stats.partner);

    // Dots connexions
    ["gmailDot","shopifyDot","tgDot"].forEach(id => {
      const el = document.getElementById(id);
      el.className = "conn-dot off";
      setTimeout(() => el.className = "conn-dot on", 300);
    });

    if (d.lastCycle) {
      document.getElementById("lastCycleTime").textContent =
        new Date(d.lastCycle).toLocaleTimeString("fr-FR");
    }
    document.getElementById("lastCycleEmails").textContent = d.stats.total + " email(s) total";
    document.getElementById("summaryPending").textContent  = d.summaryPending + " email(s)";

    document.getElementById("cycleStatus").textContent = d.cycleRunning ? "⚙️ En cours…" : "✓ Actif";
    document.getElementById("cycleStatus").style.color = d.cycleRunning ? "var(--ocre)" : "var(--vert)";

  } catch(e) {
    document.getElementById("statusDot").className = "pulse-dot offline";
    document.getElementById("statusText").textContent = "Serveur inaccessible";
    document.getElementById("railwayVal").textContent = "Hors ligne";
  }
}

// ── ANIMATE NUMBER ─────────────────────────────────────────────────────────
function animateNum(id, target) {
  const el = document.getElementById(id);
  const start = parseInt(el.textContent) || 0;
  if (start === target) return;
  const steps = 20;
  const diff  = (target - start) / steps;
  let cur = start;
  const interval = setInterval(() => {
    cur += diff;
    el.textContent = Math.round(cur);
    if (Math.abs(cur - target) < 1) {
      el.textContent = target;
      clearInterval(interval);
    }
  }, 30);
}

// ── COUNTDOWN ──────────────────────────────────────────────────────────────
function startCountdown() {
  nextCycleIn = 300;
  clearInterval(cycleTimer);
  cycleTimer = setInterval(() => {
    nextCycleIn = Math.max(0, nextCycleIn - 1);
    const pct = ((300 - nextCycleIn) / 300 * 100).toFixed(1);
    document.getElementById("cycleBar").style.width = pct + "%";
    const m = Math.floor(nextCycleIn / 60);
    const s = nextCycleIn % 60;
    document.getElementById("cycleCountdown").textContent =
      \`Prochain cycle dans \${m}:\${String(s).padStart(2,"0")}\`;
    if (nextCycleIn === 0) { refreshStatus(); nextCycleIn = 300; }
  }, 1000);
}

// ── LAUNCH CYCLE ───────────────────────────────────────────────────────────
async function launchCycle() {
  const btn   = document.getElementById("btnCycle");
  const icon  = document.getElementById("btnCycleIcon");
  const label = document.getElementById("btnCycleLabel");

  // Ripple visuel
  btn.style.transform = "scale(.96)";
  setTimeout(() => btn.style.transform = "", 120);

  btn.disabled = true;
  icon.className = "spin"; icon.textContent = "⚙️";
  label.textContent = "Cycle en cours…";
  addLog("🚀 Cycle lancé — " + new Date().toLocaleTimeString("fr-FR"));

  try {
    const r = await fetch(API + "/cycle", { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      addLog("✅ Cycle démarré sur Railway !");
      showToast("🚀 Cycle SAV lancé avec succès !");
      startCountdown();
      setTimeout(refreshStatus, 4000);
    } else {
      addLog("⚠️ " + d.message);
      showToast("⚠️ " + d.message);
    }
  } catch(e) {
    addLog("❌ Erreur : " + e.message);
    showToast("❌ Impossible de contacter Railway");
  }

  setTimeout(() => {
    btn.disabled = false;
    icon.className = ""; icon.textContent = "🚀";
    label.textContent = "Lancer le cycle SAV";
  }, 6000);
}

// ── TEST TELEGRAM ──────────────────────────────────────────────────────────
async function testTelegram() {
  addLog("📲 Test Telegram…");
  showToast("📲 Envoi du message test…");
  try {
    const r = await fetch(API + "/test-telegram", { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      addLog("✅ Telegram fonctionne ! Vérifie ton téléphone 📱");
      showToast("✅ Message Telegram envoyé !");
      document.getElementById("tgDot").className = "conn-dot on";
      document.getElementById("tgVal").textContent = "Connecté ✓";
    } else {
      addLog("❌ Telegram : " + (d.description || d.error));
      showToast("❌ Telegram échoué");
    }
  } catch(e) { addLog("❌ " + e.message); }
}

// ── SEND SUMMARY ──────────────────────────────────────────────────────────
async function sendSummary() {
  addLog("📊 Envoi du résumé quotidien…");
  try {
    const r = await fetch(API + "/summary", { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      addLog("✅ Résumé envoyé sur Telegram !");
      showToast("📊 Résumé quotidien envoyé !");
      refreshStatus();
    }
  } catch(e) { addLog("❌ " + e.message); }
}


// ── TASKS ──────────────────────────────────────────────────────────────────
async function refreshTasks() {
  try {
    const r = await fetch(API + "/tasks");
    const d = await r.json();
    renderTasks(d.tasks || []);
  } catch(e) { console.error("Tasks error:", e); }
}

function renderTasks(tasks) {
  const list    = document.getElementById("tasksList");
  const counter = document.getElementById("tasksCounter");
  const pending = tasks.filter(t => !t.done);

  // Update counter
  if (pending.length > 0) {
    counter.textContent = pending.length;
    counter.style.display = "inline-flex";
  } else {
    counter.style.display = "none";
  }

  if (tasks.length === 0) {
    list.innerHTML = '<div class="tasks-empty"><span>✅</span>Aucune tâche en attente</div>';
    return;
  }

  list.innerHTML = "";
  // Sort: undone first, then by date
  const sorted = [...tasks].sort((a,b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  sorted.forEach(task => {
    const div = document.createElement("div");
    div.className = "task-item" + (task.done ? " done" : "");
    div.innerHTML = \`
      <div class="task-check \${task.done ? "checked" : ""}" onclick="toggleTask(\${task.id}, \${task.done})">
        \${task.done ? "✓" : ""}
      </div>
      <div class="task-content">
        <div class="task-header">
          <span class="task-title">\${task.title}</span>
          <span class="task-badge badge-\${task.type}">\${getBadgeLabel(task.type)}</span>
        </div>
        \${task.clientName ? \`<div class="task-client">👤 \${task.clientName} · \${task.email||""}</div>\` : ""}
        \${task.summary ? \`<div class="task-summary">\${task.summary}</div>\` : ""}
        \${task.doneAt ? \`<div class="task-summary" style="color:var(--vert)">✓ Traité le \${new Date(task.doneAt).toLocaleDateString("fr-FR")}</div>\` : ""}
      </div>
      <button class="task-delete" onclick="deleteTask(\${task.id})" title="Supprimer">×</button>
    \`;
    list.appendChild(div);
  });
}

function getBadgeLabel(type) {
  const labels = {
    remboursement: "💸 Remboursement",
    retour:        "↩️ Retour",
    partenariat:   "🤝 Partenariat",
    reclamation:   "🔴 Réclamation",
  };
  return labels[type] || type;
}

async function toggleTask(id, isDone) {
  if (isDone) return; // Can't uncheck
  try {
    await fetch(API + "/tasks/done/" + id, { method: "POST" });
    showToast("✅ Tâche marquée comme faite !");
    refreshTasks();
  } catch(e) { console.error(e); }
}

async function deleteTask(id) {
  try {
    await fetch(API + "/tasks/" + id, { method: "DELETE" });
    refreshTasks();
  } catch(e) { console.error(e); }
}

// Refresh tasks every 30 seconds
setInterval(refreshTasks, 30000);
refreshTasks();

// ── INIT ───────────────────────────────────────────────────────────────────
refreshStatus();
startCountdown();
setInterval(refreshStatus, 30000);
</script>
</body>
</html>
`;
    if (nextCycleIn === 0) { refreshStatus(); nextCycleIn = 300; }
  }, 1000);
}

// ── LAUNCH CYCLE ───────────────────────────────────────────────────────────
async function launchCycle() {
  const btn   = document.getElementById("btnCycle");
  const icon  = document.getElementById("btnCycleIcon");
  const label = document.getElementById("btnCycleLabel");

  // Ripple visuel
  btn.style.transform = "scale(.96)";
  setTimeout(() => btn.style.transform = "", 120);

  btn.disabled = true;
  icon.className = "spin"; icon.textContent = "⚙️";
  label.textContent = "Cycle en cours…";
  addLog("🚀 Cycle lancé — " + new Date().toLocaleTimeString("fr-FR"));

  try {
    const r = await fetch(API + "/cycle", { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      addLog("✅ Cycle démarré sur Railway !");
      showToast("🚀 Cycle SAV lancé avec succès !");
      startCountdown();
      setTimeout(refreshStatus, 4000);
    } else {
      addLog("⚠️ " + d.message);
      showToast("⚠️ " + d.message);
    }
  } catch(e) {
    addLog("❌ Erreur : " + e.message);
    showToast("❌ Impossible de contacter Railway");
  }

  setTimeout(() => {
    btn.disabled = false;
    icon.className = ""; icon.textContent = "🚀";
    label.textContent = "Lancer le cycle SAV";
  }, 6000);
}

// ── TEST TELEGRAM ──────────────────────────────────────────────────────────
async function testTelegram() {
  addLog("📲 Test Telegram…");
  showToast("📲 Envoi du message test…");
  try {
    const r = await fetch(API + "/test-telegram", { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      addLog("✅ Telegram fonctionne ! Vérifie ton téléphone 📱");
      showToast("✅ Message Telegram envoyé !");
      document.getElementById("tgDot").className = "conn-dot on";
      document.getElementById("tgVal").textContent = "Connecté ✓";
    } else {
      addLog("❌ Telegram : " + (d.description || d.error));
      showToast("❌ Telegram échoué");
    }
  } catch(e) { addLog("❌ " + e.message); }
}

// ── SEND SUMMARY ──────────────────────────────────────────────────────────
async function sendSummary() {
  addLog("📊 Envoi du résumé quotidien…");
  try {
    const r = await fetch(API + "/summary", { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      addLog("✅ Résumé envoyé sur Telegram !");
      showToast("📊 Résumé quotidien envoyé !");
      refreshStatus();
    }
  } catch(e) { addLog("❌ " + e.message); }
}

// ── INIT ───────────────────────────────────────────────────────────────────
refreshStatus();
startCountdown();
setInterval(refreshStatus, 30000);
</script>
</body>
</html>
`;

app.get("/dashboard", (req,res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
});

app.get("/", (req,res) => {
  // If browser request, serve dashboard
  const accept = req.headers.accept || "";
  if (accept.includes("text/html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(DASHBOARD_HTML);
    return;
  }
  // Otherwise serve JSON status
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
