const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";

const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;
const ASK_PDF_URL = `${BACKEND_URL}/ask-pdf`;
const ASK_IMAGE_URL = `${BACKEND_URL}/ask-image`;
const HISTORY_URL = `${BACKEND_URL}/history`;
const MEMORY_URL = `${BACKEND_URL}/memory`;

const PRO_LINK = "https://buy.stripe.com/4gMbJ38OycALbkD3ZD3ks02";

const SUPABASE_URL = "https://aegnvyicwvgqveftryge.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFlZ252eWljd3ZncXZlZnRyeWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NTY5MzEsImV4cCI6MjA5NDMzMjkzMX0.YEdy7kzftyK3so29V6sgtj8xJDISdIdXRl5PfqRl464";

const DAILY_LIMIT = 5;

let sb = null;
let currentUser = null;
let currentSession = null;
let authMode = "login";

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

let cloudHistory = [];
let localHistory = JSON.parse(localStorage.getItem("ia_history") || "[]");

function $(id) {
  return document.getElementById(id);
}

function safeText(value = "") {
  return String(value ?? "");
}

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

function showAuthMessage(message, type = "") {
  const el = $("authMessage");
  if (!el) return;
  el.textContent = message;
  el.className = `auth-message ${type}`;
}

function showResult(label, title, body) {
  const result = $("result");
  if (!result) return;

  result.innerHTML = `
    <div class="answer-box">
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

function initSupabase() {
  try {
    if (!window.supabase) {
      showAuthMessage("Supabase file is missing.", "error");
      return false;
    }

    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return true;
  } catch (error) {
    console.error("Supabase init error:", error);
    showAuthMessage("Supabase could not start.", "error");
    return false;
  }
}

async function getSession() {
  if (!sb) return null;

  const { data } = await sb.auth.getSession();
  currentSession = data?.session || null;
  currentUser = currentSession?.user || null;

  return currentSession;
}

async function getToken() {
  const session = await getSession();
  return session?.access_token || "";
}

function getUsageKey() {
  const date = new Date().toISOString().slice(0, 10);
  const userId = currentUser?.id || "guest";
  return `ia_usage_${userId}_${date}`;
}

function getUsage() {
  return Number(localStorage.getItem(getUsageKey()) || 0);
}

function increaseUsage() {
  if (localStorage.getItem("instant_answer_pro") === "true") return;
  localStorage.setItem(getUsageKey(), String(getUsage() + 1));
}

function isPro() {
  return localStorage.getItem("instant_answer_pro") === "true";
}

function updateUsageUI() {
  const proStatus = $("proStatus");
  if (!proStatus) return;

  if (isPro()) {
    proStatus.textContent = "Pro";
  } else {
    proStatus.textContent = `Free · ${Math.max(0, DAILY_LIMIT - getUsage())}/${DAILY_LIMIT}`;
  }
}

function hasReachedLimit() {
  return !isPro() && getUsage() >= DAILY_LIMIT;
}

async function checkProStatus() {
  try {
    const token = await getToken();

    if (!token) {
      localStorage.removeItem("instant_answer_pro");
      updateUsageUI();
      return;
    }

    const res = await fetch(CHECK_PRO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const data = await res.json();

    if (data?.pro || data?.plan === "pro") {
      localStorage.setItem("instant_answer_pro", "true");
      $("upgradeBtn").textContent = "Pro";
    } else {
      localStorage.removeItem("instant_answer_pro");
      $("upgradeBtn").textContent = "Upgrade";
    }

    updateUsageUI();
  } catch (error) {
    console.error("checkProStatus error:", error);
    updateUsageUI();
  }
}

function showAuthScreen() {
  $("authScreen")?.classList.remove("hidden");
  $("mainApp")?.classList.add("hidden");
}

function showMainApp(user) {
  $("authScreen")?.classList.add("hidden");
  $("mainApp")?.classList.remove("hidden");

  const email = user?.email || "User";
  if ($("userStatus")) $("userStatus").textContent = email;

  updateUsageUI();
}

function switchAuthMode(mode) {
  authMode = mode;

  $("loginTabBtn")?.classList.remove("active");
  $("signupTabBtn")?.classList.remove("active");

  if (mode === "login") {
    $("loginTabBtn")?.classList.add("active");
    $("authNameInput")?.classList.add("hidden");
    $("forgotPasswordBtn")?.classList.remove("hidden");
    if ($("authMainBtn")) $("authMainBtn").textContent = "Login";
  } else {
    $("signupTabBtn")?.classList.add("active");
    $("authNameInput")?.classList.remove("hidden");
    $("forgotPasswordBtn")?.classList.add("hidden");
    if ($("authMainBtn")) $("authMainBtn").textContent = "Create account";
  }

  showAuthMessage("");
}

async function handleAuth() {
  try {
    if (!sb) {
      showAuthMessage("Auth is not ready.", "error");
      return;
    }

    const email = $("authEmailInput")?.value.trim();
    const password = $("authPasswordInput")?.value.trim();
    const fullName = $("authNameInput")?.value.trim();

    if (!email || !password) {
      showAuthMessage("Enter email and password.", "error");
      return;
    }

    if (password.length < 6) {
      showAuthMessage("Password must be at least 6 characters.", "error");
      return;
    }

    showAuthMessage("Loading...");

    if (authMode === "signup") {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName || email.split("@")[0]
          }
        }
      });

      if (error) {
        showAuthMessage(error.message, "error");
        return;
      }

      if (data?.session?.user) {
        currentUser = data.session.user;
        currentSession = data.session;
        showMainApp(currentUser);
        setMode("quick");
        await checkProStatus();
        await loadMemory(true);
        return;
      }

      showAuthMessage("Account created. Try login now.", "success");
      switchAuthMode("login");
      return;
    }

    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      showAuthMessage(error.message, "error");
      return;
    }

    currentUser = data.user;
    currentSession = data.session;

    showMainApp(currentUser);
    setMode("quick");
    await checkProStatus();
    await loadMemory(true);
  } catch (error) {
    console.error("Auth error:", error);
    showAuthMessage("Login/signup failed.", "error");
  }
}

async function forgotPassword() {
  if (!sb) {
    showAuthMessage("Auth is not ready.", "error");
    return;
  }

  const email = $("authEmailInput")?.value.trim();

  if (!email) {
    showAuthMessage("Enter your email first.", "error");
    return;
  }

  const { error } = await sb.auth.resetPasswordForEmail(email);

  if (error) {
    showAuthMessage(error.message, "error");
    return;
  }

  showAuthMessage("Password reset email sent.", "success");
}

async function logout() {
  if (sb) await sb.auth.signOut();

  currentUser = null;
  currentSession = null;
  localStorage.removeItem("instant_answer_pro");

  showAuthScreen();
  showAuthMessage("Logged out.", "success");
}

async function loadMemory(showWelcome = false) {
  try {
    const token = await getToken();
    if (!token) return;

    const res = await fetch(MEMORY_URL, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await res.json();
    const memory = data?.memory;

    if (!memory) return;

    const name =
      memory.full_name ||
      currentUser?.user_metadata?.full_name ||
      currentUser?.email?.split("@")[0] ||
      "User";

    if ($("userStatus")) $("userStatus").textContent = name;

    if (showWelcome) {
      showResult(
        "Welcome back",
        `Welcome back ${name}`,
        `Your AI workspace is ready.

Plan: ${isPro() ? "Pro" : "Free"}
Favorite mode: ${memory.favorite_mode || "quick"}`
      );
    }
  } catch (error) {
    console.error("Memory error:", error);
  }
}

async function loadHistory() {
  try {
    const token = await getToken();
    if (!token) return;

    const res = await fetch(HISTORY_URL, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await res.json();
    cloudHistory = Array.isArray(data?.history) ? data.history : [];
  } catch (error) {
    console.error("History error:", error);
  }
}

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

async function showHistory() {
  if (!currentUser) {
    showAuthScreen();
    return;
  }

  showLoading("Loading history");
  await loadHistory();

  const items = [
    ...cloudHistory.map(item => ({
      mode: item.mode,
      question: item.question,
      answer: item.answer,
      date: item.created_at
    })),
    ...localHistory
  ];

  if (!items.length) {
    showResult("History", "No history yet", "You have no saved chats yet.");
    return;
  }

  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">History</div>
      <div class="answer-title">Recent chats</div>
      ${items.slice(0, 25).map(item => `
        <div class="history-item">
          <strong>${escapeHTML((item.mode || "chat").toUpperCase())}</strong><br><br>
          ${escapeHTML(item.question || "")}<br><br>
          ${formatAnswer(item.answer || "")}<br><br>
          <small>${item.date ? new Date(item.date).toLocaleString() : ""}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function showPlanDashboard() {
  showResult(
    "Plan",
    "Subscription dashboard",
    `Current plan: ${isPro() ? "Pro" : "Free"}

Usage today: ${isPro() ? "Unlimited" : `${getUsage()}/${DAILY_LIMIT}`}
Remaining today: ${isPro() ? "Unlimited" : Math.max(0, DAILY_LIMIT - getUsage())}

Upgrade:
Press Upgrade to open Stripe checkout.`
  );
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

function hideTools() {
  ["studyTools", "pageTools", "youtubeTools", "filesTools"].forEach(id => {
    const el = $(id);
    if (el) el.style.display = "none";
  });

  if ($("pdfUploadBox")) $("pdfUploadBox").style.display = "none";
  if ($("imageUploadBox")) $("imageUploadBox").style.display = "none";
}

function clearModeActive() {
  document.querySelectorAll(".mode-tab").forEach(btn => {
    btn.classList.remove("active");
  });
}

function clearToolActive(selector) {
  document.querySelectorAll(selector).forEach(btn => {
    btn.classList.remove("active");
  });
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
  }

  if (mode === "deep") {
    $("deepModeBtn")?.classList.add("active");
    if (title) title.textContent = "Deep Mode";
    if (subtitle) subtitle.textContent = "Detailed answers with structure.";
    if (input) input.placeholder = "Ask a deeper question...";
    if (action) action.textContent = "Send";
    showReady("Deep mode ready");
  }

  if (mode === "study") {
    $("studyModeBtn")?.classList.add("active");
    if ($("studyTools")) $("studyTools").style.display = "grid";
    if (title) title.textContent = "Study Mode";
    if (subtitle) subtitle.textContent = "Explain, notes or quiz.";
    if (input) input.placeholder = "What do you want to learn?";
    if (action) action.textContent = "Study";
    showReady("Study mode ready");
  }

  if (mode === "page") {
    $("pageModeBtn")?.classList.add("active");
    if ($("pageTools")) $("pageTools").style.display = "grid";
    if (title) title.textContent = "Page Mode";
    if (subtitle) subtitle.textContent = "Read and understand this page.";
    if (input) input.placeholder = "Ask about this page...";
    if (action) action.textContent = "Ask page";
    showReady("Press Read page first");
  }

  if (mode === "youtube") {
    $("youtubeModeBtn")?.classList.add("active");
    if ($("youtubeTools")) $("youtubeTools").style.display = "grid";
    if (title) title.textContent = "YouTube Mode";
    if (subtitle) subtitle.textContent = "Summarize YouTube videos.";
    if (input) input.placeholder = "Ask about this video...";
    if (action) action.textContent = "Analyze video";
    showReady("Open YouTube and press Read page");
  }

  if (mode === "files") {
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

  if ($("pdfUploadBox")) {
    $("pdfUploadBox").style.display = tool === "pdf" || tool === "notes" ? "block" : "none";
  }

  if ($("imageUploadBox")) {
    $("imageUploadBox").style.display = tool === "image" ? "block" : "none";
  }
}

function upgradeToPro() {
  chrome.tabs.create({
    url: PRO_LINK
  });

  showResult(
    "Upgrade",
    "Stripe checkout opened",
    "Complete payment in the new tab. After payment, return and reopen Instant Answer."
  );
}

async function askBackend(input, mode) {
  const token = await getToken();

  if (!token) {
    showAuthScreen();
    showAuthMessage("Login first.", "error");
    return null;
  }

  if (hasReachedLimit()) {
    showResult("Limit", "Free limit reached", "You have used your free answers today. Upgrade to Pro for more access.");
    return null;
  }

  const res = await fetch(ASK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      input,
      mode
    })
  });

  const data = await res.json();

  if (!res.ok || !data?.answer) {
    throw new Error(data?.answer || data?.error || "Could not get answer.");
  }

  increaseUsage();
  updateUsageUI();
  await loadHistory();

  return data;
}

async function askPdfBackend(question = "") {
  const token = await getToken();

  if (!token) {
    showAuthScreen();
    return null;
  }

  if (!uploadedPdfFile) {
    showResult("Files", "No PDF selected", "Upload a PDF first.");
    return null;
  }

  if (hasReachedLimit()) {
    showResult("Limit", "Free limit reached", "Upgrade to Pro for more access.");
    return null;
  }

  const formData = new FormData();
  formData.append("pdf", uploadedPdfFile);
  formData.append("question", question);
  formData.append("tool", activeFileTool === "notes" ? "notes" : "summary");

  const res = await fetch(ASK_PDF_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  });

  const data = await res.json();

  if (!res.ok || !data?.answer) {
    throw new Error(data?.answer || "Could not analyze PDF.");
  }

  increaseUsage();
  updateUsageUI();

  return data;
}

async function askImageBackend(question = "") {
  const token = await getToken();

  if (!token) {
    showAuthScreen();
    return null;
  }

  if (!uploadedImageFile) {
    showResult("Files", "No image selected", "Upload an image first.");
    return null;
  }

  if (hasReachedLimit()) {
    showResult("Limit", "Free limit reached", "Upgrade to Pro for more access.");
    return null;
  }

  const formData = new FormData();
  formData.append("image", uploadedImageFile);
  formData.append("question", question);

  const res = await fetch(ASK_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  });

  const data = await res.json();

  if (!res.ok || !data?.answer) {
    throw new Error(data?.answer || "Could not analyze image.");
  }

  increaseUsage();
  updateUsageUI();

  return data;
}

async function readCurrentPage() {
  try {
    if ($("pageStatus")) $("pageStatus").textContent = "Reading page...";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id || !tab.url || tab.url.startsWith("chrome://")) {
      if ($("pageStatus")) $("pageStatus").textContent = "Unsupported page";
      return false;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => {
        return {
          title: document.title || "Current page",
          url: location.href,
          selected: window.getSelection()?.toString() || "",
          text: document.body?.innerText?.slice(0, 14000) || "",
          description: document.querySelector("meta[name='description']")?.content || ""
        };
      }
    });

    const page = results?.[0]?.result;

    if (!page?.text) {
      if ($("pageStatus")) $("pageStatus").textContent = "No text found";
      return false;
    }

    currentPageTitle = page.title;

    const selectedText = page.selected?.trim();

    currentPageText = `
Title:
${page.title}

URL:
${page.url}

Description:
${page.description || "No description"}

Content:
${activePageTool === "selected" && selectedText ? selectedText : page.text}
`;

    if ($("pageStatus")) $("pageStatus").textContent = page.title.slice(0, 40);

    return true;
  } catch (error) {
    console.error("Read page error:", error);
    if ($("pageStatus")) $("pageStatus").textContent = "Page read failed";
    return false;
  }
}

function shouldUsePageContext(message = "") {
  const text = message.toLowerCase();

  return [
    "siden",
    "denne side",
    "hvad handler siden om",
    "forklar siden",
    "artiklen",
    "article",
    "summarize this page",
    "what is this page about"
  ].some(word => text.includes(word));
}

function buildPrompt(message = "") {
  if (activeMode === "quick") {
    return `
Mode: Quick
Answer directly. Do not ask for more context unless impossible.

User:
${message}
`;
  }

  if (activeMode === "deep") {
    return `
Mode: Deep
Give a detailed, structured answer.

User:
${message}
`;
  }

  if (activeMode === "study") {
    return `
Mode: Study
Tool: ${activeStudyTool}
Explain clearly like a teacher.

User:
${message}
`;
  }

  if (activeMode === "page") {
    return `
Mode: Page
Current page:
${currentPageText}

User question:
${message || "Summarize this page."}
`;
  }

  if (activeMode === "youtube") {
    return `
Mode: YouTube
Current YouTube page:
${currentPageText}

User question:
${message || "Summarize this YouTube video."}
`;
  }

  return message;
}

async function runMainAction() {
  if (isGenerating) return;

  if (!currentUser) {
    showAuthScreen();
    showAuthMessage("Login first.", "error");
    return;
  }

  const message = $("mainInput")?.value.trim() || "";

  if (!message && !["page", "youtube", "files"].includes(activeMode)) return;

  isGenerating = true;
  showLoading("Thinking");

  try {
    let data = null;

    const autoPage = activeMode === "quick" && shouldUsePageContext(message);

    if (activeMode === "page" || activeMode === "youtube" || autoPage) {
      if (!currentPageText) {
        const loaded = await readCurrentPage();

        if (!loaded) {
          showResult("Page", "Could not read page", "Open a normal webpage and try again.");
          return;
        }
      }

      data = await askBackend(
        `
Mode: Page
Current page:
${currentPageText}

User question:
${message || "Summarize this page."}
`,
        "page"
      );
    } else if (activeMode === "files") {
      if (activeFileTool === "image") data = await askImageBackend(message);
      else data = await askPdfBackend(message);
    } else {
      data = await askBackend(buildPrompt(message), activeMode);
    }

    if (!data) return;

    const title =
      activeMode === "quick" ? "Quick Answer" :
      activeMode === "deep" ? "Deep Answer" :
      activeMode === "study" ? "Study Result" :
      activeMode === "page" ? "Page Result" :
      activeMode === "youtube" ? "YouTube Result" :
      "File Result";

    showResult(activeMode, title, data.answer);

    saveLocalHistory(
      activeMode,
      message || currentPageTitle || uploadedPdfName || uploadedImageName,
      data.answer
    );

    if ($("mainInput")) $("mainInput").value = "";
  } catch (error) {
    console.error("Run action error:", error);
    showResult("Error", "Something went wrong", error.message || "Try again.");
  } finally {
    isGenerating = false;
  }
}

async function handleReadPage() {
  if (isGenerating) return;

  if (!currentUser) {
    showAuthScreen();
    showAuthMessage("Login first.", "error");
    return;
  }

  isGenerating = true;
  showLoading("Reading page");

  try {
    const loaded = await readCurrentPage();

    if (!loaded) {
      showResult("Page", "Could not read page", "Open a normal webpage and try again.");
      return;
    }

    showResult(
      activeMode === "youtube" ? "YouTube" : "Page",
      "Page loaded",
      `Loaded: ${currentPageTitle}

Now ask a question or press Send.`
    );
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

function bindButtons() {
  $("loginTabBtn").addEventListener("click", () => switchAuthMode("login"));
  $("signupTabBtn").addEventListener("click", () => switchAuthMode("signup"));
  $("authMainBtn").addEventListener("click", handleAuth);
  $("forgotPasswordBtn").addEventListener("click", forgotPassword);

  $("quickModeBtn").addEventListener("click", () => setMode("quick"));
  $("deepModeBtn").addEventListener("click", () => setMode("deep"));
  $("studyModeBtn").addEventListener("click", () => setMode("study"));
  $("pageModeBtn").addEventListener("click", () => setMode("page"));
  $("youtubeModeBtn").addEventListener("click", () => setMode("youtube"));
  $("filesModeBtn").addEventListener("click", () => setMode("files"));

  $("studyExplainBtn").addEventListener("click", () => setStudyTool("explain"));
  $("studyNotesBtn").addEventListener("click", () => setStudyTool("notes"));
  $("studyQuizBtn").addEventListener("click", () => setStudyTool("quiz"));

  $("pageReadBtn").addEventListener("click", () => setPageTool("page"));
  $("pageSelectedBtn").addEventListener("click", () => setPageTool("selected"));
  $("pageSummaryBtn").addEventListener("click", () => setPageTool("summary"));

  $("ytSummaryBtn").addEventListener("click", () => setYoutubeTool("summary"));
  $("ytNotesBtn").addEventListener("click", () => setYoutubeTool("notes"));
  $("ytQuizBtn").addEventListener("click", () => setYoutubeTool("quiz"));

  $("filePdfBtn").addEventListener("click", () => setFileTool("pdf"));
  $("fileImageBtn").addEventListener("click", () => setFileTool("image"));
  $("fileNotesBtn").addEventListener("click", () => setFileTool("notes"));

  $("pdfFileInput").addEventListener("change", handlePdfUpload);
  $("imageFileInput").addEventListener("change", handleImageUpload);

  $("mainActionBtn").addEventListener("click", runMainAction);
  $("readPageBtn").addEventListener("click", handleReadPage);

  $("historyBtn").addEventListener("click", showHistory);
  $("clearBtn").addEventListener("click", clearAll);
  $("managePlanBtn").addEventListener("click", showPlanDashboard);
  $("upgradeBtn").addEventListener("click", upgradeToPro);
  $("logoutBtn").addEventListener("click", logout);

  $("mainInput").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runMainAction();
    }
  });

  $("authPasswordInput").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAuth();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindButtons();
  switchAuthMode("login");
  showAuthScreen();

  initSupabase();

  if (sb) {
    const session = await getSession();

    if (session?.user) {
      showMainApp(session.user);
      setMode("quick");
      await checkProStatus();
      await loadMemory(true);
    }
  }
});