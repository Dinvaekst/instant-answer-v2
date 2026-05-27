const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";
const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;
const ASK_PDF_URL = `${BACKEND_URL}/ask-pdf`;
const ASK_IMAGE_URL = `${BACKEND_URL}/ask-image`;
const CHECKOUT_URL = `${BACKEND_URL}/create-checkout`;
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
let currentPageText = "";
let currentPageTitle = "";
let currentPageUrl = "";

let uploadedPdfFile = null;
let uploadedPdfName = "";
let uploadedImageFile = null;
let uploadedImageName = "";

let currentUser = null;
let currentSession = null;
let authMode = "login";

let historyItems = JSON.parse(localStorage.getItem("ia_history") || "[]");
let cloudHistory = [];
let userMemory = null;

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

function getDeviceId() {
  let id = localStorage.getItem("instant_answer_device_id");

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("instant_answer_device_id", id);
  }

  return id;
}

function getTodayKey() {
  const userPart = currentUser?.id || "guest";
  return `instant_answer_usage_${userPart}_${new Date().toISOString().split("T")[0]}`;
}

function getUsage() {
  return Number(localStorage.getItem(getTodayKey()) || 0);
}

function increaseUsage() {
  if (localStorage.getItem("instant_answer_pro") !== "true") {
    localStorage.setItem(getTodayKey(), String(getUsage() + 1));
  }
}

function getRemainingUsage() {
  return Math.max(DAILY_LIMIT - getUsage(), 0);
}

function hasReachedLimit() {
  return getUsage() >= DAILY_LIMIT && localStorage.getItem("instant_answer_pro") !== "true";
}

function updateProStatus() {
  const el = $("proStatus");
  if (!el) return;

  const isPro = localStorage.getItem("instant_answer_pro") === "true";
  el.textContent = isPro ? "Pro" : `Free · ${getRemainingUsage()}/${DAILY_LIMIT}`;
}

function setPageStatus(text) {
  if ($("pageStatus")) $("pageStatus").textContent = text;
}

function showLoading(text = "Thinking") {
  $("result").innerHTML = `
    <div class="loading">
      <div>${escapeHTML(text)}</div>
    </div>
  `;
}

function showAnswer(label, title, answer, sources = []) {
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

  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">${escapeHTML(label)}</div>
      <div class="answer-title">${escapeHTML(title)}</div>
      <div class="answer-content">${formatAnswer(answer)}</div>
      ${sourceHTML}
    </div>
  `;
}

function showReady(text = "Ready") {
  $("result").innerHTML = `<div class="loading">${escapeHTML(text)}</div>`;
}

function showAuthMessage(message, type = "") {
  const el = $("authMessage");
  if (!el) return;

  el.textContent = message;
  el.className = `auth-message ${type}`;
}

function switchAuthMode(mode) {
  authMode = mode;

  $("loginTabBtn").classList.remove("active");
  $("signupTabBtn").classList.remove("active");

  if (mode === "login") {
    $("loginTabBtn").classList.add("active");
    $("authMainBtn").textContent = "Login";
    $("authNameInput").classList.add("hidden");
    $("forgotPasswordBtn").classList.remove("hidden");
  } else {
    $("signupTabBtn").classList.add("active");
    $("authMainBtn").textContent = "Create account";
    $("authNameInput").classList.remove("hidden");
    $("forgotPasswordBtn").classList.add("hidden");
  }

  showAuthMessage("");
}

function showMainApp(user, session = null) {
  currentUser = user;
  currentSession = session;

  $("authScreen").classList.add("hidden");
  $("mainApp").classList.remove("hidden");

  if ($("userStatus")) {
    $("userStatus").textContent = user?.email || "User";
  }

  updateProStatus();
  setPageStatus("Ready");
}

function showAuthScreen() {
  currentUser = null;
  currentSession = null;
  userMemory = null;
  cloudHistory = [];

  $("mainApp").classList.add("hidden");
  $("authScreen").classList.remove("hidden");
}

async function handleAuth() {
  try {
    const email = $("authEmailInput").value.trim();
    const password = $("authPasswordInput").value.trim();
    const fullName = $("authNameInput").value.trim();

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
            full_name: fullName
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
        await loadMemoryProfile(true);
        await loadCloudHistory();
        return;
      }

      showAuthMessage("Account created. Check your email.", "success");
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
    await loadMemoryProfile(true);
    await loadCloudHistory();
  } catch (error) {
    console.error(error);
    showAuthMessage("Authentication failed", "error");
  }
}

async function forgotPassword() {
  const email = $("authEmailInput").value.trim();

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

async function getAccessToken() {
  const {
    data: { session }
  } = await supabaseClient.auth.getSession();

  currentSession = session || null;
  currentUser = session?.user || null;

  return session?.access_token || "";
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

    if ($("userStatus")) {
      $("userStatus").textContent = name;
    }

    if (showWelcome) {
      showAnswer(
        "Welcome back",
        `Welcome back ${name}`,
        `Your AI memory is ready.

Favorite mode: ${userMemory.favorite_mode || "quick"}
Favorite language: ${userMemory.favorite_language || "English"}
Answer style: ${userMemory.answer_style || "clear and simple"}

Ask anything or continue from your recent chats.`
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

function saveHistory(mode, question, answer) {
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

function clearAll() {
  $("mainInput").value = "";
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

  setPageStatus("Ready");
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
    $("quickModeBtn").classList.add("active");
    $("panelTitle").textContent = "Quick Mode";
    $("panelSubtitle").textContent = "Fast answers with simple wording.";
    $("mainInput").placeholder = "Ask anything...";
    $("mainActionBtn").textContent = "Quick answer";
    showReady("Quick mode ready");
  }

  if (mode === "deep") {
    $("deepModeBtn").classList.add("active");
    $("panelTitle").textContent = "Deep Mode";
    $("panelSubtitle").textContent = "Better answers with more detail and structure.";
    $("mainInput").placeholder = "Ask a deeper question...";
    $("mainActionBtn").textContent = "Deep answer";
    showReady("Deep mode ready");
  }

  if (mode === "study") {
    $("studyModeBtn").classList.add("active");
    $("panelTitle").textContent = "Study Mode";
    $("panelSubtitle").textContent = "Explain, create notes or quiz yourself.";
    $("studyTools").style.display = "grid";
    $("mainInput").placeholder = "What do you want to learn?";
    $("mainActionBtn").textContent = "Study";
    showReady("Study mode ready");
  }

  if (mode === "page") {
    $("pageModeBtn").classList.add("active");
    $("panelTitle").textContent = "Page Mode";
    $("panelSubtitle").textContent = "Read and understand the current browser page.";
    $("pageTools").style.display = "grid";
    $("mainInput").placeholder = "Ask about this page...";
    $("mainActionBtn").textContent = "Ask page";
    showReady("Open a page and press Read page");
  }

  if (mode === "youtube") {
    $("youtubeModeBtn").classList.add("active");
    $("panelTitle").textContent = "YouTube Mode";
    $("panelSubtitle").textContent = "Summarize YouTube videos, make notes and quizzes.";
    $("youtubeTools").style.display = "grid";
    $("mainInput").placeholder = "Ask about the YouTube video...";
    $("mainActionBtn").textContent = "Analyze video";
    showReady("Open a YouTube video and press Read page");
  }

  if (mode === "files") {
    $("filesModeBtn").classList.add("active");
    $("panelTitle").textContent = "Files Mode";
    $("panelSubtitle").textContent = "Analyze PDFs and images.";
    $("filesTools").style.display = "grid";
    $("pdfUploadBox").style.display = activeFileTool === "pdf" ? "block" : "none";
    $("imageUploadBox").style.display = activeFileTool === "image" ? "block" : "none";
    $("mainInput").placeholder = "Ask about your file...";
    $("mainActionBtn").textContent = "Analyze file";
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

  $("pdfUploadBox").style.display = tool === "pdf" || tool === "notes" ? "block" : "none";
  $("imageUploadBox").style.display = tool === "image" ? "block" : "none";
}

async function checkProStatus() {
  try {
    const token = await getAccessToken();

    const response = await fetch(CHECK_PRO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : ""
      },
      body: JSON.stringify({
        deviceId: getDeviceId(),
        userId: currentUser?.id || null,
        email: currentUser?.email || null
      })
    });

    const data = await response.json();

    if (data.pro || data.plan === "pro") {
      localStorage.setItem("instant_answer_pro", "true");
    } else {
      localStorage.removeItem("instant_answer_pro");
    }
  } catch (error) {
    console.error("Pro check failed:", error);
  } finally {
    updateProStatus();
  }
}

async function upgradeToPro() {
  try {
    const token = await getAccessToken();

    if (!token) {
      showAuthScreen();
      showAuthMessage("Login first to upgrade", "error");
      return;
    }

    showLoading("Opening upgrade");

    const response = await fetch(CHECKOUT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        deviceId: getDeviceId(),
        userId: currentUser?.id || null,
        email: currentUser?.email || null
      })
    });

    const data = await response.json();

    if (data.url) {
      chrome.tabs.create({ url: data.url });

      showAnswer(
        "Upgrade",
        "Stripe checkout opened",
        "Complete payment in the new tab. After payment, return to Instant Answer."
      );
    } else if (PRO_LINK) {
      chrome.tabs.create({ url: PRO_LINK });

      showAnswer(
        "Upgrade",
        "Stripe checkout opened",
        "Complete payment in the new tab. After payment, return to Instant Answer."
      );
    } else {
      showAnswer("Upgrade", "Upgrade unavailable", data.error || "Could not open Stripe checkout.");
    }
  } catch (error) {
    console.error(error);

    if (PRO_LINK) {
      chrome.tabs.create({ url: PRO_LINK });
      showAnswer("Upgrade", "Stripe checkout opened", "Complete payment in the new tab.");
      return;
    }

    showAnswer("Upgrade", "Upgrade failed", "Could not connect to checkout server.");
  }
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
      deviceId: getDeviceId(),
      userId: currentUser?.id || null,
      email: currentUser?.email || null
    })
  });

  const data = await response.json();

  if (!response.ok || !data.answer) {
    throw new Error(data.answer || data.error || "Could not get an answer.");
  }

  increaseUsage();
  updateProStatus();

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
    showAnswer(
      "Limit",
      "Free limit reached",
      "You have used your free answers today. Upgrade to Pro for more access."
    );
    return null;
  }

  const formData = new FormData();
  formData.append("pdf", uploadedPdfFile);
  formData.append("deviceId", getDeviceId());
  formData.append("userId", currentUser?.id || "");
  formData.append("email", currentUser?.email || "");
  formData.append("tool", activeFileTool === "notes" ? "notes" : "summary");
  formData.append("question", question || "");

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
  updateProStatus();

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
    showAnswer(
      "Limit",
      "Free limit reached",
      "You have used your free answers today. Upgrade to Pro for more access."
    );
    return null;
  }

  const formData = new FormData();
  formData.append("image", uploadedImageFile);
  formData.append("deviceId", getDeviceId());
  formData.append("userId", currentUser?.id || "");
  formData.append("email", currentUser?.email || "");
  formData.append("tool", "image");
  formData.append("question", question || "");

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
  updateProStatus();

  await loadCloudHistory();

  return data;
}

async function readCurrentPage() {
  try {
    setPageStatus("Reading page...");

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id || !tab.url || tab.url.startsWith("chrome://")) {
      setPageStatus("Unsupported page");
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
      setPageStatus("No readable text");
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

    setPageStatus(page.title.slice(0, 45));
    return true;
  } catch (error) {
    console.error(error);
    setPageStatus("Page read failed");
    return false;
  }
}

function buildPrompt(userMessage = "") {
  if (activeMode === "quick") {
    return `
Mode: Quick
Give a fast, clear answer.
Use simple words.
Be direct.
Maximum 6 sentences.

User:
${userMessage}
`;
  }

  if (activeMode === "deep") {
    return `
Mode: Deep
Give a stronger, more complete answer.
Use structure, examples and practical steps.
Explain the reasoning clearly.

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
- If tool is explain, explain clearly with examples.

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

Rules:
- Use the YouTube page content.
- Summarize the video clearly.
- If notes, make study notes.
- If quiz, create quiz questions and answers.
- Do not invent exact timestamps if not visible.

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

  const userMessage = $("mainInput").value.trim();

  if (!userMessage && !["page", "youtube", "files"].includes(activeMode)) return;

  isGenerating = true;
  showLoading("Thinking");

  try {
    let data = null;

    if (activeMode === "page" || activeMode === "youtube") {
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

      data = await askBackend(buildPrompt(userMessage), activeMode);
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

    saveHistory(
      activeMode,
      userMessage || currentPageTitle || uploadedPdfName || uploadedImageName,
      data.answer
    );

    $("mainInput").value = "";
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
      `Loaded: ${currentPageTitle}\n\nNow ask a question or press Send.`
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
    $("pdfFileName").textContent = "Please choose a PDF";
    showAnswer("Files", "Wrong file", "Please upload a PDF file.");
    return;
  }

  uploadedPdfFile = file;
  uploadedPdfName = file.name;

  $("pdfFileName").textContent = `Selected: ${uploadedPdfName}`;
  showAnswer(
    "Files",
    "PDF selected",
    `Selected: ${uploadedPdfName}\n\nAsk a question or press Analyze file.`
  );
}

function handleImageUpload(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  const validTypes = ["image/png", "image/jpeg", "image/webp"];

  if (!validTypes.includes(file.type)) {
    uploadedImageFile = null;
    uploadedImageName = "";
    $("imageFileName").textContent = "Choose PNG, JPG or WEBP";
    showAnswer("Files", "Wrong file", "Please upload PNG, JPG or WEBP.");
    return;
  }

  uploadedImageFile = file;
  uploadedImageName = file.name;

  $("imageFileName").textContent = `Selected: ${uploadedImageName}`;
  showAnswer(
    "Files",
    "Image selected",
    `Selected: ${uploadedImageName}\n\nAsk a question or press Analyze file.`
  );
}

document.addEventListener("DOMContentLoaded", async () => {
  switchAuthMode("login");
  showAuthScreen();

  $("loginTabBtn").onclick = () => switchAuthMode("login");
  $("signupTabBtn").onclick = () => switchAuthMode("signup");
  $("authMainBtn").onclick = handleAuth;
  $("forgotPasswordBtn").onclick = forgotPassword;
  $("logoutBtn").onclick = logout;

  $("quickModeBtn").onclick = () => setMode("quick");
  $("deepModeBtn").onclick = () => setMode("deep");
  $("studyModeBtn").onclick = () => setMode("study");
  $("pageModeBtn").onclick = () => setMode("page");
  $("youtubeModeBtn").onclick = () => setMode("youtube");
  $("filesModeBtn").onclick = () => setMode("files");

  $("studyExplainBtn").onclick = () => setStudyTool("explain");
  $("studyNotesBtn").onclick = () => setStudyTool("notes");
  $("studyQuizBtn").onclick = () => setStudyTool("quiz");

  $("pageReadBtn").onclick = () => setPageTool("page");
  $("pageSelectedBtn").onclick = () => setPageTool("selected");
  $("pageSummaryBtn").onclick = () => setPageTool("summary");

  $("ytSummaryBtn").onclick = () => setYoutubeTool("summary");
  $("ytNotesBtn").onclick = () => setYoutubeTool("notes");
  $("ytQuizBtn").onclick = () => setYoutubeTool("quiz");

  $("filePdfBtn").onclick = () => setFileTool("pdf");
  $("fileImageBtn").onclick = () => setFileTool("image");
  $("fileNotesBtn").onclick = () => setFileTool("notes");

  $("pdfFileInput").onchange = handlePdfUpload;
  $("imageFileInput").onchange = handleImageUpload;

  $("mainActionBtn").onclick = runMainAction;
  $("readPageBtn").onclick = handleReadPage;

  $("historyBtn").onclick = showHistory;
  $("clearBtn").onclick = clearAll;

  if ($("upgradeBtn")) {
    $("upgradeBtn").onclick = upgradeToPro;
  }

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

  updateProStatus();
  setPageStatus("Ready");

  await initAuth();
});