let currentPageText = "";
let currentPageType = "";
let currentPageLabel = "";
let pageLoaded = false;
let activeChatTool = "normal";
let isGenerating = false;

const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";
const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;

const userLanguage = navigator.language || "en";
const DAILY_LIMIT = 5;
const PRO_LINK = "https://buy.stripe.com/4gMbJ38OycALbkD3ZD3ks02";

const CHAT_CONVERSATIONS_KEY = "instant_answer_chat_conversations";
const ACTIVE_CHAT_ID_KEY = "instant_answer_active_chat_id";

let chatConversations = JSON.parse(localStorage.getItem(CHAT_CONVERSATIONS_KEY) || "[]");
let activeChatId = localStorage.getItem(ACTIVE_CHAT_ID_KEY);

function createConversation(title = "New chat") {
  return {
    id: crypto.randomUUID(),
    title,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function saveConversations() {
  localStorage.setItem(CHAT_CONVERSATIONS_KEY, JSON.stringify(chatConversations.slice(0, 30)));
  localStorage.setItem(ACTIVE_CHAT_ID_KEY, activeChatId);
}

function getActiveConversation() {
  let conversation = chatConversations.find(chat => chat.id === activeChatId);

  if (!conversation) {
    conversation = createConversation();
    chatConversations.unshift(conversation);
    activeChatId = conversation.id;
    saveConversations();
  }

  return conversation;
}

function generateChatTitle(message = "") {
  const clean = message.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 34 ? `${clean.slice(0, 34)}...` : clean;
}

if (chatConversations.length === 0) {
  const oldMessages = JSON.parse(localStorage.getItem("instant_answer_chat_messages") || "[]");
  const firstConversation = createConversation(
    oldMessages.length > 0 ? generateChatTitle(oldMessages[0]?.content || "Old chat") : "New chat"
  );

  firstConversation.messages = oldMessages;
  chatConversations.unshift(firstConversation);
  activeChatId = firstConversation.id;
  saveConversations();
}

let chatMessages = getActiveConversation().messages || [];

function saveChatMessages() {
  const conversation = getActiveConversation();

  conversation.messages = chatMessages
    .filter(msg => msg.role !== "loading")
    .slice(-40);

  conversation.updatedAt = new Date().toISOString();

  const firstUserMessage = conversation.messages.find(msg => msg.role === "user");

  if (firstUserMessage) {
    conversation.title = generateChatTitle(firstUserMessage.content);
  }

  chatConversations = chatConversations
    .map(chat => chat.id === conversation.id ? conversation : chat)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  saveConversations();
}

function startNewChat() {
  const conversation = createConversation();
  chatConversations.unshift(conversation);
  activeChatId = conversation.id;
  chatMessages = [];
  saveConversations();
}

function openOldChat(id) {
  activeChatId = id;
  chatMessages = getActiveConversation().messages || [];
  saveConversations();
}

function deleteChat(id) {
  chatConversations = chatConversations.filter(chat => chat.id !== id);

  if (chatConversations.length === 0) {
    const conversation = createConversation();
    chatConversations.unshift(conversation);
    activeChatId = conversation.id;
  } else if (activeChatId === id) {
    activeChatId = chatConversations[0].id;
  }

  chatMessages = getActiveConversation().messages || [];
  saveConversations();
}

function clearChatMessages() {
  const conversation = getActiveConversation();
  conversation.messages = [];
  conversation.title = "New chat";
  conversation.updatedAt = new Date().toISOString();
  chatMessages = [];

  chatConversations = chatConversations.map(chat =>
    chat.id === conversation.id ? conversation : chat
  );

  saveConversations();
}

function escapeHTML(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(text = "", limit = 16000) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function containsMath(text = "") {
  const value = String(text || "").toLowerCase();

  const mathWords = [
    "ligning", "funktion", "graf", "formel", "beregn", "udregn",
    "afledte", "differential", "integral", "procent", "sandsynlighed",
    "statistik", "trigonometri", "solve", "equation", "graph",
    "formula", "calculate", "derivative", "integral", "latex"
  ];

  return mathWords.some(word => value.includes(word)) || /[=+\-*/^√π∫Σ]/.test(value);
}

function formatMathExpression(expr = "") {
  return escapeHTML(expr)
    .replace(/\^2/g, "²")
    .replace(/\^3/g, "³")
    .replace(/sqrt\((.*?)\)/gi, "√($1)")
    .replace(/\\frac\{(.*?)\}\{(.*?)\}/g, "($1)/($2)");
}

function extractGraphExpression(text = "") {
  const match = text.match(/GRAPH:\s*([\s\S]*?)(?:\n\n|$)/i);
  if (!match?.[1]) return "";

  return match[1]
    .split("\n")[0]
    .replace(/`/g, "")
    .trim();
}

function createGraphUrl(expression = "") {
  if (!expression) return "";

  const clean = expression
    .replace(/^y\s*=/i, "")
    .replace(/^f\(x\)\s*=/i, "")
    .trim();

  if (!clean) return "";

  const encoded = encodeURIComponent(`y=${clean}`);
  return `https://www.desmos.com/calculator?expression=${encoded}`;
}

function formatAnswer(text = "") {
  let safe = escapeHTML(text);

  safe = safe.replace(/```([\s\S]*?)```/g, (_, code) => {
    return `
      <div class="math-code-block">
        <button class="copyFormulaBtn" data-formula="${escapeHTML(code.trim())}">Copy</button>
        <pre>${escapeHTML(code.trim())}</pre>
      </div>
    `;
  });

  safe = safe.replace(/\\\[(.*?)\\\]/gs, (_, formula) => {
    return `<div class="math-formula-block">${formatMathExpression(formula)}</div>`;
  });

  safe = safe.replace(/\\\((.*?)\\\)/gs, (_, formula) => {
    return `<span class="math-inline">${formatMathExpression(formula)}</span>`;
  });

  safe = safe.replace(/\n/g, "<br>");

  return safe;
}

function getLastAssistantAnswer() {
  return [...chatMessages].reverse().find(msg => msg.role === "assistant");
}

function getLastUserMessage() {
  return [...chatMessages].reverse().find(msg => msg.role === "user");
}

function getDownloadPDFLabel() {
  if (userLanguage.startsWith("da")) return "Download PDF";
  if (userLanguage.startsWith("tr")) return "PDF indir";
  if (userLanguage.startsWith("de")) return "PDF herunterladen";
  if (userLanguage.startsWith("fr")) return "Télécharger PDF";
  if (userLanguage.startsWith("es")) return "Descargar PDF";
  return "Download PDF";
}

function getThinkingLabel() {
  if (userLanguage.startsWith("da")) return "AI tænker";
  if (userLanguage.startsWith("tr")) return "AI düşünüyor";
  if (userLanguage.startsWith("de")) return "AI denkt nach";
  if (userLanguage.startsWith("fr")) return "L’IA réfléchit";
  if (userLanguage.startsWith("es")) return "La IA está pensando";
  return "AI is thinking";
}

function getClearChatLabel() {
  if (userLanguage.startsWith("da")) return "Ryd chat";
  if (userLanguage.startsWith("tr")) return "Sohbeti temizle";
  if (userLanguage.startsWith("de")) return "Chat löschen";
  if (userLanguage.startsWith("fr")) return "Effacer le chat";
  if (userLanguage.startsWith("es")) return "Borrar chat";
  return "Clear Chat";
}

function getSendLabel() {
  if (userLanguage.startsWith("da")) return "Send";
  if (userLanguage.startsWith("tr")) return "Gönder";
  if (userLanguage.startsWith("de")) return "Senden";
  if (userLanguage.startsWith("fr")) return "Envoyer";
  if (userLanguage.startsWith("es")) return "Enviar";
  return "Send";
}

function getTeacherLabel() {
  if (userLanguage.startsWith("da")) return "Forklar som lærer";
  return "Explain like teacher";
}

function getSmartCalcLabel() {
  if (userLanguage.startsWith("da")) return "Smart beregning";
  return "Smart calculation";
}

function getGraphLabel() {
  if (userLanguage.startsWith("da")) return "Åbn graf";
  return "Open graph";
}

function getLanguageInstruction() {
  if (userLanguage.startsWith("da")) return "Answer in Danish.";
  if (userLanguage.startsWith("tr")) return "Answer in Turkish.";
  if (userLanguage.startsWith("de")) return "Answer in German.";
  if (userLanguage.startsWith("fr")) return "Answer in French.";
  if (userLanguage.startsWith("es")) return "Answer in Spanish.";
  return "Answer in English.";
}

function getChatPlaceholder() {
  if (activeChatTool === "assignment") return userLanguage.startsWith("da") ? "Indsæt din opgave her..." : "Paste your assignment here...";
  if (activeChatTool === "improve") return userLanguage.startsWith("da") ? "Indsæt din tekst her..." : "Paste your text here...";
  if (activeChatTool === "feedback") return userLanguage.startsWith("da") ? "Indsæt din tekst og få feedback..." : "Paste your text and get feedback...";
  if (activeChatTool === "math") return userLanguage.startsWith("da") ? "Indsæt ligning, funktion eller matematikopgave her..." : "Paste equation, function or math problem here...";
  if (activeChatTool === "analyze") return userLanguage.startsWith("da") ? "Spørg om siden, teksten, videoen eller artiklen..." : "Ask about the page, text, video or article...";
  return userLanguage.startsWith("da") ? "Skriv dit spørgsmål..." : "Ask anything...";
}

function getDeviceId() {
  let deviceId = localStorage.getItem("instant_answer_device_id");

  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("instant_answer_device_id", deviceId);
  }

  return deviceId;
}

function isProUser() {
  return localStorage.getItem("instant_answer_pro") === "true";
}

function setProUser(value) {
  localStorage.setItem("instant_answer_pro", value ? "true" : "false");
}

function getTodayKey() {
  const today = new Date().toISOString().split("T")[0];
  return `instant_answer_usage_${today}`;
}

function getUsage() {
  return parseInt(localStorage.getItem(getTodayKey())) || 0;
}

function increaseUsage() {
  if (!isProUser()) {
    localStorage.setItem(getTodayKey(), getUsage() + 1);
  }
}

function getRemainingUsage() {
  if (isProUser()) return "∞";
  return Math.max(DAILY_LIMIT - getUsage(), 0);
}

function hasReachedLimit() {
  if (isProUser()) return false;
  return getUsage() >= DAILY_LIMIT;
}

function saveHistory(mode, question, answer) {
  const history = JSON.parse(localStorage.getItem("instant_answer_history") || "[]");

  history.unshift({
    mode,
    question: question.slice(0, 300),
    answer: answer.slice(0, 1200),
    date: new Date().toISOString()
  });

  localStorage.setItem("instant_answer_history", JSON.stringify(history.slice(0, 20)));
}

function copyLastAnswer() {
  const lastAnswer = getLastAssistantAnswer();

  if (!lastAnswer) {
    alert("No AI answer found yet.");
    return;
  }

  navigator.clipboard.writeText(lastAnswer.content);
}

function downloadLastAnswerAsPDF() {
  const lastAnswer = getLastAssistantAnswer();

  if (!lastAnswer) {
    alert("No AI answer found yet.");
    return;
  }

  const conversation = getActiveConversation();
  const date = new Date().toLocaleString();
  const cleanTextForPdf = formatAnswer(lastAnswer.content);
  const printWindow = window.open("", "_blank");

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Instant Answer PDF</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 44px; line-height: 1.65; color: #111; background: white; }
          .top { border-bottom: 1px solid #ddd; padding-bottom: 18px; margin-bottom: 24px; }
          h1 { font-size: 26px; margin: 0 0 8px 0; }
          .meta { font-size: 12px; color: #666; line-height: 1.6; }
          .content { font-size: 14px; white-space: normal; }
          .math-formula-block { background:#f7f7f7;border:1px solid #ddd;border-radius:10px;padding:10px;margin:10px 0;font-weight:bold; }
          .footer { border-top: 1px solid #ddd; margin-top: 40px; padding-top: 16px; font-size: 11px; color: #777; }
          @media print { button { display: none; } }
        </style>
      </head>
      <body>
        <div class="top">
          <h1>Instant Answer</h1>
          <div class="meta">
            Chat: ${escapeHTML(conversation.title || "New chat")}<br>
            Tool: ${escapeHTML(activeChatTool)}<br>
            Date: ${escapeHTML(date)}
          </div>
        </div>
        <div class="content">${cleanTextForPdf}</div>
        <div class="footer">Generated with Instant Answer</div>
        <script>window.onload = function() { window.print(); };</script>
      </body>
    </html>
  `);

  printWindow.document.close();
}

document.addEventListener("DOMContentLoaded", async () => {
  const videoTitleElement = document.getElementById("videoTitle");
  const quickBtn = document.getElementById("quickBtn");
  const deepBtn = document.getElementById("deepBtn");
  const studyBtn = document.getElementById("studyBtn");
  const chatBtn = document.getElementById("chatBtn");
  const result = document.getElementById("result");
  const proStatus = document.getElementById("proStatus");
  const historyBtn = document.getElementById("historyBtn");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");

  const deviceId = getDeviceId();
  const languageInstruction = getLanguageInstruction();

  function setButtonsDisabled(value) {
    [quickBtn, deepBtn, studyBtn, chatBtn].forEach(btn => {
      if (btn) btn.disabled = value;
    });
  }

  async function checkProStatus() {
    try {
      const response = await fetch(CHECK_PRO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId })
      });

      const data = await response.json();

      if (data.pro) setProUser(true);
    } catch (error) {
      console.error("Pro check failed", error);
    }
  }

  function updateProStatus() {
    proStatus.textContent = isProUser()
      ? "Pro plan active"
      : `Free plan · ${getRemainingUsage()}/${DAILY_LIMIT}`;
  }

  function updatePageLabel() {
    videoTitleElement.textContent = isProUser()
      ? `${currentPageLabel} · Pro`
      : `${currentPageLabel} · Free ${getRemainingUsage()}`;
  }

  function showProBox() {
    result.innerHTML = `
      <div class="pro-box">
        <div class="pro-label">LIMIT REACHED</div>
        <div class="pro-title">Upgrade to Pro</div>
        <div class="pro-text">You have used your 5 free answers today.</div>
        <div class="pro-features">
          Unlimited answers<br>
          Better summaries<br>
          Faster responses<br>
          Study mode access<br>
          AI chat access<br>
          Advanced math help
        </div>
        <button class="upgrade-btn" id="upgradeBtn">Upgrade to Pro</button>
      </div>
    `;

    document.getElementById("upgradeBtn").onclick = () => {
      window.open(`${PRO_LINK}?client_reference_id=${deviceId}`, "_blank");
    };
  }

  function getToolButtonStyle(tool) {
    const active = activeChatTool === tool;

    return `
      flex: 1;
      padding: 8px 6px;
      border: ${active ? "1px solid #111" : "1px solid #ddd"};
      border-radius: 10px;
      background: ${active ? "#111" : "#f7f7f7"};
      color: ${active ? "white" : "#333"};
      font-weight: bold;
      cursor: pointer;
      font-size: 11px;
    `;
  }

  function renderSources(sources = []) {
    if (!Array.isArray(sources) || sources.length === 0) return "";

    return `
      <div style="margin-top:8px;padding:8px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;">
        <div style="font-size:11px;font-weight:900;color:#555;margin-bottom:5px;">Sources</div>
        ${sources.slice(0, 4).map(source => `
          <div style="font-size:11px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${source.url
              ? `<a href="${escapeHTML(source.url)}" target="_blank" style="color:#111;text-decoration:underline;">${escapeHTML(source.title || source.url)}</a>`
              : `${escapeHTML(source.title || "Source")}`
            }
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderMathActions(message) {
    if (!message || message.role !== "assistant") return "";

    const isMath = message.mathMode || containsMath(message.content || "");
    if (!isMath) return "";

    const graphExpression = extractGraphExpression(message.content || "");
    const graphUrl = createGraphUrl(graphExpression);

    return `
      <div class="math-action-row">
        <button class="teacherExplainBtn">${getTeacherLabel()}</button>
        <button class="smartCalcBtn">${getSmartCalcLabel()}</button>
        ${graphUrl ? `<button class="openGraphBtn" data-url="${escapeHTML(graphUrl)}">${getGraphLabel()}</button>` : ""}
      </div>
    `;
  }

  function renderConversationList() {
    if (chatConversations.length === 0) {
      return `<div style="font-size:12px;color:#777;">No chats yet.</div>`;
    }

    return chatConversations.slice(0, 8).map(chat => {
      const active = chat.id === activeChatId;

      return `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <button class="oldChatBtn" data-id="${chat.id}" style="
            flex:1;text-align:left;padding:8px 10px;border-radius:10px;
            border:${active ? "1px solid #111" : "1px solid #ddd"};
            background:${active ? "#111" : "#f7f7f7"};
            color:${active ? "white" : "#222"};
            font-size:12px;font-weight:700;cursor:pointer;
            overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
          ">${escapeHTML(chat.title || "New chat")}</button>

          <button class="deleteChatBtn" data-id="${chat.id}" style="
            width:34px;height:34px;border-radius:10px;border:1px solid #ddd;
            background:#fff;color:#555;cursor:pointer;font-weight:900;
          ">×</button>
        </div>
      `;
    }).join("");
  }

  function renderChatMessages() {
    if (chatMessages.length === 0) {
      return `<div style="color:#777;">${escapeHTML(getChatPlaceholder())}</div>`;
    }

    return chatMessages.map((message, index) => {
      if (message.role === "loading") {
        return `
          <div style="text-align:left;margin-bottom:8px;">
            <div style="
              display:inline-block;max-width:85%;background:#f1f1f1;color:#111;
              padding:9px 11px;border-radius:12px;text-align:left;
            ">
              ${escapeHTML(getThinkingLabel())}
              <span class="typingDots">
                <span>.</span><span>.</span><span>.</span>
              </span>
            </div>
          </div>
        `;
      }

      const align = message.role === "user" ? "right" : "left";
      const bg = message.role === "user" ? "#111" : "#f1f1f1";
      const color = message.role === "user" ? "white" : "#111";

      return `
        <div style="text-align:${align}; margin-bottom:8px;">
          <div style="
            display:inline-block;max-width:85%;background:${bg};color:${color};
            padding:8px 10px;border-radius:12px;text-align:left;
          ">
            ${formatAnswer(message.content)}
            ${message.role === "assistant" ? renderSources(message.sources) : ""}
            ${message.role === "assistant" ? renderMathActions(message) : ""}
          </div>

          ${message.role === "assistant" ? `
            <div style="margin-top:4px;text-align:left;">
              <button class="copySingleBtn" data-index="${index}" style="
                border:none;background:#f7f7f7;color:#555;font-size:11px;
                cursor:pointer;border-radius:8px;padding:4px 8px;
              ">Copy</button>
            </div>
          ` : ""}
        </div>
      `;
    }).join("");
  }

  function openChat() {
    const activeConversation = getActiveConversation();

    result.innerHTML = `
      <style>
        .typingDots span {
          animation: blink 1.2s infinite;
          font-weight: 900;
        }
        .typingDots span:nth-child(2) { animation-delay: .2s; }
        .typingDots span:nth-child(3) { animation-delay: .4s; }
        @keyframes blink {
          0%, 20% { opacity: .2; }
          50% { opacity: 1; }
          100% { opacity: .2; }
        }
        .math-formula-block {
          background: #fff;
          border: 1px solid #ddd;
          border-radius: 12px;
          padding: 10px;
          margin: 8px 0;
          font-weight: 900;
          overflow-x: auto;
        }
        .math-inline {
          background: rgba(255,255,255,.8);
          border: 1px solid #ddd;
          border-radius: 6px;
          padding: 1px 5px;
          font-weight: 800;
        }
        .math-code-block {
          background: #fff;
          border: 1px solid #ddd;
          border-radius: 12px;
          padding: 8px;
          margin: 8px 0;
          position: relative;
        }
        .math-code-block pre {
          margin: 0;
          white-space: pre-wrap;
          font-size: 12px;
        }
        .copyFormulaBtn {
          position: absolute;
          top: 6px;
          right: 6px;
          border: none;
          background: #111;
          color: white;
          border-radius: 8px;
          padding: 3px 7px;
          font-size: 10px;
          cursor: pointer;
        }
        .math-action-row {
          display: grid;
          grid-template-columns: 1fr;
          gap: 6px;
          margin-top: 8px;
        }
        .math-action-row button {
          border: 1px solid #ddd;
          background: white;
          color: #111;
          border-radius: 10px;
          padding: 7px;
          font-size: 11px;
          font-weight: 900;
          cursor: pointer;
        }
      </style>

      <div class="answer-box">
        <div class="answer-label">CHAT</div>
        <div class="answer-title">Instant Answer Chat</div>

        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button id="newChatBtn" style="flex:1;padding:10px;border:none;border-radius:12px;background:#111;color:white;font-weight:900;cursor:pointer;">+ New Chat</button>
          <button id="toggleOldChatsBtn" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:12px;background:#f7f7f7;color:#111;font-weight:900;cursor:pointer;">Old Chats</button>
        </div>

        <div id="oldChatsBox" style="display:none;margin-bottom:12px;padding:10px;border:1px solid #eee;border-radius:14px;background:#fafafa;max-height:180px;overflow-y:auto;">
          ${renderConversationList()}
        </div>

        <div style="font-size:12px;color:#777;margin-bottom:8px;background:#f7f7f7;border:1px solid #eee;border-radius:12px;padding:8px 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">
          Current chat: ${escapeHTML(activeConversation.title || "New chat")}
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:10px;">
          <button id="assignmentBtn" style="${getToolButtonStyle("assignment")}">Assignment</button>
          <button id="improveBtn" style="${getToolButtonStyle("improve")}">Improve</button>
          <button id="feedbackBtn" style="${getToolButtonStyle("feedback")}">Feedback</button>
          <button id="mathBtn" style="${getToolButtonStyle("math")}">Math</button>
          <button id="analyzeBtn" style="${getToolButtonStyle("analyze")}">Analyze page</button>
          <button id="normalBtn" style="${getToolButtonStyle("normal")}">Normal</button>
        </div>

        <div id="chatMessages" style="max-height:260px;overflow-y:auto;margin-bottom:10px;font-size:13px;line-height:1.45;">
          ${renderChatMessages()}
        </div>

        <textarea id="chatInput" placeholder="${escapeHTML(getChatPlaceholder())}" style="width:100%;height:90px;resize:none;box-sizing:border-box;border:1px solid #ddd;border-radius:12px;padding:10px;font-family:Arial,sans-serif;font-size:13px;outline:none;"></textarea>

        <button id="sendChatBtn" style="width:100%;margin-top:8px;padding:11px;border:none;border-radius:12px;background:linear-gradient(135deg,#000,#333);color:white;font-weight:bold;cursor:pointer;">
          ${isGenerating ? getThinkingLabel() + "..." : getSendLabel()}
        </button>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
          <button id="copyLastBtn" style="padding:10px;border:1px solid #ddd;border-radius:12px;background:#f7f7f7;color:#111;font-weight:bold;cursor:pointer;">Copy</button>
          <button id="regenerateBtn" style="padding:10px;border:1px solid #ddd;border-radius:12px;background:#f7f7f7;color:#111;font-weight:bold;cursor:pointer;">Regenerate</button>
        </div>

        <button id="downloadPdfBtn" style="width:100%;margin-top:8px;padding:10px;border:none;border-radius:12px;background:#111;color:white;font-weight:bold;cursor:pointer;">${getDownloadPDFLabel()}</button>

        <button id="clearChatBtn" style="width:100%;margin-top:8px;padding:10px;border:1px solid #ddd;border-radius:12px;background:#f7f7f7;color:#333;font-weight:bold;cursor:pointer;">${getClearChatLabel()}</button>
      </div>
    `;

    document.getElementById("newChatBtn").onclick = () => {
      startNewChat();
      openChat();
    };

    document.getElementById("toggleOldChatsBtn").onclick = () => {
      const box = document.getElementById("oldChatsBox");
      box.style.display = box.style.display === "none" ? "block" : "none";
    };

    document.querySelectorAll(".oldChatBtn").forEach(btn => {
      btn.onclick = () => {
        openOldChat(btn.dataset.id);
        openChat();
      };
    });

    document.querySelectorAll(".deleteChatBtn").forEach(btn => {
      btn.onclick = () => {
        deleteChat(btn.dataset.id);
        openChat();
      };
    });

    document.querySelectorAll(".copySingleBtn").forEach(btn => {
      btn.onclick = () => {
        const msg = chatMessages[Number(btn.dataset.index)];
        if (msg?.content) navigator.clipboard.writeText(msg.content);
      };
    });

    document.querySelectorAll(".copyFormulaBtn").forEach(btn => {
      btn.onclick = () => {
        navigator.clipboard.writeText(btn.dataset.formula || "");
      };
    });

    document.querySelectorAll(".openGraphBtn").forEach(btn => {
      btn.onclick = () => {
        window.open(btn.dataset.url, "_blank");
      };
    });

    document.querySelectorAll(".teacherExplainBtn").forEach(btn => {
      btn.onclick = () => {
        const lastUser = getLastUserMessage();
        if (lastUser) {
          askBackend(`Forklar denne matematikopgave som en lærer, meget simpelt og trin-for-trin: ${lastUser.content}`, true);
        }
      };
    });

    document.querySelectorAll(".smartCalcBtn").forEach(btn => {
      btn.onclick = () => {
        const lastUser = getLastUserMessage();
        if (lastUser) {
          askBackend(`Lav smart beregning og valider resultatet. Vis kun den mest præcise løsning trin-for-trin: ${lastUser.content}`, true);
        }
      };
    });

    ["assignment", "improve", "feedback", "math", "analyze", "normal"].forEach(tool => {
      const btn = document.getElementById(`${tool}Btn`);
      if (btn) {
        btn.onclick = () => {
          activeChatTool = tool;
          openChat();
        };
      }
    });

    document.getElementById("sendChatBtn").onclick = () => sendChatMessage();
    document.getElementById("copyLastBtn").onclick = copyLastAnswer;
    document.getElementById("regenerateBtn").onclick = regenerateLastAnswer;
    document.getElementById("downloadPdfBtn").onclick = downloadLastAnswerAsPDF;

    document.getElementById("clearChatBtn").onclick = () => {
      clearChatMessages();
      openChat();
    };

    const chatInput = document.getElementById("chatInput");

    chatInput.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
      }
    });

    const chatMessagesBox = document.getElementById("chatMessages");
    chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
  }

  function getToolPrompt(tool) {
    if (tool === "assignment") {
      return `
Special mode: Assignment helper.
Give structure, explanation, examples and a strong draft if needed.
If math appears, solve step-by-step and use formulas.
`;
    }

    if (tool === "improve") {
      return `
Special mode: Improve text.
Rewrite better, correct mistakes, keep meaning and explain improvements shortly.
`;
    }

    if (tool === "feedback") {
      return `
Special mode: Teacher feedback.
Explain strengths, weaknesses, improvements and give concrete examples.
`;
    }

    if (tool === "math") {
      return `
Special mode: Expert math tutor.

You must:
- Solve step-by-step.
- Explain like a teacher.
- Use LaTeX formulas with \\( ... \\) or \\[ ... \\].
- Identify given values and what must be found.
- For word problems use: Given, Find, Formula, Calculation, Answer.
- For equations show each algebra step.
- For functions explain graph, zero points, slope, vertex and intersections.
- If graph is useful, end with:
GRAPH:
y = expression
`;
    }

    if (tool === "analyze") {
      return `
Special mode: Analyze page.
Use page context. Analyze YouTube, Google, Reddit, articles, essays, novels and webpages.
If math appears on the page, solve it step-by-step.
`;
    }

    return `
Special mode: Normal chat.
Answer clearly and helpfully.
If math appears, solve step-by-step with formulas.
`;
  }

  async function buildChatInput(userMessage) {
    const chatContext = chatMessages
      .filter(msg => msg.role !== "loading")
      .slice(-10)
      .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join("\n");

    return `
You are Instant Answer Chat.

Language rule:
${languageInstruction}

Current browser page context:
Page type: ${currentPageType || "unknown"}
Page label: ${currentPageLabel || "unknown"}

Page content:
${cleanText(currentPageText || "No page context available.", 14000)}

Selected tool:
${activeChatTool}

Tool instructions:
${getToolPrompt(activeChatTool)}

Chat so far:
${cleanText(chatContext, 8000)}

User's latest message:
${userMessage}

Rules:
- Answer exactly what the user asks.
- Do the task, not just explain what to do.
- If it is math, solve step-by-step with formulas.
- If it is an equation, show each algebra step.
- If it is a word problem, identify given values, formula, calculation and final answer.
- If graph is useful, include:
GRAPH:
y = expression
- If it is school work, give structure and useful wording.
- If the user asks about the current page, use the page context.
- Keep it clear, useful and human.
`;
  }

  async function askBackend(userMessage, addUserMessage = true) {
    if (isGenerating) return;

    isGenerating = true;

    await checkProStatus();
    updateProStatus();

    if (hasReachedLimit()) {
      isGenerating = false;
      showProBox();
      return;
    }

    if (addUserMessage) {
      chatMessages.push({ role: "user", content: userMessage });
    }

    chatMessages.push({ role: "loading", content: getThinkingLabel() });

    saveChatMessages();
    openChat();

    try {
      const input = await buildChatInput(userMessage);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);

      const response = await fetch(ASK_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          mode: activeChatTool === "normal" ? "chat" : activeChatTool,
          deviceId
        })
      });

      clearTimeout(timeout);

      const data = await response.json();

      chatMessages = chatMessages.filter(msg => msg.role !== "loading");

      if (!response.ok || !data.answer) {
        chatMessages.push({
          role: "assistant",
          content: data.answer || "Kunne ikke få et AI-svar lige nu. Prøv igen."
        });

        saveChatMessages();
        return;
      }

      if (data.pro) setProUser(true);

      chatMessages.push({
        role: "assistant",
        content: data.answer,
        sources: data.sources || [],
        mathMode: data.mathMode || false,
        usedWolfram: data.usedWolfram || false
      });

      saveChatMessages();
      saveHistory(activeChatTool, userMessage, data.answer);
      increaseUsage();
      updateProStatus();
      updatePageLabel();

    } catch (error) {
      console.error(error);

      chatMessages = chatMessages.filter(msg => msg.role !== "loading");

      chatMessages.push({
        role: "assistant",
        content: error.name === "AbortError"
          ? "Svaret tog for lang tid. Prøv igen med et kortere spørgsmål."
          : "Kunne ikke forbinde til backend. Prøv igen om lidt."
      });

      saveChatMessages();
    } finally {
      isGenerating = false;
      openChat();
    }
  }

  async function sendChatMessage() {
    const chatInput = document.getElementById("chatInput");
    const userMessage = chatInput.value.trim();

    if (!userMessage || isGenerating) return;

    chatInput.value = "";
    await askBackend(userMessage, true);
  }

  async function regenerateLastAnswer() {
    if (isGenerating) return;

    const lastUser = getLastUserMessage();

    if (!lastUser) {
      alert("No user message found.");
      return;
    }

    const lastAssistantIndex = [...chatMessages]
      .map((msg, index) => ({ msg, index }))
      .reverse()
      .find(item => item.msg.role === "assistant")?.index;

    if (lastAssistantIndex !== undefined) {
      chatMessages.splice(lastAssistantIndex, 1);
    }

    saveChatMessages();
    await askBackend(lastUser.content, false);
  }

  await checkProStatus();
  updateProStatus();

  chatBtn.onclick = openChat;

  historyBtn.addEventListener("click", () => {
    const history = JSON.parse(localStorage.getItem("instant_answer_history") || "[]");

    if (history.length === 0) {
      result.innerHTML = "No history yet.";
      return;
    }

    result.innerHTML = `
      <div class="answer-box">
        <div class="answer-label">HISTORY</div>
        <div class="answer-title">Recent answers</div>
        <div class="answer-content">
          ${history.map(item => `
            <div style="margin-bottom:12px;">
              <strong>${escapeHTML(item.mode.toUpperCase())}</strong><br>
              ${escapeHTML(item.question.slice(0, 80))}...<br><br>
              ${formatAnswer(item.answer.slice(0, 180))}...
            </div>
          `).join("")}
        </div>
      </div>
    `;
  });

  clearHistoryBtn.addEventListener("click", () => {
    localStorage.removeItem("instant_answer_history");
    result.innerHTML = "History cleared.";
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || tab.url.startsWith("chrome://")) {
    videoTitleElement.textContent = "This page is not supported.";
    result.innerHTML = "Open YouTube, Google Search, Reddit or a normal webpage and try again.";
    return;
  }

  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, function: getPageInfo },
    results => {
      const pageInfo = results?.[0]?.result;

      if (!pageInfo) {
        currentPageText = "";
        currentPageType = "unknown";
        currentPageLabel = "No page found";
        videoTitleElement.textContent = "No page found";
        pageLoaded = true;
        return;
      }

      currentPageText = pageInfo.text || "";
      currentPageType = pageInfo.type || "webpage";
      currentPageLabel = pageInfo.label || "Current page";
      pageLoaded = true;

      updatePageLabel();
    }
  );

  quickBtn.onclick = () => generateAnswer("quick");
  deepBtn.onclick = () => generateAnswer("deep");
  studyBtn.onclick = () => generateAnswer("study");

  async function generateAnswer(mode) {
    if (isGenerating) return;

    isGenerating = true;

    result.innerHTML = `
      <div class="loading">
        ${escapeHTML(getThinkingLabel())}<span class="typingDots"><span>.</span><span>.</span><span>.</span></span>
      </div>
    `;

    setButtonsDisabled(true);

    try {
      await checkProStatus();
      updateProStatus();

      if (!pageLoaded) {
        result.innerHTML = "Page is still loading. Try again in a second.";
        return;
      }

      if (hasReachedLimit()) {
        showProBox();
        return;
      }

      if (!currentPageText || currentPageText.includes("No visible text found")) {
        result.innerHTML = "Open YouTube, Google Search, Reddit or a normal webpage and try again.";
        return;
      }

      const improvedInput = `
You are reading content from a browser page.

Language rule:
${languageInstruction}

Page type:
${currentPageType}

Mode:
${mode}

Important:
- Use the page context.
- If it is Google, answer the search query using visible results.
- If it is Reddit, summarize post, comments, opinions and useful warnings.
- If it is YouTube, use title, description and comments.
- If it is an article or school text, analyze clearly.
- If it is math, solve step-by-step with formulas and LaTeX.
- If graph is useful, include:
GRAPH:
y = expression

Content:
${cleanText(currentPageText, 16000)}
`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);

      const response = await fetch(ASK_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: improvedInput,
          mode,
          deviceId
        })
      });

      clearTimeout(timeout);

      const data = await response.json();

      if (!response.ok || !data.answer) {
        result.innerHTML = data.answer || "Could not get an AI answer right now.";
        return;
      }

      if (data.pro) setProUser(true);

      saveHistory(mode, currentPageText, data.answer);
      increaseUsage();
      updateProStatus();
      updatePageLabel();

      const title =
        mode === "quick"
          ? "Quick Answer"
          : mode === "deep"
          ? "AI Overview"
          : "Study Help";

      const graphExpression = extractGraphExpression(data.answer);
      const graphUrl = createGraphUrl(graphExpression);

      result.innerHTML = `
        <div class="answer-box">
          <div class="answer-label">${escapeHTML(mode.toUpperCase())}</div>
          <div class="answer-title">${title}</div>
          <div class="answer-content">${formatAnswer(data.answer)}</div>
          ${renderSources(data.sources || [])}
          ${data.mathMode || containsMath(data.answer) ? `
            <div class="math-action-row">
              ${graphUrl ? `<button class="openGraphBtn" data-url="${escapeHTML(graphUrl)}">${getGraphLabel()}</button>` : ""}
            </div>
          ` : ""}
        </div>
      `;

      document.querySelectorAll(".openGraphBtn").forEach(btn => {
        btn.onclick = () => window.open(btn.dataset.url, "_blank");
      });

      document.querySelectorAll(".copyFormulaBtn").forEach(btn => {
        btn.onclick = () => navigator.clipboard.writeText(btn.dataset.formula || "");
      });
    } catch (error) {
      console.error(error);
      result.innerHTML = error.name === "AbortError"
        ? "The answer took too long. Try again with a shorter question."
        : "Could not connect to backend. Make sure your server is running.";
    } finally {
      isGenerating = false;
      setButtonsDisabled(false);
    }
  }
});

async function getPageInfo() {
  const url = window.location.href;

  function clean(text = "", limit = 16000) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/Cookie|Accept all|Sign in|Log in/gi, "")
      .trim()
      .slice(0, limit);
  }

  if (url.includes("youtube.com/watch")) {
    const title =
      document.querySelector("h1 yt-formatted-string")?.innerText ||
      document.querySelector("h1")?.innerText ||
      document.title;

    const channel =
      document.querySelector("#owner-name a")?.innerText ||
      document.querySelector("ytd-channel-name a")?.innerText ||
      "";

    const description =
      document.querySelector("#description-inline-expander")?.innerText ||
      document.querySelector("#description")?.innerText ||
      "";

    const comments = Array.from(document.querySelectorAll("#content-text"))
      .slice(0, 15)
      .map(comment => comment.innerText)
      .join("\n\n");

    return {
      type: "youtube",
      label: title.slice(0, 60),
      text: `
PAGE TYPE:
YouTube video

VIDEO TITLE:
${clean(title)}

CHANNEL:
${clean(channel)}

DESCRIPTION:
${clean(description || "No visible description found.")}

VISIBLE COMMENTS:
${clean(comments || "No visible comments found.")}
`
    };
  }

  if (url.includes("google.") && url.includes("/search")) {
    const query =
      document.querySelector("textarea[name='q'], input[name='q']")?.value ||
      document.title.replace(" - Google Search", "");

    const results = Array.from(document.querySelectorAll("div.g, [data-sokoban-container]"))
      .slice(0, 10)
      .map((item, index) => {
        const title = item.querySelector("h3")?.innerText || "";
        const text = item.innerText || "";
        return `Result ${index + 1}:\n${title}\n${text}`;
      })
      .filter(Boolean)
      .join("\n\n");

    return {
      type: "google_search",
      label: `Google: ${query}`.slice(0, 60),
      text: `
PAGE TYPE:
Google search results

SEARCH QUERY:
${clean(query)}

VISIBLE RESULTS:
${clean(results || "No visible results found.")}
`
    };
  }

  if (url.includes("reddit.com")) {
    const title =
      document.querySelector("h1")?.innerText ||
      document.querySelector('[data-testid="post-title"]')?.innerText ||
      document.title;

    const postText =
      document.querySelector('[data-testid="post-content"]')?.innerText ||
      document.querySelector("shreddit-post")?.innerText ||
      "";

    const comments = Array.from(document.querySelectorAll('[data-testid="comment"], shreddit-comment'))
      .slice(0, 15)
      .map(comment => comment.innerText)
      .join("\n\n");

    return {
      type: "reddit",
      label: `Reddit: ${title.slice(0, 50)}`,
      text: `
PAGE TYPE:
Reddit discussion

POST TITLE:
${clean(title)}

POST CONTENT:
${clean(postText || "No post text found.")}

VISIBLE COMMENTS:
${clean(comments || "No comments found.")}
`
    };
  }

  const pageTitle = document.title || "Current page";

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map(h => h.innerText)
    .filter(Boolean)
    .slice(0, 25)
    .join("\n");

  const articleText = Array.from(document.querySelectorAll("article p, main p, p"))
    .map(p => p.innerText)
    .filter(text => text && text.length > 30)
    .join("\n\n");

  const bodyText = document.body?.innerText || "";
  const bestText = articleText.length > 500 ? articleText : bodyText;

  return {
    type: "article_or_webpage",
    label: pageTitle.slice(0, 60),
    text: `
PAGE TYPE:
Article / webpage / school text

PAGE TITLE:
${clean(pageTitle)}

HEADINGS:
${clean(headings || "No headings found.")}

VISIBLE CONTENT:
${clean(bestText || "No visible text found.")}
`
  };
}