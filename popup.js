const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";

const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;
const ASK_PDF_URL = `${BACKEND_URL}/ask-pdf`;
const ASK_IMAGE_URL = `${BACKEND_URL}/ask-image`;
const CHECKOUT_URL = `${BACKEND_URL}/create-checkout`;
const HISTORY_URL = `${BACKEND_URL}/history`;
const MEMORY_URL = `${BACKEND_URL}/memory`;
const BILLING_PORTAL_URL = `${BACKEND_URL}/billing-portal`;

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
      <div class="answer-content">${String(answer || "").replace(/\n/g,"<br>")}</div>
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

async function checkProStatus() {
  try {
    const token = await getAccessToken();

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

      const usage =
        Number(
          localStorage.getItem(
            `ia_usage_${new Date().toISOString().split("T")[0]}`
          ) || 0
        );

      $("proStatus").textContent =
        `Free · ${Math.max(0, DAILY_LIMIT - usage)}/${DAILY_LIMIT}`;

      $("upgradeBtn").textContent = "Upgrade";
    }
  } catch (error) {
    console.error(error);
  }
}

async function upgradeToPro() {
  try {
    const token = await getAccessToken();

    if (!token) {
      showAnswer(
        "Auth",
        "Login required",
        "Please login first."
      );
      return;
    }

    showLoading("Opening checkout");

    const response = await fetch(CHECKOUT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (data?.url) {
      chrome.tabs.create({
        url: data.url
      });

      showAnswer(
        "Upgrade",
        "Stripe checkout opened",
        "Complete payment in the new tab."
      );

      return;
    }

    chrome.tabs.create({
      url: PRO_LINK
    });

  } catch (error) {
    console.error(error);

    chrome.tabs.create({
      url: PRO_LINK
    });
  }
}

async function openBillingPortal() {
  try {
    const token = await getAccessToken();

    if (!token) {
      showAnswer(
        "Auth",
        "Login required",
        "Please login first."
      );
      return;
    }

    showLoading("Opening billing");

    const response = await fetch(BILLING_PORTAL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();

    if (data?.url) {
      chrome.tabs.create({
        url: data.url
      });

      showAnswer(
        "Billing",
        "Subscription dashboard opened",
        `You can now:

• Cancel subscription
• Update card
• Download invoices
• Switch plans
• View billing history`
      );

      return;
    }

    showAnswer(
      "Billing",
      "No subscription found",
      "Upgrade first before opening billing dashboard."
    );

  } catch (error) {
    console.error(error);

    showAnswer(
      "Billing",
      "Billing failed",
      "Could not open Stripe billing portal."
    );
  }
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
    const email =
      $("authEmailInput").value.trim();

    const password =
      $("authPasswordInput").value.trim();

    const fullName =
      $("authNameInput").value.trim();

    if (!email || !password) {
      return;
    }

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
        showAnswer(
          "Auth",
          "Signup failed",
          error.message
        );

        return;
      }

      currentUser = data.user;
    } else {
      const { data, error } =
        await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

      if (error) {
        showAnswer(
          "Auth",
          "Login failed",
          error.message
        );

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
  }
}

async function forgotPassword() {
  const email =
    $("authEmailInput").value.trim();

  if (!email) return;

  const { error } =
    await supabaseClient.auth.resetPasswordForEmail(email);

  if (error) {
    showAnswer(
      "Auth",
      "Reset failed",
      error.message
    );

    return;
  }

  showAnswer(
    "Auth",
    "Reset email sent",
    "Check your email inbox."
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

  $("managePlanBtn").onclick =
    openBillingPortal;

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
  }
});