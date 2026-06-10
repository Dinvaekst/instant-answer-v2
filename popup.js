const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";
const ASK_URL = `${BACKEND_URL}/ask`;
const ASK_PDF_URL = `${BACKEND_URL}/ask-pdf`;
const ASK_IMAGE_URL = `${BACKEND_URL}/ask-image`;

const PRO_LINK = "https://buy.stripe.com/4gMbJ38OycALbkD3ZD3ks02";
const DAILY_LIMIT = 5;

let activeMode = "quick";
let activeStudyTool = "explain";
let activePageTool = "page";
let activeYoutubeTool = "summary";
let activeFileTool = "pdf";
let isGenerating = false;
let currentPageText = "";
let currentPageTitle = "";
let uploadedPdfFile = null;
let uploadedPdfName = "";
let uploadedImageFile = null;
let uploadedImageName = "";
let localHistory = JSON.parse(localStorage.getItem("ia_history") || "[]");

function $(id) { return document.getElementById(id); }

function safeText(value = "") { return String(value ?? ""); }

function escapeHTML(value = "") {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatAnswer(text = "") {
  return escapeHTML(text)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function showResult(label, title, body) {
  const result = $("result");
  if (!result) return;
  result.innerHTML = `
    <div>
      <div class="answer-label">${escapeHTML(label)}</div>
      <div class="answer-title">${escapeHTML(title)}</div>
      <div class="answer-content">${formatAnswer(body)}</div>
    </div>
  `;
}

function showLoading(text = "Loading") {
  const result = $("result");
  if (!result) return;
  result.innerHTML = `<div class="loading">${escapeHTML(text)}</div>`;
}

function showReady(text = "Ready") {
  const result = $("result");
  if (!result) return;
  result.innerHTML = `<div class="loading">${escapeHTML(text)}</div>`;
}

// ── Usage tracking ──────────────────────────────────────
function getUsageKey() {
  const date = new Date().toISOString().slice(0, 10);
  return `ia_usage_${date}`;
}

function getUsage() {
  return Number(localStorage.getItem(getUsageKey()) || 0);
}

function increaseUsage() {
  if (isPro()) return;
  localStorage.setItem(getUsageKey(), String(getUsage() + 1));
}

function isPro() {
  return localStorage.getItem("instant_answer_pro") === "true";
}

function hasReachedLimit() {
  return !isPro() && getUsage() >= DAILY_LIMIT;
}

function updateUsageUI() {
  const proStatus = $("proStatus");
  if (!proStatus) return;
  proStatus.textContent = isPro() ? "Pro ✓" : `Free · ${Math.max(0, DAILY_LIMIT - getUsage())}/${DAILY_LIMIT}`;
}

// ── Upgrade ─────────────────────────────────────────────
function upgradeToPro() {
  try {
    if (typeof chrome !== "undefined" && chrome?.tabs?.create) {
      chrome.tabs.create({ url: PRO_LINK });
    } else {
      window.open(PRO_LINK, "_blank");
    }
    showResult("Upgrade", "Stripe checkout opened", "Complete payment in the new tab.\nAfter payment, reopen Instant Answer.");
  } catch (e) {
    window.open(PRO_LINK, "_blank");
  }
}

// ── History ─────────────────────────────────────────────
function saveLocalHistory(mode, question, answer) {
  localHistory.unshift({
    mode,
    question: safeText(question).slice(0, 200),
    answer: safeText(answer).slice(0, 700),
    date: new Date().toISOString()
  });
  localHistory = localHistory.slice(0, 25);
  localStorage.setItem("ia_history", JSON.stringify(localHistory));
}

function showHistory() {
  if (!localHistory.length) {
    showResult("History", "No history yet", "You have no saved chats yet.");
    return;
  }
  const result = $("result");
  if (!result) return;
  result.innerHTML = `
    <div>
      <div class="answer-label">History</div>
      <div class="answer-title">Recent chats</div>
      ${localHistory.slice(0, 25).map(item => `
        <div style="margin-top:10px;padding:10px;border-radius:16px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.12)">
          <strong>${escapeHTML((item.mode || "chat").toUpperCase())}</strong><br><br>
          ${escapeHTML(item.question || "")}<br><br>
          ${formatAnswer(item.answer || "")}<br><br>
          <small style="color:#b8b8b8">${item.date ? new Date(item.date).toLocaleString() : ""}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function clearAll() {
  if ($("mainInput")) $("mainInput").value = "";
  localHistory = [];
  localStorage.removeItem("ia_history");
  currentPageText = "";
  currentPageTitle = "";
  uploadedPdfFile = null;
  uploadedPdfName = "";
  uploadedImageFile = null;
  uploadedImageName = "";
  if ($("pdfFileInput")) $("pdfFileInput").value = "";
  if ($("imageFileInput")) $("imageFileInput").value = "";
  if ($("pdfFileName")) $("pdfFileName").textContent = "No PDF selected";
  if ($("imageFileName")) $("imageFileName").textContent = "No image selected";
  if ($("pageStatus")) $("pageStatus").textContent = "Ready";
  showReady("Ready");
}

// ── Mode & tools ─────────────────────────────────────────
function clearModeActive() {
  document.querySelectorAll(".mode-tab").forEach(b => b.classList.remove("active"));
}

function clearToolActive(selector) {
  document.querySelectorAll(selector).forEach(b => b.classList.remove("active"));
}

function hideTools() {
  ["studyTools","pageTools","youtubeTools","filesTools"].forEach(id => {
    const el = $(id);
    if (el) el.style.display = "none";
  });
  if ($("pdfUploadBox")) $("pdfUploadBox").style.display = "none";
  if ($("imageUploadBox")) $("imageUploadBox").style.display = "none";
}

function setMode(mode) {
  activeMode = mode;
  clearModeActive();
  hideTools();
  const title = $("panelTitle");
  const subtitle = $("panelSubtitle");
  const input = $("mainInput");
  const action = $("mainActionBtn");

  if (mode === "quick") {
    $("quickModeBtn")?.classList.add("active");
    if (title) title.textContent = "Quick Mode";
    if (subtitle) subtitle.textContent = "Fast answers with simple wording.";
    if (input) input.placeholder = "Ask anything...";
    if (action) action.textContent = "Send";
    showReady("Quick mode ready");
  } else if (mode === "deep") {
    $("deepModeBtn")?.classList.add("active");
    if (title) title.textContent = "Deep Mode";
    if (subtitle) subtitle.textContent = "Detailed answers with structure.";
    if (input) input.placeholder = "Ask a deeper question...";
    if (action) action.textContent = "Send";
    showReady("Deep mode ready");
  } else if (mode === "study") {
    $("studyModeBtn")?.classList.add("active");
    if ($("studyTools")) $("studyTools").style.display = "grid";
    if (title) title.textContent = "Study Mode";
    if (subtitle) subtitle.textContent = "Explain, notes or quiz.";
    if (input) input.placeholder = "What do you want to learn?";
    if (action) action.textContent = "Study";
    showReady("Study mode ready");
  } else if (mode === "page") {
    $("pageModeBtn")?.classList.add("active");
    if ($("pageTools")) $("pageTools").style.display = "grid";
    if (title) title.textContent = "Page Mode";
    if (subtitle) subtitle.textContent = "Read and understand this page.";
    if (input) input.placeholder = "Ask about this page...";
    if (action) action.textContent = "Ask page";
    showReady("Press Read page first");
  } else if (mode === "youtube") {
    $("youtubeModeBtn")?.classList.add("active");
    if ($("youtubeTools")) $("youtubeTools").style.display = "grid";
    if (title) title.textContent = "YouTube Mode";
    if (subtitle) subtitle.textContent = "Summarize YouTube videos.";
    if (input) input.placeholder = "Ask about this video...";
    if (action) action.textContent = "Analyze video";
    showReady("Open YouTube and press Read page");
  } else if (mode === "files") {
    $("filesModeBtn")?.classList.add("active");
    if ($("filesTools")) $("filesTools").style.display = "grid";
    if (title) title.textContent = "Files Mode";
    if (subtitle) subtitle.textContent = "Analyze PDFs and images.";
    if (input) input.placeholder = "Ask about your file...";
    if (action) action.textContent = "Analyze file";
    setFileTool(activeFileTool);
    showReady("Upload a PDF or image");
  }
}

function setStudyTool(tool) {
  activeStudyTool = tool;
  clearToolActive("#studyTools .tool-btn");
  if (tool === "explain") $("studyExplainBtn")?.classList.add("active");
  if (tool === "notes") $("studyNotesBtn")?.classList.add("active");
  if (tool === "quiz") $("studyQuizBtn")?.classList.add("active");
}

function setPageTool(tool) {
  activePageTool = tool;
  clearToolActive("#pageTools .tool-btn");
  if (tool === "page") $("pageReadBtn")?.classList.add("active");
  if (tool === "selected") $("pageSelectedBtn")?.classList.add("active");
  if (tool === "summary") $("pageSummaryBtn")?.classList.add("active");
}

function setYoutubeTool(tool) {
  activeYoutubeTool = tool;
  clearToolActive("#youtubeTools .tool-btn");
  if (tool === "summary") $("ytSummaryBtn")?.classList.add("active");
  if (tool === "notes") $("ytNotesBtn")?.classList.add("active");
  if (tool === "quiz") $("ytQuizBtn")?.classList.add("active");
}

function setFileTool(tool) {
  activeFileTool = tool;
  clearToolActive("#filesTools .tool-btn");
  if (tool === "pdf") $("filePdfBtn")?.classList.add("active");
  if (tool === "image") $("fileImageBtn")?.classList.add("active");
  if (tool === "notes") $("fileNotesBtn")?.classList.add("active");
  if ($("pdfUploadBox")) $("pdfUploadBox").style.display = (tool === "pdf" || tool === "notes") ? "block" : "none";
  if ($("imageUploadBox")) $("imageUploadBox").style.display = tool === "image" ? "block" : "none";
}

// ── Backend calls ────────────────────────────────────────
async function askBackend(input, mode) {
  if (hasReachedLimit()) {
    showResult("Limit", "Free limit reached", `You've used all ${DAILY_LIMIT} free answers today.\n\nUpgrade to Pro for unlimited answers.`);
    return null;
  }
  const res = await fetch(ASK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, mode })
  });
  const data = await res.json();
  if (!res.ok || !data?.answer) throw new Error(data?.error || "Could not get answer.");
  increaseUsage();
  updateUsageUI();
  return data;
}

async function askPdfBackend(question = "") {
  if (!uploadedPdfFile) { showResult("Files", "No PDF selected", "Upload a PDF first."); return null; }
  if (hasReachedLimit()) { showResult("Limit", "Free limit reached", "Upgrade to Pro for unlimited answers."); return null; }
  const formData = new FormData();
  formData.append("pdf", uploadedPdfFile);
  formData.append("question", question);
  formData.append("tool", activeFileTool === "notes" ? "notes" : "summary");
  const res = await fetch(ASK_PDF_URL, { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok || !data?.answer) throw new Error("Could not analyze PDF.");
  increaseUsage();
  updateUsageUI();
  return data;
}

async function askImageBackend(question = "") {
  if (!uploadedImageFile) { showResult("Files", "No image selected", "Upload an image first."); return null; }
  if (hasReachedLimit()) { showResult("Limit", "Free limit reached", "Upgrade to Pro for unlimited answers."); return null; }
  const formData = new FormData();
  formData.append("image", uploadedImageFile);
  formData.append("question", question);
  const res = await fetch(ASK_IMAGE_URL, { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok || !data?.answer) throw new Error("Could not analyze image.");
  increaseUsage();
  updateUsageUI();
  return data;
}

async function readCurrentPage() {
  try {
    if ($("pageStatus")) $("pageStatus").textContent = "Reading...";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || tab.url.startsWith("chrome://")) {
      if ($("pageStatus")) $("pageStatus").textContent = "Unsupported";
      return false;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => ({
        title: document.title || "Current page",
        url: location.href,
        selected: window.getSelection()?.toString() || "",
        text: document.body?.innerText?.slice(0, 14000) || "",
        description: document.querySelector("meta[name='description']")?.content || ""
      })
    });
    const page = results?.[0]?.result;
    if (!page?.text) { if ($("pageStatus")) $("pageStatus").textContent = "No text found"; return false; }
    currentPageTitle = page.title;
    const selectedText = page.selected?.trim();
    currentPageText = `Title:\n${page.title}\n\nURL:\n${page.url}\n\nContent:\n${activePageTool === "selected" && selectedText ? selectedText : page.text}`;
    if ($("pageStatus")) $("pageStatus").textContent = page.title.slice(0, 40);
    return true;
  } catch (e) {
    console.error("Read page error:", e);
    if ($("pageStatus")) $("pageStatus").textContent = "Failed";
    return false;
  }
}

function buildPrompt(message = "") {
  if (activeMode === "quick") return `Mode: Quick\nAnswer directly.\n\nUser:\n${message}`;
  if (activeMode === "deep") return `Mode: Deep\nGive a detailed, structured answer.\n\nUser:\n${message}`;
  if (activeMode === "study") return `Mode: Study\nTool: ${activeStudyTool}\nExplain clearly like a teacher.\n\nUser:\n${message}`;
  return message;
}

async function runMainAction() {
  if (isGenerating) return;
  const message = $("mainInput")?.value.trim() || "";
  if (!message && !["page", "youtube", "files"].includes(activeMode)) return;
  isGenerating = true;
  showLoading("Thinking...");
  try {
    let data = null;
    if (activeMode === "page" || activeMode === "youtube") {
      if (!currentPageText) {
        const loaded = await readCurrentPage();
        if (!loaded) { showResult("Page", "Could not read page", "Open a normal webpage and try again."); return; }
      }
      data = await askBackend(`Mode: Page\nCurrent page:\n${currentPageText}\n\nUser question:\n${message || "Summarize this page."}`, "page");
    } else if (activeMode === "files") {
      if (activeFileTool === "image") data = await askImageBackend(message);
      else data = await askPdfBackend(message);
    } else {
      data = await askBackend(buildPrompt(message), activeMode);
    }
    if (!data) return;
    const title = activeMode === "quick" ? "Quick Answer" : activeMode === "deep" ? "Deep Answer" : activeMode === "study" ? "Study Result" : activeMode === "page" ? "Page Result" : activeMode === "youtube" ? "YouTube Result" : "File Result";
    showResult(activeMode, title, data.answer);
    saveLocalHistory(activeMode, message || currentPageTitle || uploadedPdfName || uploadedImageName, data.answer);
    if ($("mainInput")) $("mainInput").value = "";
  } catch (e) {
    console.error(e);
    showResult("Error", "Something went wrong", e.message || "Try again.");
  } finally {
    isGenerating = false;
  }
}

async function handleReadPage() {
  if (isGenerating) return;
  isGenerating = true;
  showLoading("Reading page...");
  try {
    const loaded = await readCurrentPage();
    if (!loaded) { showResult("Page", "Could not read page", "Open a normal webpage and try again."); return; }
    showResult(activeMode === "youtube" ? "YouTube" : "Page", "Page loaded", `Loaded: ${currentPageTitle}\n\nNow ask a question or press Send.`);
  } finally {
    isGenerating = false;
  }
}

function handlePdfUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  uploadedPdfFile = file;
  uploadedPdfName = file.name;
  if ($("pdfFileName")) $("pdfFileName").textContent = `Selected: ${file.name}`;
  showResult("Files", "PDF selected", `Selected: ${file.name}`);
}

function handleImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  uploadedImageFile = file;
  uploadedImageName = file.name;
  if ($("imageFileName")) $("imageFileName").textContent = `Selected: ${file.name}`;
  showResult("Files", "Image selected", `Selected: ${file.name}`);
}

// ── Bind all buttons ─────────────────────────────────────
function bindButtons() {
  const safe = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };

  safe("upgradeBtn", upgradeToPro);
  safe("historyBtn", showHistory);
  safe("clearBtn", clearAll);

  safe("quickModeBtn", () => setMode("quick"));
  safe("deepModeBtn", () => setMode("deep"));
  safe("studyModeBtn", () => setMode("study"));
  safe("pageModeBtn", () => setMode("page"));
  safe("youtubeModeBtn", () => setMode("youtube"));
  safe("filesModeBtn", () => setMode("files"));

  safe("studyExplainBtn", () => setStudyTool("explain"));
  safe("studyNotesBtn", () => setStudyTool("notes"));
  safe("studyQuizBtn", () => setStudyTool("quiz"));

  safe("pageReadBtn", () => setPageTool("page"));
  safe("pageSelectedBtn", () => setPageTool("selected"));
  safe("pageSummaryBtn", () => setPageTool("summary"));

  safe("ytSummaryBtn", () => setYoutubeTool("summary"));
  safe("ytNotesBtn", () => setYoutubeTool("notes"));
  safe("ytQuizBtn", () => setYoutubeTool("quiz"));

  safe("filePdfBtn", () => setFileTool("pdf"));
  safe("fileImageBtn", () => setFileTool("image"));
  safe("fileNotesBtn", () => setFileTool("notes"));

  safe("mainActionBtn", runMainAction);
  safe("readPageBtn", handleReadPage);

  const pdfInput = $("pdfFileInput");
  if (pdfInput) pdfInput.addEventListener("change", handlePdfUpload);

  const imageInput = $("imageFileInput");
  if (imageInput) imageInput.addEventListener("change", handleImageUpload);

  const mainInput = $("mainInput");
  if (mainInput) {
    mainInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runMainAction(); }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindButtons();
  setMode("quick");
  updateUsageUI();
});