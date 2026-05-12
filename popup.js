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
let activeYoutubeTool = "summary";

let uploadedPdfFile = null;
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

async function askPdfBackend(question = "") {
  if (hasReachedLimit()) {
    showAnswer("PRO", "Upgrade to Pro", "You have used your free answers today.");
    return null;
  }

  if (!uploadedPdfFile) {
    showAnswer("PDF", "Upload PDF first", "Upload a PDF file before using PDF mode.");
    return null;
  }

  const formData = new FormData();
  formData.append("pdf", uploadedPdfFile);
  formData.append("deviceId", getDeviceId());
  formData.append("tool", activePdfTool);
  formData.append("question", question || "");

  const response = await fetch(`${BACKEND_URL}/ask-pdf`, {
    method: "POST",
    body: formData
  });

  const data = await response.json();

  if (data.pro) {
    setProUser(true);
  }

  updateProStatus();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || "Could not analyze PDF.");
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
    if (buttons[key]) buttons[key].classList.toggle("active", key === tool);
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
    if (buttons[key]) buttons[key].classList.toggle("active", key === tool);
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

  const status = uploadedPdfFile
    ? `${data[tool][2]} · ${uploadedPdfName}`
    : `${data[tool][2]} · Upload PDF først`;

  $("result").innerHTML = `<div class="loading">${escapeHTML(status)}</div>`;
}

function setYoutubeTool(tool) {
  activeYoutubeTool = tool;

  const buttons = {
    summary: $("ytSummaryBtn"),
    notes: $("ytNotesBtn"),
    moments: $("ytMomentsBtn"),
    quiz: $("ytQuizBtn"),
    chapters: $("ytChaptersBtn"),
    comments: $("ytCommentsBtn")
  };

  Object.keys(buttons).forEach(key => {
    if (buttons[key]) buttons[key].classList.toggle("active", key === tool);
  });

  const data = {
    summary: ["Spørg fx: Lav et kort resume af videoen", "Summarize video", "YouTube summary klar"],
    notes: ["Spørg fx: Lav study notes fra videoen", "Make notes", "YouTube notes klar"],
    moments: ["Spørg fx: Find key moments", "Find key moments", "Key moments klar"],
    quiz: ["Spørg fx: Lav en quiz fra videoen", "Make quiz", "YouTube quiz klar"],
    chapters: ["Spørg fx: Find kapitler/timestamps", "Detect chapters", "Chapter detection klar"],
    comments: ["Spørg fx: Hvad siger kommentarerne?", "Analyze comments", "Comment analysis klar"]
  };

  $("mainInput").placeholder = data[tool][0];
  $("mainActionBtn").textContent = data[tool][1];
  $("result").innerHTML = `<div class="loading">${data[tool]}</div>`.replace("[object Object]", data[tool][2]);
}

function setActiveMode(mode) {
  activeMode = mode;

  const tabs = {
    chat: $("chatModeBtn"),
    math: $("mathModeBtn"),
    study: $("studyModeBtn"),
    analyze: $("analyzeModeBtn"),
    pdf: $("pdfModeBtn"),
    youtube: $("youtubeModeBtn")
  };

  Object.keys(tabs).forEach(key => {
    if (tabs[key]) tabs[key].classList.toggle("active", key === mode);
  });

  $("mathTools").style.display = "none";
  $("pdfTools").style.display = "none";
  $("youtubeTools").style.display = "none";
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

  if (mode === "youtube") {
    $("panelTitle").textContent = "YouTube Mode";
    $("panelSubtitle").textContent = "Summaries, notes, key moments, quizzes, chapters and comment analysis.";
    $("youtubeTools").style.display = "grid";
    $("pageActionBtn").style.display = "block";
    $("pageActionBtn").textContent = "Read YouTube video";
    setYoutubeTool(activeYoutubeTool);
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

function buildYoutubePrompt(userMessage = "") {
  const rules = {
    summary: `
YouTube summary mode:
- Give a clear video summary.
- Start with the main idea.
- Then explain the video in sections.
- End with the most important takeaway.
`,
    notes: `
YouTube study notes mode:
- Create study notes from the video.
- Use headings and bullet points.
- Explain difficult ideas simply.
- Make it useful for revision.
`,
    moments: `
Key moments mode:
- Find the most important moments in the video.
- Use timestamps if visible.
- If exact timestamps are not available, group moments by topic.
`,
    quiz: `
Quiz mode:
- Create a quiz based on the video.
- Include multiple choice and short-answer questions.
- Add answers at the end.
`,
    chapters: `
Chapter detection mode:
- Detect chapters from description, visible timestamps or topic changes.
- If no timestamps exist, create suggested chapters.
`,
    comments: `
Comment analysis mode:
- Analyze visible comments.
- Summarize common opinions, warnings, questions and patterns.
- Separate video content from comment opinions.
`
  };

  return `
You are Instant Answer YouTube Study Assistant.

Language rule:
${languageInstruction()}

YouTube tool:
${activeYoutubeTool}

Rules:
${rules[activeYoutubeTool]}

User question:
${userMessage || "Analyze this YouTube video."}

Video/page content:
${cleanText(currentPageText, 16000)}

Important:
- Use transcript if available in the page content.
- Use title, description, chapters, timestamps and comments if visible.
- Do not invent timestamps.
- If transcript is not available, say that analysis is based on visible title, description and comments.
`;
}

function buildDirectPrompt(userMessage) {
  if (activeMode === "math") return buildMathPrompt(userMessage);

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

  if (activeMode !== "analyze" && activeMode !== "pdf" && activeMode !== "youtube" && !userMessage) return;

  if (activeMode === "pdf" && !uploadedPdfFile) {
    showAnswer("PDF", "Upload PDF first", "Upload a PDF file before using PDF mode.");
    return;
  }

  isGenerating = true;

  const loadingText =
    activeMode === "pdf" ? "Analyzing PDF..." :
    activeMode === "youtube" ? "Reading YouTube video..." :
    "AI tænker...";

  showLoading(loadingText);

  try {
    let data = null;

    if (activeMode === "pdf") {
      data = await askPdfBackend(userMessage);
    } else if (activeMode === "youtube") {
      const loaded = await loadPageInfo(true);

      if (!loaded || currentPageType !== "youtube") {
        showAnswer("YOUTUBE", "Open a YouTube video", "Open a YouTube video page first, then try again.");
        return;
      }

      data = await askBackend(buildYoutubePrompt(userMessage), "youtube");
    } else if (activeMode === "analyze") {
      const loaded = await loadPageInfo(false);

      if (!loaded) {
        showAnswer("PAGE", "Could not read page", "Open YouTube, Google, Reddit or a normal webpage and try again.");
        return;
      }

      data = await askBackend(buildAnalyzePrompt(userMessage), "analyze");
    } else {
      data = await askBackend(buildDirectPrompt(userMessage), activeMode);
    }

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
        activeMode === "youtube" ? `${activeYoutubeTool} result` :
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

  const loadingText = activeMode === "youtube" ? "Reading YouTube video..." : "Analyzing page...";
  showLoading(loadingText);

  try {
    const loaded = await loadPageInfo(true);

    if (!loaded) {
      showAnswer("PAGE", "Could not read page", "Open YouTube, Google, Reddit or a normal webpage and try again.");
      return;
    }

    if (activeMode === "youtube") {
      if (currentPageType !== "youtube") {
        showAnswer("YOUTUBE", "Open a YouTube video", "Open a YouTube video page first, then try again.");
        return;
      }

      const data = await askBackend(buildYoutubePrompt($("mainInput").value.trim()), "youtube");

      if (!data) return;

      showAnswer("YOUTUBE", `${activeYoutubeTool} result`, data.answer, data.sources || []);
      saveHistory("youtube", currentPageText, data.answer);
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

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    uploadedPdfFile = null;
    uploadedPdfName = "";
    $("pdfFileName").textContent = "Please choose a PDF file";
    showAnswer("PDF", "Wrong file type", "Please upload a PDF file.");
    return;
  }

  uploadedPdfFile = file;
  uploadedPdfName = file.name;

  $("pdfFileName").textContent = `Selected: ${uploadedPdfName}`;
  setPageStatus(`${uploadedPdfName} · PDF selected`);

  showAnswer(
    "PDF",
    "PDF selected",
    `PDF selected: ${uploadedPdfName}\n\nChoose Summary, Notes, Flashcards, Quiz, Citations or Important, then press the main button.`
  );
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

  uploadedPdfFile = null;
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
  $("youtubeModeBtn").onclick = () => setActiveMode("youtube");

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

  $("ytSummaryBtn").onclick = () => setYoutubeTool("summary");
  $("ytNotesBtn").onclick = () => setYoutubeTool("notes");
  $("ytMomentsBtn").onclick = () => setYoutubeTool("moments");
  $("ytQuizBtn").onclick = () => setYoutubeTool("quiz");
  $("ytChaptersBtn").onclick = () => setYoutubeTool("chapters");
  $("ytCommentsBtn").onclick = () => setYoutubeTool("comments");

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

  function clean(text = "", limit = 16000) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  const pageTitle = document.title || "Current page";
  const bodyText = document.body?.innerText || "";

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
      .slice(0, 25)
      .map(comment => comment.innerText)
      .filter(Boolean)
      .join("\n\n");

    const timestamps = Array.from(document.querySelectorAll("a[href*='t='], a[href*='start_radio']"))
      .slice(0, 30)
      .map(link => link.innerText)
      .filter(text => /\d+:\d+/.test(text))
      .join("\n");

    const visibleTranscript = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer, .segment-text"))
      .slice(0, 80)
      .map(item => item.innerText)
      .filter(Boolean)
      .join("\n");

    return {
      type: "youtube",
      label: title.slice(0, 55),
      text: `
PAGE TYPE:
YouTube video

VIDEO URL:
${url}

VIDEO TITLE:
${clean(title)}

CHANNEL:
${clean(channel)}

DESCRIPTION:
${clean(description || "No visible description found.")}

VISIBLE TIMESTAMPS / CHAPTERS:
${clean(timestamps || "No visible timestamps found.")}

VISIBLE TRANSCRIPT:
${clean(visibleTranscript || "No visible transcript found. Transcript API not connected yet.")}

VISIBLE COMMENTS:
${clean(comments || "No visible comments found.")}

VISIBLE PAGE TEXT:
${clean(bodyText, 6000)}
`
    };
  }

  return {
    type: url.includes("reddit.com") ? "reddit" : url.includes("google.") ? "google_search" : "webpage",
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