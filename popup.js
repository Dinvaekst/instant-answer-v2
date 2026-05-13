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
let activeSmartTool = "context";
let activeMathTool = "calculator";
let activePdfTool = "summary";
let activeYoutubeTool = "summary";

let uploadedPdfFile = null;
let uploadedPdfName = "";

let uploadedImageFile = null;
let uploadedImageName = "";

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
  if (!$("proStatus")) return;

  $("proStatus").textContent = isProUser()
    ? "Pro"
    : `Free · ${getRemainingUsage()}/${DAILY_LIMIT}`;
}

function setPageStatus(text) {
  if ($("pageStatus")) $("pageStatus").textContent = text;
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
    if (data.pro) setProUser(true);
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      mode,
      deviceId: getDeviceId()
    })
  });

  const data = await response.json();

  if (data.pro) setProUser(true);
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

  if (data.pro) setProUser(true);
  updateProStatus();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || "Could not analyze PDF.");
  }

  increaseUsage();
  updateProStatus();

  return data;
}

async function askImageBackend(question = "", imageFile = uploadedImageFile) {
  if (hasReachedLimit()) {
    showAnswer("PRO", "Upgrade to Pro", "You have used your free answers today.");
    return null;
  }

  if (!imageFile) {
    showAnswer("IMAGE", "Upload image first", "Upload an image before using image analysis.");
    return null;
  }

  const formData = new FormData();
  formData.append("image", imageFile);
  formData.append("deviceId", getDeviceId());
  formData.append("tool", activeSmartTool);
  formData.append("question", question || "");

  const response = await fetch(`${BACKEND_URL}/ask-image`, {
    method: "POST",
    body: formData
  });

  const data = await response.json();

  if (data.pro) setProUser(true);
  updateProStatus();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || "Could not analyze image.");
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

function setSmartTool(tool) {
  activeSmartTool = tool;

  const buttons = {
    context: $("smartContextBtn"),
    selected: $("selectedTextBtn"),
    screenshot: $("screenshotBtn"),
    image: $("imageUploadBtn"),
    auto: $("autoDetectBtn"),
    classify: $("classifyPageBtn")
  };

  Object.keys(buttons).forEach(key => {
    if (buttons[key]) buttons[key].classList.toggle("active", key === tool);
  });

  const data = {
    context: ["Spørg om hele siden...", "Use smart context", "Smart context klar"],
    selected: ["Marker tekst på siden og spørg...", "Ask selected text", "Selected text klar"],
    screenshot: ["Spørg om screenshot...", "Analyze screenshot", "Screenshot OCR klar"],
    image: ["Upload billede og spørg...", "Analyze image", "Image analysis klar"],
    auto: ["Indsæt opgave/tekst, så finder AI typen...", "Auto detect", "Auto detection klar"],
    classify: ["Klassificer siden og forklar den...", "Classify page", "Website classification klar"]
  };

  $("mainInput").placeholder = data[tool][0];
  $("mainActionBtn").textContent = data[tool][1];

  if ($("imageUploadBox")) {
    $("imageUploadBox").style.display = tool === "image" ? "block" : "none";
  }

  $("result").innerHTML = `<div class="loading">${escapeHTML(data[tool][2])}</div>`;
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
  $("result").innerHTML = `<div class="loading">${escapeHTML(data[tool][2])}</div>`;
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
  $("result").innerHTML = `<div class="loading">${escapeHTML(data[tool][2])}</div>`;
}

function setActiveMode(mode) {
  activeMode = mode;

  const tabs = {
    chat: $("chatModeBtn"),
    smart: $("smartModeBtn"),
    math: $("mathModeBtn"),
    study: $("studyModeBtn"),
    analyze: $("analyzeModeBtn"),
    pdf: $("pdfModeBtn"),
    youtube: $("youtubeModeBtn")
  };

  Object.keys(tabs).forEach(key => {
    if (tabs[key]) tabs[key].classList.toggle("active", key === mode);
  });

  if ($("smartTools")) $("smartTools").style.display = "none";
  if ($("mathTools")) $("mathTools").style.display = "none";
  if ($("pdfTools")) $("pdfTools").style.display = "none";
  if ($("youtubeTools")) $("youtubeTools").style.display = "none";
  if ($("pdfUploadBox")) $("pdfUploadBox").style.display = "none";
  if ($("imageUploadBox")) $("imageUploadBox").style.display = "none";
  if ($("pageActionBtn")) $("pageActionBtn").style.display = "none";

  $("mainInput").style.display = "block";
  $("mainActionBtn").style.display = "block";

  if (mode === "chat") {
    $("panelTitle").textContent = "Chat Mode";
    $("panelSubtitle").textContent = "Ask anything and get a clear answer.";
    $("mainInput").placeholder = "Skriv dit spørgsmål...";
    $("mainActionBtn").textContent = "Send";
    renderChatMessages();
  }

  if (mode === "smart") {
    $("panelTitle").textContent = "Smart Browser AI";
    $("panelSubtitle").textContent = "Understand selected text, screenshots, images, assignments, math and websites.";
    $("smartTools").style.display = "grid";
    $("pageActionBtn").style.display = "block";
    $("pageActionBtn").textContent = "Read current page";
    setSmartTool(activeSmartTool);
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
    $("pageActionBtn").textContent = "Analyze current page";
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

function buildSmartPrompt(userMessage = "", extraText = "") {
  const rules = {
    context: "Use the full page context. Explain what matters and answer the user clearly.",
    selected: "Use selected text only. Explain it, summarize it or answer the user's question about it.",
    screenshot: "Analyze the screenshot/OCR content. Identify text, layout, questions, math or school tasks.",
    image: "Analyze the uploaded image. Extract useful details and answer the user's question.",
    auto: "Auto-detect if this is math, school assignment, article, search, website, or general question.",
    classify: "Classify the website/page type, purpose, quality, important content and what the user can do next."
  };

  return `
You are Instant Answer Smart Browser AI.

Language rule:
${languageInstruction()}

Smart tool:
${activeSmartTool}

Rules:
${rules[activeSmartTool]}

User question:
${userMessage || "Analyze this browser context."}

Extra context:
${cleanText(extraText, 8000)}

Current page type:
${currentPageType}

Current page label:
${currentPageLabel}

Current page content:
${cleanText(currentPageText, 16000)}

Important:
- Auto detect school assignments.
- Auto detect math.
- Auto detect article type.
- Improve page understanding.
- Improve website classification.
- Improve search understanding.
- Be clear and practical.
`;
}

function buildYoutubePrompt(userMessage = "") {
  const rules = {
    summary: "Give a clear video summary with main idea, sections and takeaway.",
    notes: "Create study notes with headings, bullet points and simple explanations.",
    moments: "Find key moments. Use timestamps only if visible. If not, group by topic.",
    quiz: "Create a quiz from the video and include answers at the end.",
    chapters: "Detect chapters from timestamps or topic changes. If no timestamps exist, create suggested chapters.",
    comments: "Analyze visible comments and separate comment opinions from video content."
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
- Use transcript if available.
- Use title, description, chapters, timestamps and comments if visible.
- Do not invent timestamps.
- If transcript is not available, say analysis is based on visible title, description and comments.
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

async function getSelectedTextFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) return "";

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => window.getSelection()?.toString() || ""
    });

    return results?.[0]?.result || "";
  } catch (error) {
    console.error("Selected text error:", error);
    return "";
  }
}

async function captureScreenshotAsFile() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    return new File([blob], "screenshot.png", { type: "image/png" });
  } catch (error) {
    console.error("Screenshot error:", error);
    return null;
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

  if (
    activeMode !== "analyze" &&
    activeMode !== "pdf" &&
    activeMode !== "youtube" &&
    activeMode !== "smart" &&
    !userMessage
  ) return;

  if (activeMode === "pdf" && !uploadedPdfFile) {
    showAnswer("PDF", "Upload PDF first", "Upload a PDF file before using PDF mode.");
    return;
  }

  if (activeMode === "smart" && activeSmartTool === "image" && !uploadedImageFile) {
    showAnswer("IMAGE", "Upload image first", "Upload an image before using Image mode.");
    return;
  }

  isGenerating = true;

  const loadingText =
    activeMode === "pdf" ? "Analyzing PDF..." :
    activeMode === "youtube" ? "Reading YouTube video..." :
    activeMode === "smart" ? "Smart AI analyzing..." :
    "AI tænker...";

  showLoading(loadingText);

  try {
    let data = null;

    if (activeMode === "pdf") {
      data = await askPdfBackend(userMessage);
    } else if (activeMode === "smart") {
      data = await runSmartAction(userMessage);
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
        activeMode === "smart" ? `${activeSmartTool} result` :
        "AI Answer";

      showAnswer(activeMode.toUpperCase(), title, data.answer, data.sources || []);
    }

    saveHistory(activeMode, userMessage || uploadedPdfName || uploadedImageName || currentPageText, data.answer);
    $("mainInput").value = "";
  } catch (error) {
    console.error(error);
    showAnswer("ERROR", "Something went wrong", error.message || "Could not connect to backend.");
  } finally {
    isGenerating = false;
  }
}

async function runSmartAction(userMessage = "") {
  if (activeSmartTool === "image") {
    return await askImageBackend(userMessage, uploadedImageFile);
  }

  if (activeSmartTool === "screenshot") {
    const screenshotFile = await captureScreenshotAsFile();

    if (!screenshotFile) {
      showAnswer("SCREENSHOT", "Could not capture screenshot", "Chrome could not capture this tab.");
      return null;
    }

    return await askImageBackend(userMessage, screenshotFile);
  }

  let extraText = "";

  if (activeSmartTool === "selected") {
    extraText = await getSelectedTextFromPage();

    if (!extraText) {
      showAnswer("SELECTED", "No selected text", "Markér tekst på siden først, og prøv igen.");
      return null;
    }
  }

  const loaded = await loadPageInfo(true);

  if (!loaded) {
    showAnswer("SMART", "Could not read page", "Open a normal webpage and try again.");
    return null;
  }

  return await askBackend(buildSmartPrompt(userMessage, extraText), "smart");
}

async function analyzeCurrentPage() {
  if (isGenerating) return;

  isGenerating = true;

  const loadingText =
    activeMode === "youtube" ? "Reading YouTube video..." :
    activeMode === "smart" ? "Reading browser context..." :
    "Analyzing page...";

  showLoading(loadingText);

  try {
    const loaded = await loadPageInfo(true);

    if (!loaded) {
      showAnswer("PAGE", "Could not read page", "Open YouTube, Google, Reddit or a normal webpage and try again.");
      return;
    }

    if (activeMode === "smart") {
      const data = await askBackend(buildSmartPrompt($("mainInput").value.trim()), "smart");
      if (!data) return;
      showAnswer("SMART", `${activeSmartTool} result`, data.answer, data.sources || []);
      saveHistory("smart", currentPageText, data.answer);
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

function handleImageUpload(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  const validTypes = ["image/png", "image/jpeg", "image/webp"];

  if (!validTypes.includes(file.type)) {
    uploadedImageFile = null;
    uploadedImageName = "";
    $("imageFileName").textContent = "Please choose PNG, JPG or WEBP";
    showAnswer("IMAGE", "Wrong file type", "Please upload PNG, JPG or WEBP.");
    return;
  }

  uploadedImageFile = file;
  uploadedImageName = file.name;

  $("imageFileName").textContent = `Selected: ${uploadedImageName}`;
  setPageStatus(`${uploadedImageName} · Image selected`);

  showAnswer(
    "IMAGE",
    "Image selected",
    `Image selected: ${uploadedImageName}\n\nAsk a question or press Analyze image.`
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
  uploadedImageFile = null;
  uploadedImageName = "";

  if ($("pdfFileInput")) $("pdfFileInput").value = "";
  if ($("pdfFileName")) $("pdfFileName").textContent = "No PDF selected";
  if ($("imageFileInput")) $("imageFileInput").value = "";
  if ($("imageFileName")) $("imageFileName").textContent = "No image selected";

  setPageStatus("Ready");
  setActiveMode("chat");
}

document.addEventListener("DOMContentLoaded", () => {
  updateProStatus();
  setPageStatus("Ready");

  $("chatModeBtn").onclick = () => setActiveMode("chat");
  $("smartModeBtn").onclick = () => setActiveMode("smart");
  $("mathModeBtn").onclick = () => setActiveMode("math");
  $("studyModeBtn").onclick = () => setActiveMode("study");
  $("analyzeModeBtn").onclick = () => setActiveMode("analyze");
  $("pdfModeBtn").onclick = () => setActiveMode("pdf");
  $("youtubeModeBtn").onclick = () => setActiveMode("youtube");

  $("smartContextBtn").onclick = () => setSmartTool("context");
  $("selectedTextBtn").onclick = () => setSmartTool("selected");
  $("screenshotBtn").onclick = () => setSmartTool("screenshot");
  $("imageUploadBtn").onclick = () => setSmartTool("image");
  $("autoDetectBtn").onclick = () => setSmartTool("auto");
  $("classifyPageBtn").onclick = () => setSmartTool("classify");

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
  $("imageFileInput").onchange = handleImageUpload;

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
  const selectedText = window.getSelection()?.toString() || "";

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map(h => h.innerText)
    .filter(Boolean)
    .slice(0, 30)
    .join("\n");

  const forms = Array.from(document.querySelectorAll("input, textarea, select"))
    .slice(0, 20)
    .map(el => `${el.tagName}: ${el.placeholder || el.name || el.id || ""}`)
    .filter(Boolean)
    .join("\n");

  let detectedType = "webpage";

  const lower = bodyText.toLowerCase();

  if (url.includes("youtube.com/watch")) detectedType = "youtube";
  else if (url.includes("reddit.com")) detectedType = "reddit";
  else if (url.includes("google.") && url.includes("/search")) detectedType = "google_search";
  else if (lower.includes("assignment") || lower.includes("opgave") || lower.includes("aflevering")) detectedType = "school_assignment";
  else if (/[=+\-*/^√π∫Σ]/.test(bodyText) && /\d/.test(bodyText)) detectedType = "math_page";
  else if (document.querySelector("article") || headings.length > 80) detectedType = "article";

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

    const timestamps = Array.from(document.querySelectorAll("a[href*='t=']"))
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
${clean(visibleTranscript || "No visible transcript found. Backend transcript will try to fetch it.")}

VISIBLE COMMENTS:
${clean(comments || "No visible comments found.")}

SELECTED TEXT:
${clean(selectedText || "No selected text.")}

VISIBLE PAGE TEXT:
${clean(bodyText, 6000)}
`
    };
  }

  return {
    type: detectedType,
    label: pageTitle.slice(0, 55),
    text: `
PAGE URL:
${url}

PAGE TYPE DETECTED:
${detectedType}

PAGE TITLE:
${clean(pageTitle)}

HEADINGS:
${clean(headings || "No headings found.")}

SELECTED TEXT:
${clean(selectedText || "No selected text.")}

FORM FIELDS:
${clean(forms || "No form fields found.")}

VISIBLE CONTENT:
${clean(bodyText)}
`
  };
}