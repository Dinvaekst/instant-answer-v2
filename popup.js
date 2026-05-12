const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";
const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;
const PRO_LINK = "https://buy.stripe.com/4gMbJ38OycALbkD3ZD3ks02";

const DAILY_LIMIT = 5;
const userLanguage = navigator.language || "en";

let currentPageText = "";
let currentPageType = "";
let currentPageLabel = "";
let pageLoaded = false;

let isGenerating = false;
let activeMode = "chat";
let activeMathTool = "calculator";
let activePdfTool = "summary";

let uploadedPdfText = "";
let uploadedPdfName = "";

let chatMessages = JSON.parse(localStorage.getItem("ia_chat_messages") || "[]");

function $(id) {
  return document.getElementById(id);
}

function escapeHTML(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(text = "", limit = 14000) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function formatAnswer(text = "") {
  let safe = escapeHTML(text);

  safe = safe.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  safe = safe.replace(/\\\[(.*?)\\\]/gs, (_, formula) => {
    return `<div class="math-formula-block">${escapeHTML(formula)}</div>`;
  });

  safe = safe.replace(/\\\((.*?)\\\)/gs, (_, formula) => {
    return `<span class="math-inline">${escapeHTML(formula)}</span>`;
  });

  return safe.replace(/\n/g, "<br>");
}

function getDeviceId() {
  let id = localStorage.getItem("instant_answer_device_id");

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("instant_answer_device_id", id);
  }

  return id;
}

function isProUser() {
  return localStorage.getItem("instant_answer_pro") === "true";
}

function setProUser(value) {
  localStorage.setItem("instant_answer_pro", value ? "true" : "false");
}

function getTodayKey() {
  return `instant_answer_usage_${new Date().toISOString().split("T")[0]}`;
}

function getUsage() {
  return Number(localStorage.getItem(getTodayKey()) || 0);
}

function increaseUsage() {
  if (!isProUser()) {
    localStorage.setItem(getTodayKey(), String(getUsage() + 1));
  }
}

function getRemainingUsage() {
  if (isProUser()) return "∞";
  return Math.max(DAILY_LIMIT - getUsage(), 0);
}

function hasReachedLimit() {
  return !isProUser() && getUsage() >= DAILY_LIMIT;
}

function updateProStatus() {
  $("proStatus").textContent = isProUser()
    ? "Pro"
    : `Free · ${getRemainingUsage()}/${DAILY_LIMIT}`;
}

function setPageStatus(text) {
  $("pageStatus").textContent = text;
}

function languageInstruction() {
  return userLanguage.startsWith("da") ? "Answer in Danish." : "Answer in English.";
}

function showLoading(text = "AI tænker...") {
  $("result").innerHTML = `<div class="loading">${escapeHTML(text)}</div>`;
}

function showAnswer(label, title, answer, sources = []) {
  const sourceHTML = Array.isArray(sources) && sources.length > 0
    ? `
      <div class="source-box">
        <strong>Sources</strong><br>
        ${sources.slice(0, 4).map(source => `
          <div>
            ${
              source.url
                ? `<a href="${escapeHTML(source.url)}" target="_blank">${escapeHTML(source.title || source.url)}</a>`
                : escapeHTML(source.title || "Source")
            }
          </div>
        `).join("")}
      </div>
    `
    : "";

  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">${escapeHTML(label)}</div>
      <div class="answer-title">${escapeHTML(title)}</div>
      <div class="answer-content">${formatAnswer(answer)}</div>
      ${sourceHTML}
    </div>
  `;
}

function saveHistory(mode, question, answer) {
  const history = JSON.parse(localStorage.getItem("instant_answer_history") || "[]");

  history.unshift({
    mode,
    question: String(question || "").slice(0, 240),
    answer: String(answer || "").slice(0, 900),
    date: new Date().toISOString()
  });

  localStorage.setItem("instant_answer_history", JSON.stringify(history.slice(0, 20)));
}

async function checkProStatus() {
  try {
    const response = await fetch(CHECK_PRO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: getDeviceId() })
    });

    const data = await response.json();

    if (data.pro) {
      setProUser(true);
    }
  } catch (error) {
    console.error("Pro check failed:", error);
  } finally {
    updateProStatus();
  }
}

async function askBackend(input, mode) {
  if (hasReachedLimit()) {
    $("result").innerHTML = `
      <div class="pro-box">
        <div class="pro-title">Upgrade to Pro</div>
        <div>You have used your free answers today.</div>
        <button id="upgradeBtn" class="upgrade-btn">Upgrade to Pro</button>
      </div>
    `;

    $("upgradeBtn").onclick = () => {
      window.open(`${PRO_LINK}?client_reference_id=${getDeviceId()}`, "_blank");
    };

    return null;
  }

  const response = await fetch(ASK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input,
      mode,
      deviceId: getDeviceId()
    })
  });

  const data = await response.json();

  if (data.pro) {
    setProUser(true);
  }

  updateProStatus();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || "Could not get AI answer.");
  }

  increaseUsage();
  updateProStatus();

  return data;
}

function renderChatMessages() {
  if (chatMessages.length === 0) {
    $("result").innerHTML = `<div class="loading">Skriv dit spørgsmål nedenfor</div>`;
    return;
  }

  $("result").innerHTML = chatMessages.map(msg => `
    <div class="msg ${msg.role === "user" ? "user-msg" : "ai-msg"}">
      ${formatAnswer(msg.content)}
    </div>
  `).join("");
}

function setMathTool(tool) {
  activeMathTool = tool;

  const buttons = {
    calculator: $("calcToolBtn"),
    equation: $("equationToolBtn"),
    percent: $("percentToolBtn"),
    graph: $("graphToolBtn"),
    formula: $("formulaToolBtn"),
    word: $("wordToolBtn")
  };

  Object.keys(buttons).forEach(key => {
    if (buttons[key]) {
      buttons[key].classList.toggle("active", key === tool);
    }
  });

  const data = {
    calculator: ["Skriv fx: 25*4+10", "Calculate", "Calculator klar"],
    equation: ["Skriv fx: 2x + 5 = 17", "Solve equation", "Equation solver klar"],
    percent: ["Skriv fx: 20% rabat af 499", "Calculate percent", "Percentage calculator klar"],
    graph: ["Skriv fx: y = 2x + 3", "Explain graph", "Graph helper klar"],
    formula: ["Skriv fx: Pythagoras eller renteformlen", "Explain formula", "Formula helper klar"],
    word: ["Indsæt en tekstopgave her...", "Solve word problem", "Word problem solver klar"]
  };

  $("mainInput").placeholder = data[tool][0];
  $("mainActionBtn").textContent = data[tool][1];
  $("result").innerHTML = `<div class="loading">${data[tool][2]}</div>`;
}

function setPdfTool(tool) {
  activePdfTool = tool;

  const buttons = {
    summary: $("pdfSummaryBtn"),
    notes: $("pdfNotesBtn"),
    flashcards: $("pdfFlashcardsBtn"),
    quiz: $("pdfQuizBtn"),
    citations: $("pdfCitationsBtn"),
    important: $("pdfImportantBtn")
  };

  Object.keys(buttons).forEach(key => {
    if (buttons[key]) {
      buttons[key].classList.toggle("active", key === tool);
    }
  });

  const data = {
    summary: ["Spørg fx: Lav et kort resume", "Summarize PDF", "PDF summary klar"],
    notes: ["Spørg fx: Lav studienoter", "Make notes", "Study notes klar"],
    flashcards: ["Spørg fx: Lav 10 flashcards", "Make flashcards", "Flashcards klar"],
    quiz: ["Spørg fx: Lav en quiz med svar", "Make quiz", "Quiz mode klar"],
    citations: ["Spørg fx: Find vigtige citater", "Extract citations", "Citation extraction klar"],
    important: ["Spørg fx: Find de vigtigste pointer", "Find important points", "Important points finder klar"]
  };

  $("mainInput").placeholder = data[tool][0];
  $("mainActionBtn").textContent = data[tool][1];

  const status = uploadedPdfText
    ? `${data[tool][2]} · ${uploadedPdfName}`
    : `${data[tool][2]} · Upload PDF først`;

  $("result").innerHTML = `<div class="loading">${escapeHTML(status)}</div>`;
}

function setActiveMode(mode) {
  activeMode = mode;

  const tabs = {
    chat: $("chatModeBtn"),
    math: $("mathModeBtn"),
    study: $("studyModeBtn"),
    analyze: $("analyzeModeBtn"),
    pdf: $("pdfModeBtn")
  };

  Object.keys(tabs).forEach(key => {
    if (tabs[key]) {
      tabs[key].classList.toggle("active", key === mode);
    }
  });

  $("mathTools").style.display = "none";
  $("pdfTools").style.display = "none";
  $("pdfUploadBox").style.display = "none";
  $("pageActionBtn").style.display = "none";

  $("mainInput").style.display = "block";
  $("mainActionBtn").style.display = "block";

  if (mode === "chat") {
    $("panelTitle").textContent = "Chat Mode";
    $("panelSubtitle").textContent = "Ask anything and get a clear answer.";
    $("mainInput").placeholder = "Skriv dit spørgsmål...";
    $("mainActionBtn").textContent = "Send";
    renderChatMessages();
  }

  if (mode === "math") {
    $("panelTitle").textContent = "Math Mode";
    $("panelSubtitle").textContent = "Calculator, equations, percentages, graphs, formulas and word problems.";
    $("mathTools").style.display = "grid";
    setMathTool(activeMathTool);
  }

  if (mode === "study") {
    $("panelTitle").textContent = "Study Mode";
    $("panelSubtitle").textContent = "Get simple explanations, notes and exam-style help.";
    $("mainInput").placeholder = "Hvad vil du lære eller forstå?";
    $("mainActionBtn").textContent = "Explain";
    $("result").innerHTML = `<div class="loading">Klar til studiehjælp</div>`;
  }

  if (mode === "analyze") {
    $("panelTitle").textContent = "Analyze Mode";
    $("panelSubtitle").textContent = "Analyze the current webpage, YouTube, Google or Reddit page.";
    $("mainInput").placeholder = "Hvad vil du vide om siden?";
    $("mainActionBtn").textContent = "Ask about page";
    $("pageActionBtn").style.display = "block";
    $("result").innerHTML = `<div class="loading">Klar til sideanalyse</div>`;
  }

  if (mode === "pdf") {
    $("panelTitle").textContent = "PDF Mode";
    $("panelSubtitle").textContent = "Upload a PDF and create summaries, notes, flashcards, quizzes and citations.";
    $("pdfTools").style.display = "grid";
    $("pdfUploadBox").style.display = "block";
    setPdfTool(activePdfTool);
  }
}

function buildMathPrompt(userMessage) {
  const rules = {
    calculator: "Calculate accurately. Show calculation and final result.",
    equation: "Solve the equation step by step. Isolate the unknown and check the answer.",
    percent: "Identify percentage type. Show formula, calculation and final answer.",
    graph: "Explain the function, slope/intersections/shape. If useful include GRAPH: y = expression.",
    formula: "Explain the formula, variables, when to use it and give an example.",
    word: "Solve using: 1. Given 2. Find 3. Formula 4. Calculation 5. Final answer."
  };

  return `
You are Instant Answer Math.

Language rule:
${languageInstruction()}

Math tool:
${activeMathTool}

Rules:
${rules[activeMathTool]}

User input:
${userMessage}
`;
}

function buildPdfPrompt(userMessage = "") {
  const pdfRules = {
    summary: `
PDF summary mode:
- Give a clear summary.
- Start with the main idea.
- Then explain the document section by section.
- End with a short "most important takeaway".
`,
    notes: `
Study notes mode:
- Create useful study notes.
- Use headings and bullet points.
- Explain difficult words simply.
- Make it easy to revise for school or exam.
`,
    flashcards: `
Flashcards mode:
- Create flashcards.
- Format each as Q: and A:
- Focus on key terms, facts, definitions and concepts.
`,
    quiz: `
Quiz mode:
- Create a quiz from the PDF.
- Include multiple choice and short-answer questions.
- Include answers after the quiz.
`,
    citations: `
Citation extraction mode:
- Extract useful quotes/sentences from the PDF text.
- Explain why each citation is important.
- Do not invent page numbers if they are not available.
`,
    important: `
Important points mode:
- Find the most important points.
- Rank them by importance.
- Explain why each point matters.
`
  };

  return `
You are Instant Answer PDF Assistant.

Language rule:
${languageInstruction()}

PDF tool:
${activePdfTool}

Rules:
${pdfRules[activePdfTool]}

User question:
${userMessage || "Analyze this PDF."}

PDF file name:
${uploadedPdfName || "Unknown PDF"}

PDF text:
${cleanText(uploadedPdfText, 18000)}
`;
}

function buildDirectPrompt(userMessage) {
  if (activeMode === "math") return buildMathPrompt(userMessage);
  if (activeMode === "pdf") return buildPdfPrompt(userMessage);

  return `
You are Instant Answer.

Language rule:
${languageInstruction()}

Mode:
${activeMode}

Rules:
- Answer clearly and directly.
- If study mode, explain simply with notes and examples.
- If school work, give useful wording.

User message:
${userMessage}
`;
}

async function loadPageInfo(force = false) {
  if (pageLoaded && !force) return true;

  try {
    setPageStatus("Analyzing page...");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id || !tab.url || tab.url.startsWith("chrome://")) {
      setPageStatus("Unsupported page");
      return false;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: getPageInfo
    });

    const pageInfo = results?.[0]?.result;

    if (!pageInfo || !pageInfo.text) {
      setPageStatus("No page text found");
      return false;
    }

    currentPageText = pageInfo.text;
    currentPageType = pageInfo.type || "webpage";
    currentPageLabel = pageInfo.label || "Current page";
    pageLoaded = true;

    setPageStatus(`${currentPageLabel} · Ready`);
    return true;
  } catch (error) {
    console.error(error);
    setPageStatus("Page analysis failed");
    return false;
  }
}

function buildAnalyzePrompt(userMessage = "") {
  return `
You are Instant Answer.

Language rule:
${languageInstruction()}

Mode:
analyze

Page type:
${currentPageType}

User question:
${userMessage || "Analyze this page clearly."}

Page content:
${cleanText(currentPageText, 14000)}
`;
}

async function runMainAction() {
  if (isGenerating) return;

  const userMessage = $("mainInput").value.trim();

  if (activeMode !== "analyze" && activeMode !== "pdf" && !userMessage) return;

  if (activeMode === "pdf" && !uploadedPdfText) {
    showAnswer("PDF", "Upload PDF first", "Upload a PDF file before using PDF mode.");
    return;
  }

  isGenerating = true;
  showLoading("AI tænker...");

  try {
    let input = "";
    let backendMode = activeMode;

    if (activeMode === "analyze") {
      const loaded = await loadPageInfo(false);

      if (!loaded) {
        showAnswer("PAGE", "Could not read page", "Open YouTube, Google, Reddit or a normal webpage and try again.");
        return;
      }

      input = buildAnalyzePrompt(userMessage);
    } else {
      input = buildDirectPrompt(userMessage);
    }

    const data = await askBackend(input, backendMode);

    if (!data) return;

    if (activeMode === "chat") {
      chatMessages.push({ role: "user", content: userMessage });
      chatMessages.push({ role: "assistant", content: data.answer });
      localStorage.setItem("ia_chat_messages", JSON.stringify(chatMessages.slice(-30)));
      renderChatMessages();
    } else {
      const title =
        activeMode === "math" ? `${activeMathTool} result` :
        activeMode === "study" ? "Study Help" :
        activeMode === "analyze" ? "Page Analysis" :
        activeMode === "pdf" ? `${activePdfTool} result` :
        "AI Answer";

      showAnswer(activeMode.toUpperCase(), title, data.answer, data.sources || []);
    }

    saveHistory(activeMode, userMessage || uploadedPdfName || currentPageText, data.answer);
    $("mainInput").value = "";
  } catch (error) {
    console.error(error);
    showAnswer("ERROR", "Something went wrong", error.message || "Could not connect to backend.");
  } finally {
    isGenerating = false;
  }
}

async function analyzeCurrentPage() {
  if (isGenerating) return;

  isGenerating = true;
  showLoading("Analyzing page...");

  try {
    const loaded = await loadPageInfo(true);

    if (!loaded) {
      showAnswer("PAGE", "Could not read page", "Open YouTube, Google, Reddit or a normal webpage and try again.");
      return;
    }

    const data = await askBackend(buildAnalyzePrompt($("mainInput").value.trim()), "analyze");

    if (!data) return;

    showAnswer("ANALYZE", "Page Analysis", data.answer, data.sources || []);
    saveHistory("analyze", currentPageText, data.answer);
  } catch (error) {
    console.error(error);
    showAnswer("ERROR", "Something went wrong", error.message || "Could not analyze page.");
  } finally {
    isGenerating = false;
  }
}

async function handlePdfUpload(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  uploadedPdfName = file.name;
  uploadedPdfText = "";

  $("pdfFileName").textContent = `Selected: ${uploadedPdfName}`;
  showLoading("Reading PDF...");

  try {
    const arrayBuffer = await file.arrayBuffer();

    uploadedPdfText = `
PDF file uploaded:
${uploadedPdfName}

IMPORTANT:
Browser-side PDF parsing is not fully enabled yet.
Next step is to add server-side PDF parsing with pdf-parse.
For now, use the question box to describe what you want from this PDF, or paste PDF text manually.
`;

    showAnswer(
      "PDF",
      "PDF selected",
      `PDF selected: ${uploadedPdfName}\n\nNext step: we will connect real PDF parsing in server.js so the AI can read the full document.`
    );

    setPageStatus(`${uploadedPdfName} · PDF selected`);
  } catch (error) {
    console.error(error);
    uploadedPdfText = "";
    uploadedPdfName = "";
    $("pdfFileName").textContent = "Could not read PDF";
    showAnswer("PDF", "Upload failed", "Could not read the PDF file.");
  }
}

function showHistory() {
  const history = JSON.parse(localStorage.getItem("instant_answer_history") || "[]");

  if (history.length === 0) {
    showAnswer("HISTORY", "No history yet", "You have no saved answers yet.");
    return;
  }

  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">HISTORY</div>
      <div class="answer-title">Recent answers</div>
      ${history.map(item => `
        <div class="history-item">
          <strong>${escapeHTML(item.mode.toUpperCase())}</strong><br>
          ${escapeHTML(item.question)}<br><br>
          ${formatAnswer(item.answer)}
        </div>
      `).join("")}
    </div>
  `;
}

function clearAll() {
  localStorage.removeItem("instant_answer_history");
  localStorage.removeItem("ia_chat_messages");

  chatMessages = [];
  currentPageText = "";
  currentPageType = "";
  currentPageLabel = "";
  pageLoaded = false;

  uploadedPdfText = "";
  uploadedPdfName = "";

  if ($("pdfFileInput")) $("pdfFileInput").value = "";
  if ($("pdfFileName")) $("pdfFileName").textContent = "No PDF selected";

  setPageStatus("Ready");
  setActiveMode("chat");
}

document.addEventListener("DOMContentLoaded", () => {
  updateProStatus();
  setPageStatus("Ready");

  $("chatModeBtn").onclick = () => setActiveMode("chat");
  $("mathModeBtn").onclick = () => setActiveMode("math");
  $("studyModeBtn").onclick = () => setActiveMode("study");
  $("analyzeModeBtn").onclick = () => setActiveMode("analyze");
  $("pdfModeBtn").onclick = () => setActiveMode("pdf");

  $("calcToolBtn").onclick = () => setMathTool("calculator");
  $("equationToolBtn").onclick = () => setMathTool("equation");
  $("percentToolBtn").onclick = () => setMathTool("percent");
  $("graphToolBtn").onclick = () => setMathTool("graph");
  $("formulaToolBtn").onclick = () => setMathTool("formula");
  $("wordToolBtn").onclick = () => setMathTool("word");

  $("pdfSummaryBtn").onclick = () => setPdfTool("summary");
  $("pdfNotesBtn").onclick = () => setPdfTool("notes");
  $("pdfFlashcardsBtn").onclick = () => setPdfTool("flashcards");
  $("pdfQuizBtn").onclick = () => setPdfTool("quiz");
  $("pdfCitationsBtn").onclick = () => setPdfTool("citations");
  $("pdfImportantBtn").onclick = () => setPdfTool("important");

  $("pdfFileInput").onchange = handlePdfUpload;

  $("mainActionBtn").onclick = runMainAction;
  $("pageActionBtn").onclick = analyzeCurrentPage;

  $("mainInput").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runMainAction();
    }
  });

  $("historyBtn").onclick = showHistory;
  $("clearBtn").onclick = clearAll;

  setActiveMode("chat");
  checkProStatus();
});

async function getPageInfo() {
  const url = window.location.href;

  function clean(text = "", limit = 14000) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  const pageTitle = document.title || "Current page";
  const bodyText = document.body?.innerText || "";

  return {
    type: url.includes("youtube.com") ? "youtube" : url.includes("reddit.com") ? "reddit" : url.includes("google.") ? "google_search" : "webpage",
    label: pageTitle.slice(0, 55),
    text: `
PAGE URL:
${url}

PAGE TITLE:
${clean(pageTitle)}

VISIBLE CONTENT:
${clean(bodyText)}
`
  };
}