const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";
const ASK_URL = `${BACKEND_URL}/ask`;
const ASK_PDF_URL = `${BACKEND_URL}/ask-pdf`;
const ASK_IMAGE_URL = `${BACKEND_URL}/ask-image`;
const PRO_LINK = "https://buy.stripe.com/4gMbJ38OycALbkD3ZD3ks02";
const DAILY_LIMIT = 5;

const SUPABASE_URL = "https://aegnvyicwvgqveftryge.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFlZ252eWljd3ZncXZlZnRyeWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NTY5MzEsImV4cCI6MjA5NDMzMjkzMX0.YEdy7kzftyK3so29V6sgtj8xJDISdIdXRl5PfqRl464";

let sb = null;
let currentUser = null;
let authMode = "login";
let guestMode = false;

let activeMode = "quick";
let activeStudyTool = "explain";
let activePageTool = "page";
let activeYoutubeTool = "summary";
let activeFileTool = "pdf";
let activeMathTool = "solve"; // ✅ NEW
let isGenerating = false;
let currentPageText = "";
let currentPageTitle = "";
let currentYouTubeTitle = ""; // ✅ NEW
let uploadedPdfFile = null;
let uploadedPdfName = "";
let uploadedImageFile = null;
let uploadedImageName = "";
let localHistory = JSON.parse(localStorage.getItem("ia_history") || "[]");

function $(id) { return document.getElementById(id); }
function safeText(v = "") { return String(v ?? ""); }

function escapeHTML(v = "") {
  return safeText(v)
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function formatAnswer(text = "") {
  let t = escapeHTML(text);
  // Remove LaTeX: \( ... \) and \[ ... \]
  t = t.replace(/\\\\\(/g, "").replace(/\\\\\)/g, "");
  t = t.replace(/\\\\\[/g, "").replace(/\\\\\]/g, "");
  // Bold **text**
  t = t.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  // Headers
  t = t.replace(/^### (.*?)$/gm, '<span style="color:var(--accent);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-top:8px">$1</span>');
  t = t.replace(/^## (.*?)$/gm, '<span style="font-size:14px;font-weight:700;display:block;margin-top:8px">$1</span>');
  // Numbered lists
  t = t.replace(/^(\d+)\. (.*?)$/gm, '<div style="display:flex;gap:6px;margin:3px 0"><span style="color:var(--accent);font-weight:700;min-width:16px">$1.</span><span>$2</span></div>');
  // Bullets
  t = t.replace(/^[-•] (.*?)$/gm, '<div style="display:flex;gap:6px;margin:3px 0"><span style="color:var(--accent)">•</span><span>$1</span></div>');
  // Paragraph spacing
  t = t.replace(/\n\n/g, '<div style="height:7px"></div>');
  t = t.replace(/\n/g, "<br>");
  return t;
}

// ── SUPABASE ──────────────────────────────────────────────
function initSupabase() {
  try {
    if (!window.supabase) return false;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return true;
  } catch(e) { return false; }
}

async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  currentUser = data?.session?.user || null;
  return data?.session || null;
}

async function getToken() {
  const s = await getSession();
  return s?.access_token || "";
}

// ── AUTH UI ───────────────────────────────────────────────
function showAuthMessage(msg, type = "") {
  const el = $("authMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = `auth-message ${type}`;
}

function switchAuthMode(mode) {
  authMode = mode;
  $("loginTabBtn")?.classList.toggle("active", mode === "login");
  $("signupTabBtn")?.classList.toggle("active", mode === "signup");
  $("authNameInput")?.classList.toggle("hidden", mode === "login");
  $("forgotPasswordBtn")?.classList.toggle("hidden", mode === "signup");
  if ($("authMainBtn")) $("authMainBtn").textContent = mode === "login" ? "Login" : "Create account";
  showAuthMessage("");
}

function showAuthScreen() {
  $("authScreen")?.classList.remove("hidden");
  $("mainApp")?.classList.add("hidden");
}

function showMainApp(user) {
  $("authScreen")?.classList.add("hidden");
  $("mainApp")?.classList.remove("hidden");
  currentUser = user;
  if ($("logoutBtn")) $("logoutBtn").textContent = guestMode ? "Login" : "Logout";
  updateUsageUI();
}

async function handleAuth() {
  if (!sb) { showAuthMessage("Auth not ready. Try again.", "error"); return; }
  const email = $("authEmailInput")?.value.trim();
  const password = $("authPasswordInput")?.value.trim();
  const name = $("authNameInput")?.value.trim();
  if (!email || !password) { showAuthMessage("Enter email and password.", "error"); return; }
  if (password.length < 6) { showAuthMessage("Password must be at least 6 characters.", "error"); return; }
  showAuthMessage("Loading...");
  if (authMode === "signup") {
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name || email.split("@")[0] } } });
    if (error) { showAuthMessage(error.message, "error"); return; }
    if (data?.session?.user) {
      localStorage.setItem("ia_skip_auth", "false");
      guestMode = false;
      showMainApp(data.session.user);
      setMode("quick");
      await checkProStatus();
      return;
    }
    showAuthMessage("Account created! Check your email, then login.", "success");
    switchAuthMode("login");
    return;
  }
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { showAuthMessage(error.message, "error"); return; }
  localStorage.setItem("ia_skip_auth", "false");
  guestMode = false;
  showMainApp(data.user);
  setMode("quick");
  await checkProStatus();
}

async function forgotPassword() {
  if (!sb) { showAuthMessage("Auth not ready.", "error"); return; }
  const email = $("authEmailInput")?.value.trim();
  if (!email) { showAuthMessage("Enter your email first.", "error"); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email);
  if (error) { showAuthMessage(error.message, "error"); return; }
  showAuthMessage("Reset email sent! Check your inbox.", "success");
}

function skipAuth() {
  localStorage.setItem("ia_skip_auth", "true");
  guestMode = true;
  currentUser = null;
  showMainApp(null);
  setMode("quick");
}

async function logout() {
  if (guestMode) {
    localStorage.removeItem("ia_skip_auth");
    guestMode = false;
    showAuthScreen();
    return;
  }
  if (sb) await sb.auth.signOut();
  currentUser = null;
  localStorage.removeItem("ia_skip_auth");
  localStorage.removeItem("instant_answer_pro");
  showAuthScreen();
}

// ── PRO ───────────────────────────────────────────────────
function getUsageKey() {
  const date = new Date().toISOString().slice(0,10);
  const uid = currentUser?.id || "guest";
  return `ia_usage_${uid}_${date}`;
}

function getUsage() { return Number(localStorage.getItem(getUsageKey()) || 0); }
function increaseUsage() { if (isPro()) return; localStorage.setItem(getUsageKey(), String(getUsage() + 1)); }
function isPro() { return localStorage.getItem("instant_answer_pro") === "true"; }
function hasReachedLimit() { return !isPro() && getUsage() >= DAILY_LIMIT; }

function activatePro() {
  localStorage.setItem("instant_answer_pro", "true");
  updateUsageUI();
  const upgradeBtn = $("upgradeBtn");
  const alreadyPaidBtn = $("alreadyPaidBtn");
  const manageBtn = $("manageBtn");
  if (upgradeBtn) { upgradeBtn.textContent = "Pro ✓"; upgradeBtn.classList.add("is-pro"); }
  if (alreadyPaidBtn) alreadyPaidBtn.classList.add("hidden");
  if (manageBtn) manageBtn.classList.remove("hidden");
  showResult("Pro", "Pro activated! ⚡", "Welcome to Instant Answer Pro!\n\nYou now have unlimited answers.\n\nTo manage or cancel, click 'Manage'.");
}

async function manageSubscription() {
  try {
    const token = await getToken();
    if (!token) { window.open("https://billing.stripe.com", "_blank"); return; }
    showLoading("Opening billing portal...");
    const res = await fetch(`${BACKEND_URL}/billing-portal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data?.url) {
      if (typeof chrome !== "undefined" && chrome?.tabs?.create) chrome.tabs.create({ url: data.url });
      else window.open(data.url, "_blank");
      showResult("Manage", "Billing portal opened", "Manage or cancel your subscription in the new tab.");
    } else {
      showResult("Error", "Could not open portal", "Contact: karasan.business@gmail.com");
    }
  } catch(e) { showResult("Error", "Could not connect", "Try again in a moment."); }
}

function updateUsageUI() {
  const proStatus = $("proStatus");
  if (!proStatus) return;
  if (isPro()) {
    proStatus.innerHTML = '<div class="dot"></div> Pro ✓';
    proStatus.className = "status-chip pro";
  } else {
    proStatus.innerHTML = `<div class="dot"></div> Free · ${Math.max(0, DAILY_LIMIT - getUsage())}/${DAILY_LIMIT}`;
    proStatus.className = "status-chip free";
  }
}

async function checkProStatus() {
  try {
    const token = await getToken();
    if (!token) { updateUsageUI(); return; }
    const res = await fetch(`${BACKEND_URL}/check-pro`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data?.pro || data?.plan === "pro") {
      localStorage.setItem("instant_answer_pro", "true");
      const upgradeBtn = $("upgradeBtn");
      const alreadyPaidBtn = $("alreadyPaidBtn");
      const manageBtn = $("manageBtn");
      if (upgradeBtn) { upgradeBtn.textContent = "Pro ✓"; upgradeBtn.classList.add("is-pro"); }
      if (alreadyPaidBtn) alreadyPaidBtn.classList.add("hidden");
      if (manageBtn) manageBtn.classList.remove("hidden");
    } else {
      localStorage.removeItem("instant_answer_pro");
    }
    updateUsageUI();
  } catch(e) { updateUsageUI(); }
}

function upgradeToPro() {
  try {
    if (typeof chrome !== "undefined" && chrome?.tabs?.create) chrome.tabs.create({ url: PRO_LINK });
    else window.open(PRO_LINK, "_blank");
  } catch(e) { window.open(PRO_LINK, "_blank"); }
}

async function checkAlreadyPaid() {
  const email = prompt("Enter the email address you used to pay:");
  if (!email || !email.includes("@")) { showResult("Error", "Invalid email", "Please enter a valid email address."); return; }
  showLoading("Checking payment...");
  try {
    const res = await fetch(`${BACKEND_URL}/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase() })
    });
    const data = await res.json();
    if (data?.pro === true) activatePro();
    else showResult("Not found", "No payment found", `No active subscription for:\n${email}\n\nWait 1 minute after payment and try again.\n\nHelp: karasan.business@gmail.com`);
  } catch(e) { showResult("Error", "Check failed", "Could not connect. Try again."); }
}

// ── RESULT ───────────────────────────────────────────────
function showResult(label, title, body) {
  const result = $("result");
  if (!result) return;
  result.innerHTML = `
    <div>
      <div class="answer-label">${escapeHTML(label)}</div>
      <div class="answer-title">${escapeHTML(title)}</div>
      <div class="answer-content">${formatAnswer(body)}</div>
    </div>`;
}

function showLoading(text = "Thinking") {
  const result = $("result");
  if (!result) return;
  result.innerHTML = `
    <div class="loading-wrap">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <div class="loading-text">${escapeHTML(text)}</div>
    </div>`;
}

function showReady(text = "Ready") {
  const result = $("result");
  if (!result) return;
  result.innerHTML = `
    <div class="loading-wrap">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <div class="loading-text">${escapeHTML(text)}</div>
    </div>`;
}

// ── HISTORY ──────────────────────────────────────────────
function saveLocalHistory(mode, question, answer) {
  localHistory.unshift({ mode, question: safeText(question).slice(0,200), answer: safeText(answer).slice(0,700), date: new Date().toISOString() });
  localHistory = localHistory.slice(0,25);
  localStorage.setItem("ia_history", JSON.stringify(localHistory));
}

function showHistory() {
  if (!localHistory.length) { showResult("History", "No history yet", "You have no saved chats yet."); return; }
  const result = $("result");
  if (!result) return;
  result.innerHTML = `
    <div>
      <div class="answer-label">History</div>
      <div class="answer-title">Recent chats</div>
      ${localHistory.slice(0,25).map(item => `
        <div style="margin-top:10px;padding:10px;border-radius:12px;background:var(--surface3);border:1px solid var(--border)">
          <strong style="color:var(--accent);font-size:10px">${escapeHTML((item.mode||"chat").toUpperCase())}</strong><br><br>
          ${escapeHTML(item.question||"")}<br><br>
          ${formatAnswer(item.answer||"")}<br><br>
          <small style="color:var(--muted)">${item.date ? new Date(item.date).toLocaleString() : ""}</small>
        </div>`).join("")}
    </div>`;
}

function clearAll() {
  if ($("mainInput")) $("mainInput").value = "";
  localHistory = [];
  localStorage.removeItem("ia_history");
  currentPageText = ""; currentPageTitle = ""; currentYouTubeTitle = "";
  uploadedPdfFile = null; uploadedPdfName = "";
  uploadedImageFile = null; uploadedImageName = "";
  if ($("pdfFileInput")) $("pdfFileInput").value = "";
  if ($("imageFileInput")) $("imageFileInput").value = "";
  if ($("pdfFileName")) $("pdfFileName").textContent = "No PDF selected";
  if ($("imageFileName")) $("imageFileName").textContent = "No image selected";
  if ($("pageStatus")) $("pageStatus").textContent = "Ready";
  showReady("Ready");
}

// ── MODES ────────────────────────────────────────────────
function clearModeActive() { document.querySelectorAll(".mode-tab").forEach(b => b.classList.remove("active")); }
function clearToolActive(sel) { document.querySelectorAll(sel).forEach(b => b.classList.remove("active")); }

function hideTools() {
  ["studyTools","pageTools","youtubeTools","filesTools","mathTools"].forEach(id => {
    const el=$(id); if(el) el.style.display="none";
  });
  if($("pdfUploadBox")) $("pdfUploadBox").style.display="none";
  if($("imageUploadBox")) $("imageUploadBox").style.display="none";
}

function setMode(mode) {
  activeMode = mode;
  clearModeActive();
  hideTools();
  const title = $("panelTitle"), subtitle = $("panelSubtitle"), input = $("mainInput"), action = $("mainActionBtn"), icon = $("modeIcon");
  const modes = {
    quick:   { title:"Quick Mode",   sub:"Fast answers with simple wording.",         placeholder:"Ask anything...",            btn:"Send",     icon:"⚡" },
    deep:    { title:"Deep Mode",    sub:"Detailed answers with structure.",           placeholder:"Ask a deeper question...",   btn:"Send",     icon:"🔍" },
    study:   { title:"Study Mode",   sub:"Explain, take notes or quiz yourself.",     placeholder:"What do you want to learn?", btn:"Study",    icon:"📚" },
    page:    { title:"Page Mode",    sub:"Read and understand this page.",            placeholder:"Ask about this page...",     btn:"Ask page", icon:"📄" },
    youtube: { title:"YouTube Mode", sub:"Summarize YouTube videos.",                 placeholder:"Ask about this video...",    btn:"Analyze",  icon:"▶️" },
    files:   { title:"Files Mode",   sub:"Analyze PDFs and images.",                 placeholder:"Ask about your file...",     btn:"Analyze",  icon:"📎" },
    math:    { title:"Math Mode",    sub:"Solve equations and math problems.",        placeholder:"Enter a math problem...",    btn:"Solve",    icon:"🧮" },
  };
  const m = modes[mode] || modes.quick;
  if(title) title.textContent = m.title;
  if(subtitle) subtitle.textContent = m.sub;
  if(input) input.placeholder = m.placeholder;
  if(action) action.textContent = m.btn;
  if(icon) icon.textContent = m.icon;

  const btnMap = { quick:"quickModeBtn", deep:"deepModeBtn", study:"studyModeBtn", page:"pageModeBtn", youtube:"youtubeModeBtn", files:"filesModeBtn", math:"mathModeBtn" };
  $(btnMap[mode])?.classList.add("active");

  if(mode==="study" && $("studyTools")) $("studyTools").style.display="grid";
  if(mode==="page" && $("pageTools")) $("pageTools").style.display="grid";
  if(mode==="youtube" && $("youtubeTools")) $("youtubeTools").style.display="grid";
  if(mode==="files") { if($("filesTools")) $("filesTools").style.display="grid"; setFileTool(activeFileTool); }
  if(mode==="math" && $("mathTools")) $("mathTools").style.display="grid";

  const ready = {
    quick:"Quick mode ready",
    deep:"Deep mode ready",
    study:"Study mode ready",
    page:"Press Read page to load this page",
    youtube:"Open a YouTube video and press Read page",
    files:"Upload a PDF or image to analyze",
    math:"Enter any math problem — algebra, calculus, statistics"
  };
  showReady(ready[mode] || "Ready");
}

// ✅ FIX: Study tools now work correctly including quiz
function setStudyTool(tool) {
  activeStudyTool = tool;
  clearToolActive("#studyTools .tool-btn");
  if(tool==="explain") $("studyExplainBtn")?.classList.add("active");
  if(tool==="notes") $("studyNotesBtn")?.classList.add("active");
  if(tool==="quiz") $("studyQuizBtn")?.classList.add("active");
}

function setPageTool(tool) {
  activePageTool = tool;
  clearToolActive("#pageTools .tool-btn");
  if(tool==="page") $("pageReadBtn")?.classList.add("active");
  if(tool==="selected") $("pageSelectedBtn")?.classList.add("active");
  if(tool==="summary") $("pageSummaryBtn")?.classList.add("active");
}

function setYoutubeTool(tool) {
  activeYoutubeTool = tool;
  clearToolActive("#youtubeTools .tool-btn");
  if(tool==="summary") $("ytSummaryBtn")?.classList.add("active");
  if(tool==="notes") $("ytNotesBtn")?.classList.add("active");
  if(tool==="quiz") $("ytQuizBtn")?.classList.add("active");
}

function setFileTool(tool) {
  activeFileTool = tool;
  clearToolActive("#filesTools .tool-btn");
  if(tool==="pdf") $("filePdfBtn")?.classList.add("active");
  if(tool==="image") $("fileImageBtn")?.classList.add("active");
  if(tool==="notes") $("fileNotesBtn")?.classList.add("active");
  if($("pdfUploadBox")) $("pdfUploadBox").style.display=(tool==="pdf"||tool==="notes")?"block":"none";
  if($("imageUploadBox")) $("imageUploadBox").style.display=tool==="image"?"block":"none";
}

function setMathTool(tool) {
  activeMathTool = tool;
  clearToolActive("#mathTools .tool-btn");
  if(tool==="solve") $("mathSolveBtn")?.classList.add("active");
  if(tool==="explain") $("mathExplainBtn")?.classList.add("active");
  if(tool==="graph") $("mathGraphBtn")?.classList.add("active");
}

// ── BACKEND ──────────────────────────────────────────────

// ✅ Streaming ask — shows answer as it arrives
async function askBackend(input, mode) {
  if (hasReachedLimit()) {
    showResult("Limit", "Free limit reached", `You've used all ${DAILY_LIMIT} free answers today.\n\nUpgrade to Pro for unlimited answers ⚡`);
    return null;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/ask-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, mode })
    });

    if (!res.ok) throw new Error("Stream failed");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = "";
    let provider = "groq";

    const result = $("result");
    if (result) result.innerHTML = `<div><div class="answer-label">${mode}</div><div class="answer-title" id="streamTitle">Answer</div><div class="answer-content" id="streamContent"></div></div>`;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.text) {
            fullAnswer += data.text;
            const content = $("streamContent");
            if (content) content.innerHTML = formatAnswer(fullAnswer);
          }
          if (data.done) {
            provider = data.provider || "groq";
            fullAnswer = data.answer || fullAnswer;
          }
        } catch(e) { /* skip malformed */ }
      }
    }

    increaseUsage();
    updateUsageUI();
    return { answer: fullAnswer, provider };

  } catch(e) {
    // Fallback to regular ask if streaming fails
    const res = await fetch(ASK_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({input,mode}) });
    const data = await res.json();
    if(!res.ok || !data?.answer) throw new Error(data?.error || "Could not get answer.");
    increaseUsage();
    updateUsageUI();
    return data;
  }
}

async function askPdfBackend(question="") {
  if(!uploadedPdfFile) {
    showResult("Files", "No PDF selected", "Please upload a PDF file first by clicking the file input above.");
    return null;
  }
  if(hasReachedLimit()) { showResult("Limit","Free limit reached","Upgrade to Pro for unlimited answers."); return null; }
  const formData = new FormData();
  formData.append("pdf",uploadedPdfFile);
  formData.append("question",question);
  formData.append("tool",activeFileTool==="notes"?"notes":"summary");
  const res = await fetch(ASK_PDF_URL,{method:"POST",body:formData});
  const data = await res.json();
  if(!res.ok||!data?.answer) throw new Error(data?.answer || "Could not analyze PDF. Make sure it contains text (not a scanned image).");
  increaseUsage(); updateUsageUI();
  return data;
}

async function askImageBackend(question="") {
  if(!uploadedImageFile) {
    showResult("Files", "No image selected", "Please upload an image file first by clicking the file input above.");
    return null;
  }
  if(hasReachedLimit()) { showResult("Limit","Free limit reached","Upgrade to Pro for unlimited answers."); return null; }
  const formData = new FormData();
  formData.append("image",uploadedImageFile);
  formData.append("question",question);
  const res = await fetch(ASK_IMAGE_URL,{method:"POST",body:formData});
  const data = await res.json();
  if(!res.ok||!data?.answer) throw new Error(data?.answer || "Could not analyze image. Try a clearer image.");
  increaseUsage(); updateUsageUI();
  return data;
}

// ✅ NEW: Read page with better YouTube detection
async function readCurrentPage() {
  try {
    if($("pageStatus")) $("pageStatus").textContent="Reading...";
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id||!tab.url||tab.url.startsWith("chrome://")) {
      if($("pageStatus")) $("pageStatus").textContent="Unsupported page";
      return false;
    }

    const isYouTube = tab.url.includes("youtube.com/watch");

    const results = await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      function:()=>({
        title: document.title || "Current page",
        url: location.href,
        selected: window.getSelection()?.toString() || "",
        text: document.body?.innerText?.slice(0,14000) || "",
        isYouTube: location.href.includes("youtube.com/watch"),
        videoTitle: document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() || document.title || ""
      })
    });

    const page = results?.[0]?.result;
    if(!page?.text) {
      if($("pageStatus")) $("pageStatus").textContent="No text found";
      return false;
    }

    currentPageTitle = page.title;

    // ✅ YouTube title shown in status
    if(page.isYouTube && page.videoTitle) {
      currentYouTubeTitle = page.videoTitle;
      if($("pageStatus")) $("pageStatus").textContent = "▶ " + page.videoTitle.slice(0,30);
    } else {
      if($("pageStatus")) $("pageStatus").textContent = page.title.slice(0,35);
    }

    const sel = page.selected?.trim();
    currentPageText = `Title:\n${page.title}\n\nURL:\n${page.url}\n\nContent:\n${activePageTool==="selected"&&sel?sel:page.text}`;
    return true;
  } catch(e) {
    if($("pageStatus")) $("pageStatus").textContent="Failed to read page";
    return false;
  }
}

// ✅ FIX: buildPrompt now correctly handles study quiz tool
function buildPrompt(message="") {
  if(activeMode==="quick") return `Mode: Quick\nAnswer directly. 2-4 sentences max. No bullet points or headers. Just a clear direct answer.\n\nUser:\n${message}`;

  if(activeMode==="deep") return `Mode: Deep\nGive a detailed answer. Use this exact format:\n- Start with a 1-sentence summary\n- Then explain in depth with numbered sections\n- End with a key takeaway\nDo NOT use LaTeX notation. Use plain text only.\n\nUser:\n${message}`;

  if(activeMode==="study") {
    if(activeStudyTool==="explain") return `Mode: Study - Explain\nExplain this topic clearly like a great teacher.\n- Use simple language\n- Give 1-2 real examples\n- End with a one-line summary\nDo NOT use LaTeX notation.\n\nTopic:\n${message}`;

    if(activeStudyTool==="notes") return `Mode: Study - Notes\nCreate study notes in this exact format:\n\n## Key Concepts\n- Point 1\n- Point 2\n\n## Important Details\n- Detail 1\n- Detail 2\n\n## Summary\nOne sentence summary.\n\nTopic:\n${message}`;

    if(activeStudyTool==="quiz") return `Mode: Study - Quiz\nCreate exactly 5 quiz questions. Use this exact format for each:\n\n1. [Question here]\nAnswer: [Answer here]\n\n2. [Question here]\nAnswer: [Answer here]\n\n(continue for all 5)\n\nDo NOT use LaTeX. Plain text only.\n\nTopic:\n${message}`;
  }

  if(activeMode==="math") {
    if(activeMathTool==="solve") return `Mode: Math - Solve\nSolve this problem. Use this format:\n\n## Answer\n[Final answer in plain text, no LaTeX]\n\n## Step-by-step solution\n1. [First step]\n2. [Second step]\n3. [Continue...]\n\nWrite numbers and math in plain text. NO LaTeX notation like \\( or \\[.\n\nProblem:\n${message}`;

    if(activeMathTool==="explain") return `Mode: Math - Explain\nExplain this math concept in plain text. No LaTeX notation.\n\n## What it is\n[Simple explanation]\n\n## Example\n[A clear example with numbers]\n\nConcept:\n${message}`;

    if(activeMathTool==="graph") return `Mode: Math - Graph\nDescribe how to graph this. Plain text only, no LaTeX.\n\n## Key Points\n- x-intercepts: [values]\n- y-intercept: [value]\n- Key behavior: [description]\n\nEquation:\n${message}`;
  }
  return message;
}

async function runMainAction() {
  if(isGenerating) return;
  const message = $("mainInput")?.value.trim()||"";
  if(!message&&!["page","youtube","files"].includes(activeMode)) return;
  isGenerating=true;
  showLoading("Thinking...");

  try {
    let data=null;

    if(activeMode==="page"||activeMode==="youtube") {
      if(!currentPageText) {
        const loaded=await readCurrentPage();
        if(!loaded){
          showResult("Page","Could not read page","Open a normal webpage and press Read page, then try again.");
          return;
        }
      }

      // ✅ YouTube shows video title in result
      const pageLabel = activeMode==="youtube" ? `YouTube: ${currentYouTubeTitle||currentPageTitle}` : `Page: ${currentPageTitle}`;
      const tool = activeMode==="youtube" ? activeYoutubeTool : activePageTool;
      const toolInstruction = {
        summary: "Summarize the main points clearly.",
        notes: "Create organized study notes with bullet points.",
        quiz: "Create 5 quiz questions with answers based on this content.",
        page: "Answer the user's question based on the page content.",
        selected: "Answer based on the selected text.",
      }[tool] || "Summarize this content.";

      data=await askBackend(
        `Mode: ${activeMode==="youtube"?"YouTube":"Page"}\nTask: ${toolInstruction}\n\nPage content:\n${currentPageText}\n\nUser question:\n${message||toolInstruction}`,
        activeMode==="youtube"?"youtube":"page"
      );

      if(data) showResult(pageLabel, activeMode==="youtube"?"YouTube Result":"Page Result", data.answer);

    } else if(activeMode==="files") {
      if(activeFileTool==="image") data=await askImageBackend(message);
      else data=await askPdfBackend(message);
      if(data) showResult("Files", activeFileTool==="image"?"Image Analysis":"PDF Analysis", data.answer);

    } else {
      data=await askBackend(buildPrompt(message),activeMode);
      if(data) {
        const titles = {quick:"Quick Answer",deep:"Deep Answer",study:`Study — ${activeStudyTool}`,math:`Math — ${activeMathTool}`};
        showResult(activeMode, titles[activeMode]||"Answer", data.answer);
      }
    }

    if(data) {
      saveLocalHistory(activeMode, message||currentPageTitle||uploadedPdfName||uploadedImageName, data.answer);
      if($("mainInput")) $("mainInput").value="";
    }

  } catch(e) {
    showResult("Error","Something went wrong", e.message||"Please try again.");
  } finally {
    isGenerating=false;
  }
}

async function handleReadPage() {
  if(isGenerating) return;
  isGenerating=true;
  showLoading("Reading page...");
  try {
    const loaded=await readCurrentPage();
    if(!loaded){
      showResult("Page","Could not read page","Make sure you're on a normal webpage (not a Chrome settings page).");
      return;
    }
    const label = activeMode==="youtube" ? `▶ ${currentYouTubeTitle||currentPageTitle}` : currentPageTitle;
    showResult(
      activeMode==="youtube"?"YouTube loaded":"Page loaded",
      label.slice(0,60),
      `Page loaded successfully!\n\nNow ask a question or press Send to get a summary.`
    );
  } finally { isGenerating=false; }
}

function handlePdfUpload(e) {
  const file=e.target.files?.[0]; if(!file) return;
  uploadedPdfFile=file; uploadedPdfName=file.name;
  if($("pdfFileName")) $("pdfFileName").textContent=`✓ ${file.name}`;
  showResult("Files","PDF ready","PDF loaded successfully!\n\nAsk a question about it or press Send to get a summary.");
}

function handleImageUpload(e) {
  const file=e.target.files?.[0]; if(!file) return;
  uploadedImageFile=file; uploadedImageName=file.name;
  if($("imageFileName")) $("imageFileName").textContent=`✓ ${file.name}`;
  showResult("Files","Image ready","Image loaded successfully!\n\nAsk a question about it or press Send to analyze.");
}

// ── BIND ─────────────────────────────────────────────────
function bindButtons() {
  const safe=(id,fn)=>{ const el=$(id); if(el) el.addEventListener("click",fn); };

  safe("loginTabBtn",()=>switchAuthMode("login"));
  safe("signupTabBtn",()=>switchAuthMode("signup"));
  safe("authMainBtn",handleAuth);
  safe("forgotPasswordBtn",forgotPassword);
  safe("skipAuthBtn",skipAuth);

  safe("upgradeBtn",upgradeToPro);
  safe("alreadyPaidBtn",checkAlreadyPaid);
  safe("manageBtn",manageSubscription);
  safe("historyBtn",showHistory);
  safe("clearBtn",clearAll);
  safe("logoutBtn",logout);

  safe("quickModeBtn",()=>setMode("quick"));
  safe("deepModeBtn",()=>setMode("deep"));
  safe("studyModeBtn",()=>setMode("study"));
  safe("pageModeBtn",()=>setMode("page"));
  safe("youtubeModeBtn",()=>setMode("youtube"));
  safe("filesModeBtn",()=>setMode("files"));
  safe("mathModeBtn",()=>setMode("math")); // ✅ NEW

  safe("studyExplainBtn",()=>setStudyTool("explain"));
  safe("studyNotesBtn",()=>setStudyTool("notes"));
  safe("studyQuizBtn",()=>setStudyTool("quiz")); // ✅ FIXED

  safe("pageReadBtn",()=>setPageTool("page"));
  safe("pageSelectedBtn",()=>setPageTool("selected"));
  safe("pageSummaryBtn",()=>setPageTool("summary"));

  safe("ytSummaryBtn",()=>setYoutubeTool("summary"));
  safe("ytNotesBtn",()=>setYoutubeTool("notes"));
  safe("ytQuizBtn",()=>setYoutubeTool("quiz"));

  safe("filePdfBtn",()=>setFileTool("pdf"));
  safe("fileImageBtn",()=>setFileTool("image"));
  safe("fileNotesBtn",()=>setFileTool("notes"));

  safe("mathSolveBtn",()=>setMathTool("solve")); // ✅ NEW
  safe("mathExplainBtn",()=>setMathTool("explain")); // ✅ NEW
  safe("mathGraphBtn",()=>setMathTool("graph")); // ✅ NEW

  safe("mainActionBtn",runMainAction);
  safe("readPageBtn",handleReadPage);

  const pdfInput=$("pdfFileInput"); if(pdfInput) pdfInput.addEventListener("change",handlePdfUpload);
  const imgInput=$("imageFileInput"); if(imgInput) imgInput.addEventListener("change",handleImageUpload);
  const mainInput=$("mainInput");
  if(mainInput) mainInput.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();runMainAction();} });
  const pwInput=$("authPasswordInput");
  if(pwInput) pwInput.addEventListener("keydown",e=>{ if(e.key==="Enter"){e.preventDefault();handleAuth();} });
}

// ── INIT ─────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  bindButtons();
  switchAuthMode("login");

  const sbReady = initSupabase();
  const skippedAuth = localStorage.getItem("ia_skip_auth") === "true";

  if (skippedAuth) {
    guestMode = true;
    showMainApp(null);
    setMode("quick");
    updateUsageUI();
    return;
  }

  if (sbReady) {
    const session = await getSession();
    if (session?.user) {
      guestMode = false;
      showMainApp(session.user);
      setMode("quick");
      await checkProStatus();
      return;
    }
  }

  showAuthScreen();
  updateUsageUI();
});