const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";

const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;
const ASK_PDF_URL = `${BACKEND_URL}/ask-pdf`;
const ASK_IMAGE_URL = `${BACKEND_URL}/ask-image`;
const HISTORY_URL = `${BACKEND_URL}/history`;
const MEMORY_URL = `${BACKEND_URL}/memory`;

const PRO_LINK = "https://buy.stripe.com/4gMbJ38OycALbkD3ZD3ks02";

const SUPABASE_URL =
  "https://aegnvyicwvgqveftryge.supabase.co";

const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFlZ252eWljd3ZncXZlZnRyeWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NTY5MzEsImV4cCI6MjA5NDMzMjkzMX0.YEdy7kzftyK3so29V6sgtj8xJDISdIdXRl5PfqRl464";

const DAILY_LIMIT = 5;

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

let activeMode = "quick";
let currentUser = null;
let currentSession = null;

function $(id) {
  return document.getElementById(id);
}

function escapeHTML(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function showLoading(text = "Loading") {
  $("result").innerHTML = `
    <div class="loading">
      ${escapeHTML(text)}
    </div>
  `;
}

function showAnswer(label, title, answer) {
  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">${escapeHTML(label)}</div>
      <div class="answer-title">${escapeHTML(title)}</div>
      <div class="answer-content">${String(answer || "").replace(/\n/g, "<br>")}</div>
    </div>
  `;
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

function updateFreeStatus() {
  const usage = getUsage();
  $("proStatus").textContent =
    `Free · ${Math.max(0, DAILY_LIMIT - usage)}/${DAILY_LIMIT}`;
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

    const isPro =
      data?.pro === true ||
      data?.plan === "pro";

    if (isPro) {
      localStorage.setItem("instant_answer_pro", "true");
      $("proStatus").textContent = "Pro";
      $("upgradeBtn").textContent = "Pro";
    } else {
      localStorage.removeItem("instant_answer_pro");
      updateFreeStatus();
      $("upgradeBtn").textContent = "Upgrade";
    }
  } catch (error) {
    console.error(error);
    updateFreeStatus();
  }
}

async function upgradeToPro() {
  const token = await getAccessToken();

  if (!token) {
    showAnswer(
      "Auth",
      "Login required",
      "Please login first before upgrading."
    );
    return;
  }

  chrome.tabs.create({
    url: PRO_LINK
  });

  showAnswer(
    "Upgrade",
    "Stripe checkout opened",
    "Complete payment in the new tab. After payment, return to Instant Answer and reopen the extension."
  );
}

async function logout() {
  await supabaseClient.auth.signOut();

  currentUser = null;
  currentSession = null;

  $("mainApp").classList.add("hidden");
  $("authScreen").classList.remove("hidden");
}

function switchAuthMode(mode) {
  if (mode === "login") {
    $("loginTabBtn").classList.add("active");
    $("signupTabBtn").classList.remove("active");
    $("authNameInput").classList.add("hidden");
    $("authMainBtn").textContent = "Login";
  } else {
    $("signupTabBtn").classList.add("active");
    $("loginTabBtn").classList.remove("active");
    $("authNameInput").classList.remove("hidden");
    $("authMainBtn").textContent = "Create account";
  }

  window.__authMode = mode;
}

async function handleAuth() {
  try {
    const email = $("authEmailInput").value.trim();
    const password = $("authPasswordInput").value.trim();
    const fullName = $("authNameInput").value.trim();

    if (!email || !password) return;

    if (window.__authMode === "signup") {
      const { data, error } =
        await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName
            }
          }
        });

      if (error) {
        showAnswer("Auth", "Signup failed", error.message);
        return;
      }

      currentUser = data.user;
      currentSession = data.session || null;
    } else {
      const { data, error } =
        await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

      if (error) {
        showAnswer("Auth", "Login failed", error.message);
        return;
      }

      currentUser = data.user;
      currentSession = data.session;
    }

    $("authScreen").classList.add("hidden");
    $("mainApp").classList.remove("hidden");

    $("userStatus").textContent =
      currentUser?.email || "User";

    await checkProStatus();

    showAnswer(
      "Welcome",
      "Welcome back",
      "Your AI workspace is ready."
    );

  } catch (error) {
    console.error(error);
    showAnswer("Auth", "Auth error", "Something went wrong.");
  }
}

async function forgotPassword() {
  const email = $("authEmailInput").value.trim();

  if (!email) return;

  const { error } =
    await supabaseClient.auth.resetPasswordForEmail(email);

  if (error) {
    showAnswer("Auth", "Reset failed", error.message);
    return;
  }

  showAnswer(
    "Auth",
    "Reset email sent",
    "Check your email inbox."
  );
}

function showPlanDashboard() {
  const isPro =
    localStorage.getItem("instant_answer_pro") === "true";

  const usage = getUsage();
  const remaining = Math.max(0, DAILY_LIMIT - usage);

  showAnswer(
    "Plan",
    "Subscription dashboard",
    `Current plan: ${isPro ? "Pro" : "Free"}

Usage today: ${isPro ? "Unlimited" : `${usage}/${DAILY_LIMIT}`}
Remaining today: ${isPro ? "Unlimited" : remaining}

Upgrade:
Press the Upgrade button to open Stripe checkout.

Note:
Cancel/manage subscription is disabled for now.`
  );
}

document.addEventListener("DOMContentLoaded", async () => {
  switchAuthMode("login");

  $("loginTabBtn").onclick = () =>
    switchAuthMode("login");

  $("signupTabBtn").onclick = () =>
    switchAuthMode("signup");

  $("authMainBtn").onclick = handleAuth;

  $("forgotPasswordBtn").onclick =
    forgotPassword;

  $("upgradeBtn").onclick =
    upgradeToPro;

  if ($("managePlanBtn")) {
    $("managePlanBtn").onclick =
      showPlanDashboard;
  }

  $("logoutBtn").onclick =
    logout;

  const {
    data: { session }
  } = await supabaseClient.auth.getSession();

  if (session?.user) {
    currentUser = session.user;
    currentSession = session;

    $("authScreen").classList.add("hidden");
    $("mainApp").classList.remove("hidden");

    $("userStatus").textContent =
      currentUser?.email || "User";

    await checkProStatus();

    showAnswer(
      "Welcome back",
      "Instant Answer ready",
      "Your AI workspace is loaded."
    );
  } else {
    $("mainApp").classList.add("hidden");
    $("authScreen").classList.remove("hidden");
  }
});