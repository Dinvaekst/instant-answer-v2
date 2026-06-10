import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Stripe from "stripe";
import multer from "multer";
import * as pdfParse from "pdf-parse";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

dotenv.config();

const app = express();
app.use(cors());

app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "8mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const EXTENSION_ID = process.env.EXTENSION_ID || "minalbjfpcmldnlffobijmepodepndbo";

async function getUserFromToken(req) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token || !supabase) return null;
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  } catch (error) {
    console.error("Token verify error:", error);
    return null;
  }
}

async function getUserPlan(userId) {
  if (!supabase || !userId) return "free";
  const { data, error } = await supabase.from("profiles").select("plan").eq("id", userId).single();
  if (error) return "free";
  return data?.plan || "free";
}

async function getUserProfile(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) return null;
  return data || null;
}

async function getOrCreateMemoryProfile(user) {
  if (!supabase || !user?.id) return null;
  const { data: existing } = await supabase.from("memory_profiles").select("*").eq("user_id", user.id).single();
  if (existing) return existing;
  const fullName = user.user_metadata?.full_name || user.email?.split("@")?.[0] || "User";
  const { data: created, error } = await supabase.from("memory_profiles").insert({
    user_id: user.id,
    full_name: fullName,
    favorite_language: "English",
    favorite_mode: "quick",
    answer_style: "clear and simple",
    subjects: [],
    notes: ""
  }).select("*").single();
  if (error) { console.error("Create memory error:", error.message); return null; }
  return created;
}

function buildMemoryText(memory) {
  if (!memory) return "No saved memory yet.";
  return `
Name: ${memory.full_name || "Unknown"}
Favorite language: ${memory.favorite_language || "English"}
Favorite mode: ${memory.favorite_mode || "quick"}
Answer style: ${memory.answer_style || "clear and simple"}
Subjects: ${(memory.subjects || []).join(", ") || "None yet"}
Notes: ${memory.notes || "No notes yet"}
`;
}

async function saveChatHistory({ userId, mode, question, answer, provider }) {
  if (!supabase || !userId) return;
  const { error } = await supabase.from("chat_history").insert({
    user_id: userId,
    mode,
    question: String(question || "").slice(0, 12000),
    answer: String(answer || "").slice(0, 20000),
    provider: provider || "unknown"
  });
  if (error) console.error("Save chat history error:", error.message);
}

async function updateMemoryUsage({ userId, mode }) {
  if (!supabase || !userId || !mode) return;
  await supabase.from("memory_profiles").update({ favorite_mode: mode, updated_at: new Date().toISOString() }).eq("user_id", userId);
}

function cleanText(text = "") { return String(text || "").replace(/\s+/g, " ").trim(); }

function limitText(text = "", max = 14000) {
  const value = String(text || "");
  return value.length > max ? value.slice(0, max) + "\n\n[Content shortened]" : value;
}

function detectMode(mode = "") {
  const allowed = ["quick", "deep", "study", "page", "youtube", "files", "math", "smart"];
  return allowed.includes(mode) ? mode : "quick";
}

function getMaxTokens(mode, isPro) {
  if (mode === "quick") return isPro ? 600 : 350;
  if (mode === "deep") return isPro ? 3200 : 1500;
  if (mode === "study") return isPro ? 3000 : 1500;
  if (mode === "page") return isPro ? 3000 : 1500;
  if (mode === "youtube") return isPro ? 3000 : 1500;
  if (mode === "files") return isPro ? 3200 : 1600;
  return isPro ? 2500 : 1200;
}

function buildSystemPrompt(mode) {
  const base = `
You are Instant Answer AI.
Always answer in the same language as the user.
Use the saved user memory to personalize the answer naturally.
Never mention memory unless it helps the user.
Never say you need more context if the user already provided context.
Be useful, direct and clear.
Do not invent facts.
`;
  if (mode === "quick") return `${base}\nMODE: QUICK\nRules:\n- Give a short answer.\n- 3-6 sentences max unless the user asks for more.\n- Simple wording.\n- No long introductions.\n- Answer directly.\n`;
  if (mode === "deep") return `${base}\nMODE: DEEP\nRules:\n- Give a detailed answer.\n- Use clear structure.\n- Include examples when useful.\n- Explain the "why", not only the answer.\n`;
  if (mode === "study") return `${base}\nMODE: STUDY\nRules:\n- Explain like a good teacher.\n- Use simple words.\n- Make the student understand the topic.\n`;
  if (mode === "page") return `${base}\nMODE: PAGE\nRules:\n- Use the provided webpage/page text.\n- Answer based on the page.\n`;
  if (mode === "youtube") return `${base}\nMODE: YOUTUBE\nRules:\n- Use the provided YouTube page content.\n- Do not invent exact timestamps.\n`;
  if (mode === "files") return `${base}\nMODE: FILES\nRules:\n- Analyze uploaded PDFs/images clearly.\n- If text is missing, say what is missing.\n`;
  return `${base}\nMODE: GENERAL\nBe clear, useful and reliable.\n`;
}

function buildUserPrompt({ input, mode, memoryText = "" }) {
  return `\nCurrent mode: ${mode}\n\nSaved user memory:\n${memoryText || "No saved memory."}\n\nUser request and/or provided context:\n${limitText(input, 26000)}\n`;
}

async function callGroq({ prompt, systemPrompt, mode, isPro }) {
  if (!groq) throw new Error("Groq key missing");
  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: mode === "quick" ? 0.15 : 0.3,
    max_tokens: getMaxTokens(mode, isPro),
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
  });
  return completion.choices?.[0]?.message?.content?.trim();
}

async function callGemini({ prompt, systemPrompt, mode, isPro }) {
  if (!gemini) throw new Error("Gemini key missing");
  const model = gemini.getGenerativeModel({ model: mode === "quick" ? "gemini-1.5-flash" : "gemini-1.5-pro" });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }],
    generationConfig: { temperature: mode === "quick" ? 0.15 : 0.3, maxOutputTokens: getMaxTokens(mode, isPro) }
  });
  return result.response.text().trim();
}

async function callOpenAI({ prompt, systemPrompt, mode, isPro }) {
  if (!openai) throw new Error("OpenAI key missing");
  const completion = await openai.chat.completions.create({
    model: isPro ? "gpt-4o" : "gpt-4o-mini",
    temperature: mode === "quick" ? 0.15 : 0.25,
    max_tokens: getMaxTokens(mode, isPro),
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
  });
  return completion.choices?.[0]?.message?.content?.trim();
}

async function callOpenRouter({ prompt, systemPrompt, mode, isPro }) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OpenRouter key missing");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://instant-answer.local", "X-Title": "Instant Answer" },
    body: JSON.stringify({
      model: mode === "quick" ? "meta-llama/llama-3.1-8b-instruct:free" : "google/gemini-flash-1.5",
      temperature: mode === "quick" ? 0.15 : 0.3,
      max_tokens: getMaxTokens(mode, isPro),
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenRouter failed");
  return data.choices?.[0]?.message?.content?.trim();
}

async function routeAI({ prompt, systemPrompt, mode, isPro }) {
  const errors = [];
  const route = mode === "quick" ? ["groq", "gemini", "openrouter", "openai"] : ["openai", "gemini", "openrouter", "groq"];
  for (const provider of route) {
    try {
      let answer = "";
      if (provider === "groq") answer = await callGroq({ prompt, systemPrompt, mode, isPro });
      if (provider === "gemini") answer = await callGemini({ prompt, systemPrompt, mode, isPro });
      if (provider === "openai") answer = await callOpenAI({ prompt, systemPrompt, mode, isPro });
      if (provider === "openrouter") answer = await callOpenRouter({ prompt, systemPrompt, mode, isPro });
      if (answer && answer.length > 2) return { answer, provider };
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.error(`${provider} failed:`, error.message);
    }
  }
  throw new Error(`All AI providers failed. ${errors.join(" | ")}`);
}

// ── Routes ────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Instant Answer backend is running",
    version: "2.8",
    modes: ["quick", "deep", "study", "page", "youtube", "files"],
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY),
      supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    }
  });
});

app.post("/ask", async (req, res) => {
  try {
    const { input, mode = "quick" } = req.body || {};
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "Missing input", answer: "Input mangler." });
    }
    const finalMode = detectMode(mode);
    const systemPrompt = buildSystemPrompt(finalMode);
    const prompt = buildUserPrompt({ input, mode: finalMode, memoryText: "" });
    const ai = await routeAI({ prompt, systemPrompt, mode: finalMode, isPro: false });
    res.json({ answer: ai.answer, provider: ai.provider, mode: finalMode });
  } catch (error) {
    console.error("Ask error:", error);
    res.status(500).json({ error: "Server error", answer: `Fejl: ${error.message}` });
  }
});

app.post("/ask-pdf", upload.single("pdf"), async (req, res) => {
  try {
    const { tool = "summary", question = "" } = req.body || {};
    if (!req.file) return res.status(400).json({ error: "Missing PDF", answer: "Upload en PDF først." });
    let parsed;
    if (typeof pdfParse.default === "function") parsed = await pdfParse.default(req.file.buffer);
    else if (typeof pdfParse === "function") parsed = await pdfParse(req.file.buffer);
    else parsed = await pdfParse.pdf(req.file.buffer);
    const pdfText = cleanText(parsed.text || "");
    if (!pdfText || pdfText.length < 20) return res.status(400).json({ error: "Empty PDF", answer: "Kunne ikke læse PDF." });
    const mode = "files";
    const systemPrompt = buildSystemPrompt(mode);
    const prompt = buildUserPrompt({
      mode, memoryText: "",
      input: `File type: PDF\nTool: ${tool}\n\nUser question:\n${question || "Analyze this PDF."}\n\nPDF text:\n${limitText(pdfText, 14000)}`
    });
    const ai = await routeAI({ prompt, systemPrompt, mode, isPro: false });
    res.json({ answer: ai.answer, provider: ai.provider, fileName: req.file.originalname, tool });
  } catch (error) {
    console.error("PDF error:", error);
    res.status(500).json({ error: "PDF error", answer: `Fejl: ${error.message}` });
  }
});

app.post("/ask-image", upload.single("image"), async (req, res) => {
  try {
    const { question = "" } = req.body || {};
    if (!req.file) return res.status(400).json({ error: "Missing image", answer: "Upload et billede først." });
    if (!openai) return res.status(500).json({ error: "OpenAI key missing", answer: "Image analyse kræver OpenAI API key." });
    const mimeType = req.file.mimetype || "image/png";
    const base64 = req.file.buffer.toString("base64");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 1600,
      messages: [
        { role: "system", content: "You are Instant Answer Vision. Analyze the image clearly. Read visible text. Answer in the user's language." },
        { role: "user", content: [{ type: "text", text: question || "Analyze this image." }, { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }] }
      ]
    });
    const answer = completion.choices?.[0]?.message?.content?.trim() || "Kunne ikke analysere billedet.";
    res.json({ answer, provider: "openai-vision", fileName: req.file.originalname });
  } catch (error) {
    console.error("Image error:", error);
    res.status(500).json({ error: "Image error", answer: `Fejl: ${error.message}` });
  }
});

app.post("/webhook", async (req, res) => {
  if (!stripe) return res.status(400).send("Stripe not configured");
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id;
    if (userId && supabase) {
      await supabase.from("profiles").update({
        plan: "pro",
        stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null
      }).eq("id", userId);
      console.log(`Pro activated for user: ${userId}`);
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    if (customerId && supabase) {
      await supabase.from("profiles").update({ plan: "free" }).eq("stripe_customer_id", customerId);
      console.log(`Pro removed for customer: ${customerId}`);
    }
  }
  res.json({ received: true });
});

app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!stripe) return res.send("Stripe is not configured.");
  if (!sessionId) return res.send("Missing session id.");
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const userId = session.client_reference_id;
    if (userId && supabase) {
      await supabase.from("profiles").update({
        plan: "pro",
        stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null
      }).eq("id", userId);
    }
    res.send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Pro Activated</title>
          <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body { font-family:Arial,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; background:#050505; color:white; }
            .card { background:#1c1c1c; border:1px solid rgba(255,255,255,.12); padding:40px; border-radius:24px; text-align:center; max-width:400px; width:90%; }
            h1 { font-size:32px; margin-bottom:12px; }
            h1 span { color:#b7ff4a; }
            p { color:#b8b8b8; margin-bottom:28px; line-height:1.6; }
            button { background:#b7ff4a; color:#050505; border:none; padding:16px 32px; border-radius:18px; font-size:16px; font-weight:900; cursor:pointer; width:100%; }
            button:hover { opacity:0.9; }
            #done { display:none; color:#b7ff4a; font-size:18px; font-weight:900; margin-top:16px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Welcome to <span>Pro</span> ⚡</h1>
            <p>Your payment was successful!<br>Click below to activate Pro in your Instant Answer extension.</p>
            <button onclick="activatePro()">Activate Pro in Extension</button>
            <div id="done">✅ Pro activated! You can close this tab.</div>
          </div>
          <script>
            function activatePro() {
              try {
                chrome.runtime.sendMessage("${EXTENSION_ID}", { type: "PRO_ACTIVATED" }, function(response) {
                  console.log("Extension response:", response);
                });
              } catch(e) {
                console.log("Extension message error:", e);
              }
              document.querySelector("button").style.display = "none";
              document.getElementById("done").style.display = "block";
              setTimeout(() => window.close(), 3000);
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Stripe success error:", error);
    res.send("Could not verify payment.");
  }
});

app.post("/check-pro", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const profile = await getUserProfile(user.id);
    const plan = profile?.plan || "free";
    res.json({ pro: plan === "pro", plan, stripe_customer_id: profile?.stripe_customer_id || null });
  } catch (error) {
    res.status(500).json({ error: "Check failed" });
  }
});

app.get("/memory", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const memory = await getOrCreateMemoryProfile(user);
    res.json({ memory });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch memory" });
  }
});

app.get("/history", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const limit = Math.min(Number(req.query.limit || 30), 50);
    const { data, error } = await supabase.from("chat_history").select("id, mode, question, answer, provider, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch history" });
  }
});

// ✅ NEW: Latest session endpoint — checks if there's a recent payment (last 30 min)
app.get("/latest-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ pro: false, error: "Stripe not configured" });

    const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - 30 * 60;

    const sessions = await stripe.checkout.sessions.list({
      limit: 5,
      created: { gte: thirtyMinutesAgo }
    });

    const completed = sessions.data.find(s => s.payment_status === "paid");

    if (!completed) {
      return res.json({ pro: false });
    }

    res.json({ pro: true, session_id: completed.id });
  } catch (error) {
    console.error("Latest session error:", error);
    res.status(500).json({ pro: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Instant Answer backend running on port ${PORT}`);
});