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
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let activeMode = "quick";
let activeStudyTool = "explain";
let activePageTool = "page";
let activeYoutubeTool = "summary";
let activeFileTool = "pdf";

let isGenerating = false;
let currentUser = null;
let currentSession = null;
let authMode = "login";

let currentPageText = "";
let currentPageTitle = "";
let currentPageUrl = "";

let uploadedPdfFile = null;
let uploadedPdfName = "";
let uploadedImageFile = null;
let uploadedImageName = "";

let userMemory = null;
let cloudHistory = [];
let historyItems = JSON.parse(localStorage.getItem("ia_history") || "[]");

function $(id) {
  return document.getElementById(id);
}

function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

function escapeHTML(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatAnswer(text = "") {
  let safe = escapeHTML(text);

  safe = safe.replace(/```([\s\S]*?)```/g, (_, code) => {
    return `<pre class="code-block"><code>${escapeHTML(code.trim())}</code></pre>`;
  });

  safe = safe.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  safe = safe.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  safe = safe.replace(/^# (.*$)/gim, "<h1>$1</h1>");
  safe = safe.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  return safe.replace(/\n/g, "<br>");
}

function cleanText(text = "", limit = 14000) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
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

function showAnswer(label, title, answer, sources = []) {
  const result = $("result");
  if (!result) return;

  const sourceHTML = Array.isArray(sources) && sources.length
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

  result.innerHTML = `
    <div class="answer-box">
      <div class="answer-label">${escapeHTML(label)}</div>
      <div class="answer-title">${escapeHTML(title)}</div>
      <div class="answer-content">${formatAnswer(answer)}</div>
      ${sourceHTML}
    </div>
  `;
}

function showAuthMessage(message, type = "") {
  const el = $("authMessage");
  if (!el) return;
  el.textContent = message;
  el.className = `auth-message ${type}`;
}

async function getAccessToken() {
  const {
    data: { session }
  } = await supabaseClient.auth.getSession();

  currentSession = session || null;
  currentUser = session?.user || null;

  return session?.access_token || "";
}

function getTodayUsageKey() {
  const date = new Date().toISOString().split("T")[0];
  const userPart = currentUser?.id || "guest";
  return `ia_usage_${userPart}_${date}`;
}

function getUsage() {
  return Number(localStorage.getItem(getTodayUsageKey()) || 0);
}

function increaseUsage() {
  if (localStorage.getItem("instant_answer_pro") !== "true") {
    localStorage.setItem(getTodayUsageKey(), String(getUsage() + 1));
  }
}

function getRemainingUsage() {
  return Math.max(DAILY_LIMIT - getUsage(), 0);
}

function hasReachedLimit() {
  return getUsage() >= DAILY_LIMIT && localStorage.getItem("instant_answer_pro") !== "true";
}

function updateFreeStatus() {
  if ($("proStatus")) {
    $("proStatus").textContent = `Free · ${getRemainingUsage()}/${DAILY_LIMIT}`;
  }
}

async function checkProStatus() {
  try {
    const token = await getAccessToken();

    if (!token) {
      updateFreeStatus();
      return;
    }

    const response = await fetch(CHECK_PRO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    const isPro = data?.pro === true || data?.plan === "pro";

    if (isPro) {
      localStorage.setItem("instant_answer_pro", "true");
      if ($("proStatus")) $("proStatus").textContent = "Pro";
      if ($("upgradeBtn")) $("upgradeBtn").textContent = "Pro";
    } else {
      localStorage.removeItem("instant_answer_pro");
      updateFreeStatus();
      if ($("upgradeBtn")) $("upgradeBtn").textContent = "Upgrade";
    }
  } catch (error) {
    console.error("Pro check failed:", error);
    updateFreeStatus();
  }
}

function switchAuthMode(mode) {
  authMode = mode;

  $("loginTabBtn")?.classList.remove("active");
  $("signupTabBtn")?.classList.remove("active");

  if (mode === "login") {
    $("loginTabBtn")?.classList.add("active");
    $("authNameInput")?.classList.add("hidden");
    if ($("authMainBtn")) $("authMainBtn").textContent = "Login";
    $("forgotPasswordBtn")?.classList.remove("hidden");
  } else {
    $("signupTabBtn")?.classList.add("active");
    $("authNameInput")?.classList.remove("hidden");
    if ($("authMainBtn")) $("authMainBtn").textContent = "Create account";
    $("forgotPasswordBtn")?.classList.add("hidden");
  }

  showAuthMessage("");
}

function showMainApp(user, session = null) {
  currentUser = user;
  currentSession = session;

  $("authScreen")?.classList.add("hidden");
  $("mainApp")?.classList.remove("hidden");

  if ($("userStatus")) $("userStatus").textContent = user?.email || "User";
  updateFreeStatus();
}

function showAuthScreen() {
  currentUser = null;
  currentSession = null;
  userMemory = null;
  cloudHistory = [];

  $("mainApp")?.classList.add("hidden");
  $("authScreen")?.classList.remove("hidden");
}

async function handleAuth() {
  try {
    const email = $("authEmailInput")?.value.trim();
    const password = $("authPasswordInput")?.value.trim();
    const fullName = $("authNameInput")?.value.trim();

    if (!email || !password) {
      showAuthMessage("Missing email or password", "error");
      return;
    }

    if (password.length < 6) {
      showAuthMessage("Password must be at least 6 characters", "error");
      return;
    }

    showAuthMessage("Loading...");

    if (authMode === "signup") {
      const { data, error } = await supabaseClient.auth.signUp({
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
        showMainApp(data.session.user, data.session);
        setMode("quick");
        await checkProStatus();
        await refreshPersonalData(true);
        return;
      }

      showAuthMessage("Account created. You can login now.", "success");
      switchAuthMode("login");
      return;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      showAuthMessage(error.message, "error");
      return;
    }

    showMainApp(data.user, data.session);
    setMode("quick");
    await checkProStatus();
    await refreshPersonalData(true);
  } catch (error) {
    console.error(error);
    showAuthMessage("Authentication failed", "error");
  }
}

async function forgotPassword() {
  const email = $("authEmailInput")?.value.trim();

  if (!email) {
    showAuthMessage("Enter your email first", "error");
    return;
  }

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email);

  if (error) {
    showAuthMessage(error.message, "error");
    return;
  }

  showAuthMessage("Password reset email sent", "success");
}

async function logout() {
  await supabaseClient.auth.signOut();
  localStorage.removeItem("instant_answer_pro");
  showAuthScreen();
  showAuthMessage("Logged out", "success");
}

async function loadMemoryProfile(showWelcome = false) {
  try {
    const token = await getAccessToken();
    if (!token) return;

    const response = await fetch(MEMORY_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await response.json();

    if (!response.ok || !data?.memory) return;

    userMemory = data.memory;

    const name =
      userMemory.full_name ||
      currentUser?.user_metadata?.full_name ||
      currentUser?.email?.split("@")[0] ||
      "User";

    if ($("userStatus")) $("userStatus").textContent = name;

    if (showWelcome) {
      showAnswer(
        "Welcome back",
        `Welcome back ${name}`,
        `Your AI workspace is ready.

Current plan: ${localStorage.getItem("instant_answer_pro") === "true" ? "Pro" : "Free"}
Favorite mode: ${userMemory.favorite_mode || "quick"}
Answer style: ${userMemory.answer_style || "clear and simple"}`
      );
    }
  } catch (error) {
    console.error("Memory load failed:", error);
  }
}

async function loadCloudHistory() {
  try {
    const token = await getAccessToken();
    if (!token) return;

    const response = await fetch(HISTORY_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await response.json();
    cloudHistory = Array.isArray(data.history) ? data.history : [];
  } catch (error) {
    console.error("History load failed:", error);
  }
}

async function refreshPersonalData(showWelcome = false) {
  await loadMemoryProfile(showWelcome);
  await loadCloudHistory();
}

async function initAuth() {
  const {
    data: { session }
  } = await supabaseClient.auth.getSession();

  if (session?.user) {
    showMainApp(session.user, session);
    setMode("quick");
    await checkProStatus();
    await refreshPersonalData(true);
  } else {
    showAuthScreen();
  }

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
      showMainApp(session.user, session);
      await checkProStatus();
      await refreshPersonalData(false);
    } else {
      showAuthScreen();
    }
  });
}

function saveLocalHistory(mode, question, answer) {
  historyItems.unshift({
    mode,
    question: String(question || "").slice(0, 220),
    answer: String(answer || "").slice(0, 700),
    date: new Date().toISOString()
  });

  historyItems = historyItems.slice(0, 25);
  localStorage.setItem("ia_history", JSON.stringify(historyItems));
}

async function showHistory() {
  if (!currentUser) {
    showAuthScreen();
    showAuthMessage("Login first to see history", "error");
    return;
  }

  showLoading("Loading history");
  await loadCloudHistory();

  const allHistory = [
    ...cloudHistory.map(item => ({
      mode: item.mode,
      question: item.question,
      answer: item.answer,
      date: item.created_at
    })),
    ...historyItems
  ];

  if (!allHistory.length) {
    showAnswer("History", "No history yet", "You have no saved answers yet.");
    return;
  }

  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">Cloud History</div>
      <div class="answer-title">Recent chats</div>
      ${allHistory.slice(0, 30).map(item => `
        <div class="history-item">
          <strong>${escapeHTML(String(item.mode || "").toUpperCase())}</strong><br><br>
          ${escapeHTML(item.question || "")}<br><br>
          ${formatAnswer(item.answer || "")}
          <br><br>
          <small>${item.date ? new Date(item.date).toLocaleString() : ""}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function showPlanDashboard() {
  const isPro = localStorage.getItem("instant_answer_pro") === "true";
  const usage = getUsage();
  const remaining = Math.max(0, DAILY_LIMIT - usage);

  showAnswer(
    "Plan",
    "Subscription dashboard",
    `Current plan: ${isPro ? "Pro" : "Free"}

Usage today: ${isPro ? "Unlimited" : `${usage}/${DAILY_LIMIT}`}
Remaining today: ${isPro ? "Unlimited" : remaining}

Upgrade:
Press Upgrade to open Stripe checkout.

Cancel/manage subscription:
Disabled for now.`
  );
}

function clearAll() {
  if ($("mainInput")) $("mainInput").value = "";
  historyItems = [];
  localStorage.removeItem("ia_history");

  currentPageText = "";
  currentPageTitle = "";
  currentPageUrl = "";

  uploadedPdfFile = null;
  uploadedPdfName = "";
  uploadedImageFile = null;
  uploadedImageName = "";

  if ($("pdfFileInput")) $("pdfFileInput").value = "";
  if ($("imageFileInput")) $("imageFileInput").value = "";
  if ($("pdfFileName")) $("pdfFileName").textContent = "No PDF selected";
  if ($("imageFileName")) $("imageFileName").textContent = "No image selected";

  showReady("Ready");
}

function hideAllTools() {
  ["studyTools", "pageTools", "youtubeTools", "filesTools"].forEach(id => {
    if ($(id)) $(id).style.display = "none";
  });

  if ($("pdfUploadBox")) $("pdfUploadBox").style.display = "none";
  if ($("imageUploadBox")) $("imageUploadBox").style.display = "none";
}

function setActiveButton(groupSelector, activeId) {
  document.querySelectorAll(groupSelector).forEach(btn => {
    btn.classList.remove("active");
  });

  if ($(activeId)) $(activeId).classList.add("active");
}

function setMode(mode) {
  activeMode = mode;

  document.querySelectorAll(".mode-tab").forEach(btn => {
    btn.classList.remove("active");
  });

  hideAllTools();

  if (mode === "quick") {
    $("quickModeBtn")?.classList.add("active");
    if ($("panelTitle")) $("panelTitle").textContent = "Quick Mode";
    if ($("panelSubtitle")) $("panelSubtitle").textContent = "Fast answers with simple wording.";
    if ($("mainInput")) $("mainInput").placeholder = "Ask anything...";
    if ($("mainActionBtn")) $("mainActionBtn").textContent = "Send";
    showReady("Quick mode ready");
  }

  if (mode === "deep") {
    $("deepModeBtn")?.classList.add("active");
    if ($("panelTitle")) $("panelTitle").textContent = "Deep Mode";
    if ($("panelSubtitle")) $("panelSubtitle").textContent = "Detailed answers with structure.";
    if ($("mainInput")) $("mainInput").placeholder = "Ask a deeper question...";
    if ($("mainActionBtn")) $("mainActionBtn").textContent = "Send";
    showReady("Deep mode ready");
  }

  if (mode === "study") {
    $("studyModeBtn")?.classList.add("active");
    if ($("panelTitle")) $("panelTitle").textContent = "Study Mode";
    if ($("panelSubtitle")) $("panelSubtitle").textContent = "Explain, notes or quiz.";
    if ($("studyTools")) $("studyTools").style.display = "grid";
    if ($("mainInput")) $("mainInput").placeholder = "What do you want to learn?";
    if ($("mainActionBtn")) $("mainActionBtn").textContent = "Study";
    showReady("Study mode ready");
  }

  if (mode === "page") {
    $("pageModeBtn")?.classList.add("active");
    if ($("panelTitle")) $("panelTitle").textContent = "Page Mode";
    if ($("panelSubtitle")) $("panelSubtitle").textContent = "Read and understand this page.";
    if ($("pageTools")) $("pageTools").style.display = "grid";
    if ($("mainInput")) $("mainInput").placeholder = "Ask about this page...";
    if ($("mainActionBtn")) $("mainActionBtn").textContent = "Ask page";
    showReady("Press Read page first");
  }

  if (mode === "youtube") {
    $("youtubeModeBtn")?.classList.add("active");
    if ($("panelTitle")) $("panelTitle").textContent = "YouTube Mode";
    if ($("panelSubtitle")) $("panelSubtitle").textContent = "Summarize YouTube videos.";
    if ($("youtubeTools")) $("youtubeTools").style.display = "grid";
    if ($("mainInput")) $("mainInput").placeholder = "Ask about this video...";
    if ($("mainActionBtn")) $("mainActionBtn").textContent = "Analyze video";
    showReady("Open YouTube and press Read page");
  }

  if (mode === "files") {
    $("filesModeBtn")?.classList.add("active");
    if ($("panelTitle")) $("panelTitle").textContent = "Files Mode";
    if ($("panelSubtitle")) $("panelSubtitle").textContent = "Analyze PDFs and images.";
    if ($("filesTools")) $("filesTools").style.display = "grid";

    if ($("pdfUploadBox")) {
      $("pdfUploadBox").style.display =
        activeFileTool === "pdf" || activeFileTool === "notes" ? "block" : "none";
    }

    if ($("imageUploadBox")) {
      $("imageUploadBox").style.display =
        activeFileTool === "image" ? "block" : "none";
    }

    if ($("mainInput")) $("mainInput").placeholder = "Ask about your file...";
    if ($("mainActionBtn")) $("mainActionBtn").textContent = "Analyze file";
    showReady("Upload a PDF or image");
  }
}

function setStudyTool(tool) {
  activeStudyTool = tool;

  const ids = {
    explain: "studyExplainBtn",
    notes: "studyNotesBtn",
    quiz: "studyQuizBtn"
  };

  setActiveButton("#studyTools .tool-btn", ids[tool]);
}

function setPageTool(tool) {
  activePageTool = tool;

  const ids = {
    page: "pageReadBtn",
    selected: "pageSelectedBtn",
    summary: "pageSummaryBtn"
  };

  setActiveButton("#pageTools .tool-btn", ids[tool]);
}

function setYoutubeTool(tool) {
  activeYoutubeTool = tool;

  const ids = {
    summary: "ytSummaryBtn",
    notes: "ytNotesBtn",
    quiz: "ytQuizBtn"
  };

  setActiveButton("#youtubeTools .tool-btn", ids[tool]);
}

function setFileTool(tool) {
  activeFileTool = tool;

  const ids = {
    pdf: "filePdfBtn",
    image: "fileImageBtn",
    notes: "fileNotesBtn"
  };

  setActiveButton("#filesTools .tool-btn", ids[tool]);

  if ($("pdfUploadBox")) {
    $("pdfUploadBox").style.display =
      tool === "pdf" || tool === "notes" ? "block" : "none";
  }

  if ($("imageUploadBox")) {
    $("imageUploadBox").style.display = tool === "image" ? "block" : "none";
  }
}

async function upgradeToPro() {
  const token = await getAccessToken();

  if (!token) {
    showAnswer("Auth", "Login required", "Please login first before upgrading.");
    return;
  }

  chrome.tabs.create({ url: PRO_LINK });

  showAnswer(
    "Upgrade",
    "Stripe checkout opened",
    "Complete payment in the new tab. After payment, return to Instant Answer and reopen the extension."
  );
}

async function askBackend(input, mode) {
  const token = await getAccessToken();

  if (!token) {
    showAuthScreen();
    showAuthMessage("Login first to use Instant Answer", "error");
    return null;
  }

  if (hasReachedLimit()) {
    showAnswer(
      "Limit",
      "Free limit reached",
      "You have used your free answers today. Upgrade to Pro for more access."
    );
    return null;
  }

  const response = await fetch(ASK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      input,
      mode,
      userId: currentUser?.id || null,
      email: currentUser?.email || null
    })
  });

  const data = await response.json();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || data.error || "Could not get an answer.");
  }

  increaseUsage();
  await checkProStatus();
  await loadCloudHistory();

  return data;
}

async function askPdfBackend(question = "") {
  const token = await getAccessToken();

  if (!token) {
    showAuthScreen();
    showAuthMessage("Login first to use files", "error");
    return null;
  }

  if (!uploadedPdfFile) {
    showAnswer("Files", "No PDF selected", "Upload a PDF first.");
    return null;
  }

  if (hasReachedLimit()) {
    showAnswer("Limit", "Free limit reached", "Upgrade to Pro for more access.");
    return null;
  }

  const formData = new FormData();
  formData.append("pdf", uploadedPdfFile);
  formData.append("tool", activeFileTool === "notes" ? "notes" : "summary");
  formData.append("question", question || "");
  formData.append("userId", currentUser?.id || "");
  formData.append("email", currentUser?.email || "");

  const response = await fetch(ASK_PDF_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  });

  const data = await response.json();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || "Could not analyze PDF.");
  }

  increaseUsage();
  await checkProStatus();
  await loadCloudHistory();

  return data;
}

async function askImageBackend(question = "") {
  const token = await getAccessToken();

  if (!token) {
    showAuthScreen();
    showAuthMessage("Login first to use images", "error");
    return null;
  }

  if (!uploadedImageFile) {
    showAnswer("Files", "No image selected", "Upload an image first.");
    return null;
  }

  if (hasReachedLimit()) {
    showAnswer("Limit", "Free limit reached", "Upgrade to Pro for more access.");
    return null;
  }

  const formData = new FormData();
  formData.append("image", uploadedImageFile);
  formData.append("question", question || "");
  formData.append("userId", currentUser?.id || "");
  formData.append("email", currentUser?.email || "");

  const response = await fetch(ASK_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  });

  const data = await response.json();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || "Could not analyze image.");
  }

  increaseUsage();
  await checkProStatus();
  await loadCloudHistory();

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
        const title = document.title || "Current page";
        const url = location.href;
        const text = document.body?.innerText || "";
        const selected = window.getSelection()?.toString() || "";
        const metaDescription =
          document.querySelector("meta[name='description']")?.content || "";

        return {
          title,
          url,
          selected,
          text: text.slice(0, 14000),
          metaDescription
        };
      }
    });

    const page = results?.[0]?.result;

    if (!page?.text) {
      if ($("pageStatus")) $("pageStatus").textContent = "No readable text";
      return false;
    }

    currentPageTitle = page.title;
    currentPageUrl = page.url;

    if (activePageTool === "selected" && page.selected) {
      currentPageText = page.selected;
    } else {
      currentPageText = `
Title:
${page.title}

URL:
${page.url}

Description:
${page.metaDescription || "No description"}

Visible content:
${page.text}
`;
    }

    if ($("pageStatus")) $("pageStatus").textContent = page.title.slice(0, 45);
    return true;
  } catch (error) {
    console.error(error);
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
    "summarize this page",
    "what is this page about",
    "article",
    "artiklen"
  ].some(keyword => text.includes(keyword));
}

function buildPrompt(userMessage = "") {
  if (activeMode === "quick") {
    return `
Mode: Quick

IMPORTANT RULES:
- Always answer directly.
- Never ask for more information unless absolutely necessary.
- Sound confident and useful.
- Give the actual answer first.
- Use short but smart explanations.
- No filler text.

User:
${userMessage}
`;
  }

  if (activeMode === "deep") {
    return `
Mode: Deep
Give a stronger and detailed answer.
Use structure and practical examples.

User:
${userMessage}
`;
  }

  if (activeMode === "study") {
    return `
Mode: Study
Tool: ${activeStudyTool}

Rules:
- Explain like a good teacher.
- Use simple language.
- If tool is notes, make clean study notes.
- If tool is quiz, make questions and answers.

User:
${userMessage}
`;
  }

  if (activeMode === "page") {
    return `
Mode: Page
Tool: ${activePageTool}

Current page:
${cleanText(currentPageText, 14000)}

User question:
${userMessage || "Summarize and explain this page."}
`;
  }

  if (activeMode === "youtube") {
    return `
Mode: YouTube
Tool: ${activeYoutubeTool}

YouTube page:
${cleanText(currentPageText, 14000)}

User question:
${userMessage || "Summarize this YouTube video."}
`;
  }

  return userMessage;
}

async function runMainAction() {
  if (isGenerating) return;

  if (!currentUser) {
    showAuthScreen();
    showAuthMessage("Login first to use Instant Answer", "error");
    return;
  }

  const userMessage = $("mainInput")?.value.trim() || "";

  if (!userMessage && !["page", "youtube", "files"].includes(activeMode)) return;

  isGenerating = true;
  showLoading("Thinking");

  try {
    let data = null;

    const autoPage =
      activeMode === "quick" &&
      shouldUsePageContext(userMessage);

    if (activeMode === "page" || activeMode === "youtube" || autoPage) {
      if (!currentPageText) {
        const loaded = await readCurrentPage();

        if (!loaded) {
          showAnswer(
            "Page",
            "Could not read page",
            "Open a normal webpage or YouTube video and try again."
          );
          return;
        }
      }

      data = await askBackend(
        `
Mode: Page
Current page:
${cleanText(currentPageText, 14000)}

User question:
${userMessage || "Summarize this page."}
`,
        "page"
      );
    } else if (activeMode === "files") {
      if (activeFileTool === "image") {
        data = await askImageBackend(userMessage);
      } else {
        data = await askPdfBackend(userMessage);
      }
    } else {
      data = await askBackend(buildPrompt(userMessage), activeMode);
    }

    if (!data) return;

    const title =
      activeMode === "quick" ? "Quick Answer" :
      activeMode === "deep" ? "Deep Answer" :
      activeMode === "study" ? "Study Result" :
      activeMode === "page" ? "Page Result" :
      activeMode === "youtube" ? "YouTube Result" :
      "File Result";

    showAnswer(activeMode, title, data.answer, data.sources || []);

    saveLocalHistory(
      activeMode,
      userMessage || currentPageTitle || uploadedPdfName || uploadedImageName,
      data.answer
    );

    if ($("mainInput")) $("mainInput").value = "";
  } catch (error) {
    console.error(error);
    showAnswer("Error", "Something went wrong", error.message || "Try again.");
  } finally {
    isGenerating = false;
  }
}

async function handleReadPage() {
  if (isGenerating) return;

  if (!currentUser) {
    showAuthScreen();
    showAuthMessage("Login first to read pages", "error");
    return;
  }

  isGenerating = true;
  showLoading("Reading page");

  try {
    const loaded = await readCurrentPage();

    if (!loaded) {
      showAnswer(
        "Page",
        "Could not read page",
        "Open a normal webpage or YouTube video and try again."
      );
      return;
    }

    const label = activeMode === "youtube" ? "YouTube" : "Page";

    showAnswer(
      label,
      "Page loaded",
      `Loaded: ${currentPageTitle}

Now ask a question or press Send.`
    );
  } catch (error) {
    showAnswer("Error", "Page error", error.message || "Could not read page.");
  } finally {
    isGenerating = false;
  }
}

function handlePdfUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    uploadedPdfFile = null;
    uploadedPdfName = "";
    if ($("pdfFileName")) $("pdfFileName").textContent = "Please choose a PDF";
    showAnswer("Files", "Wrong file", "Please upload a PDF file.");
    return;
  }

  uploadedPdfFile = file;
  uploadedPdfName = file.name;

  if ($("pdfFileName")) $("pdfFileName").textContent = `Selected: ${uploadedPdfName}`;
  showAnswer("Files", "PDF selected", `Selected: ${uploadedPdfName}`);
}

function handleImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const validTypes = ["image/png", "image/jpeg", "image/webp"];

  if (!validTypes.includes(file.type)) {
    uploadedImageFile = null;
    uploadedImageName = "";
    if ($("imageFileName")) $("imageFileName").textContent = "Choose PNG, JPG or WEBP";
    showAnswer("Files", "Wrong file", "Please upload PNG, JPG or WEBP.");
    return;
  }

  uploadedImageFile = file;
  uploadedImageName = file.name;

  if ($("imageFileName")) $("imageFileName").textContent = `Selected: ${uploadedImageName}`;
  showAnswer("Files", "Image selected", `Selected: ${uploadedImageName}`);
}

document.addEventListener("DOMContentLoaded", async () => {
  switchAuthMode("login");
  showAuthScreen();

  on("loginTabBtn", "click", () => switchAuthMode("login"));
  on("signupTabBtn", "click", () => switchAuthMode("signup"));
  on("authMainBtn", "click", handleAuth);
  on("forgotPasswordBtn", "click", forgotPassword);
  on("logoutBtn", "click", logout);

  on("quickModeBtn", "click", () => setMode("quick"));
  on("deepModeBtn", "click", () => setMode("deep"));
  on("studyModeBtn", "click", () => setMode("study"));
  on("pageModeBtn", "click", () => setMode("page"));
  on("youtubeModeBtn", "click", () => setMode("youtube"));
  on("filesModeBtn", "click", () => setMode("files"));

  on("studyExplainBtn", "click", () => setStudyTool("explain"));
  on("studyNotesBtn", "click", () => setStudyTool("notes"));
  on("studyQuizBtn", "click", () => setStudyTool("quiz"));

  on("pageReadBtn", "click", () => setPageTool("page"));
  on("pageSelectedBtn", "click", () => setPageTool("selected"));
  on("pageSummaryBtn", "click", () => setPageTool("summary"));

  on("ytSummaryBtn", "click", () => setYoutubeTool("summary"));
  on("ytNotesBtn", "click", () => setYoutubeTool("notes"));
  on("ytQuizBtn", "click", () => setYoutubeTool("quiz"));

  on("filePdfBtn", "click", () => setFileTool("pdf"));
  on("fileImageBtn", "click", () => setFileTool("image"));
  on("fileNotesBtn", "click", () => setFileTool("notes"));

  on("pdfFileInput", "change", handlePdfUpload);
  on("imageFileInput", "change", handleImageUpload);

  on("mainActionBtn", "click", runMainAction);
  on("readPageBtn", "click", handleReadPage);

  on("historyBtn", "click", showHistory);
  on("clearBtn", "click", clearAll);
  on("managePlanBtn", "click", showPlanDashboard);
  on("upgradeBtn", "click", upgradeToPro);

  on("mainInput", "keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runMainAction();
    }
  });

  on("authPasswordInput", "keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAuth();
    }
  });

  await initAuth();
});