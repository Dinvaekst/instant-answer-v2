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
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "8mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const EXTENSION_ID = process.env.EXTENSION_ID || "minalbjfpcmldnlffobijmepodepndbo";

// ── RATE LIMITING ─────────────────────────────────────────
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 30;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }

  const record = rateLimitMap.get(ip);
  if (now - record.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }

  if (record.count >= maxRequests) return false;
  record.count++;
  return true;
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.start > 60 * 1000) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment.", answer: "You're sending too many requests. Please wait 1 minute and try again." });
  }
  next();
}

// ── AUTH ──────────────────────────────────────────────────
async function getUserFromToken(req) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token || !supabase) return null;
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  } catch (e) { return null; }
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
    user_id: user.id, full_name: fullName, favorite_language: "English",
    favorite_mode: "quick", answer_style: "clear and simple", subjects: [], notes: ""
  }).select("*").single();
  if (error) { console.error("Create memory error:", error.message); return null; }
  return created;
}

function buildMemoryText(memory) {
  if (!memory) return "No saved memory yet.";
  return `Name: ${memory.full_name || "Unknown"}\nFavorite language: ${memory.favorite_language || "English"}\nFavorite mode: ${memory.favorite_mode || "quick"}\nAnswer style: ${memory.answer_style || "clear and simple"}`;
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
  if (mode === "math") return isPro ? 2000 : 1000;
  return isPro ? 3000 : 1500;
}

function buildSystemPrompt(mode) {
  const base = `You are Instant Answer AI. Always answer in the same language as the user. Be useful, direct and clear. Do not invent facts.\n`;
  if (mode === "quick") return `${base}MODE: QUICK\n- Give a short, direct answer.\n- 3-6 sentences max.\n- No long introductions.\n`;
  if (mode === "deep") return `${base}MODE: DEEP\n- Give a detailed, well-structured answer.\n- Use headers and examples.\n- Explain the why.\n`;
  if (mode === "study") return `${base}MODE: STUDY\n- Explain like a great teacher.\n- Use simple words and examples.\n- Make the student truly understand.\n`;
  if (mode === "page") return `${base}MODE: PAGE\n- Use the provided webpage text to answer.\n- Stay accurate to the source.\n`;
  if (mode === "youtube") return `${base}MODE: YOUTUBE\n- Use the provided YouTube content.\n- Do not invent timestamps.\n`;
  if (mode === "files") return `${base}MODE: FILES\n- Analyze the uploaded content clearly.\n- If text is missing or unclear, say so.\n`;
  if (mode === "math") return `${base}MODE: MATH\n- Solve step by step, showing all working.\n- Give the final answer clearly on its own line.\n- Use clear mathematical notation.\n`;
  return `${base}Be clear and reliable.\n`;
}

function buildUserPrompt({ input, mode, memoryText = "" }) {
  return `Current mode: ${mode}\n\nSaved user memory:\n${memoryText || "No saved memory."}\n\nUser request:\n${limitText(input, 26000)}`;
}

// ── AI PROVIDERS ──────────────────────────────────────────

// ✅ Claude — primary AI (best quality)
async function callClaude({ prompt, systemPrompt, mode, isPro }) {
  if (!anthropic) throw new Error("Anthropic key missing");
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: getMaxTokens(mode, isPro),
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }]
  });
  return message.content?.[0]?.text?.trim();
}

// ✅ Claude streaming
async function callClaudeStream(res, prompt, systemPrompt, mode, isPro) {
  if (!anthropic) throw new Error("Anthropic key missing");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullAnswer = "";

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: getMaxTokens(mode, isPro),
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }]
  });

  stream.on("text", (text) => {
    fullAnswer += text;
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
  });

  await stream.finalMessage();
  res.write(`data: ${JSON.stringify({ done: true, answer: fullAnswer, provider: "claude" })}\n\n`);
  res.end();
  return fullAnswer;
}

async function callGroqStream(res, prompt, systemPrompt, mode, isPro) {
  if (!groq) throw new Error("Groq key missing");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const stream = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: mode === "quick" ? 0.15 : 0.3,
    max_tokens: getMaxTokens(mode, isPro),
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
    stream: true
  });
  let fullAnswer = "";
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content || "";
    if (text) { fullAnswer += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); }
  }
  res.write(`data: ${JSON.stringify({ done: true, answer: fullAnswer, provider: "groq" })}\n\n`);
  res.end();
  return fullAnswer;
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
      model: "google/gemini-flash-1.5",
      temperature: 0.3,
      max_tokens: getMaxTokens(mode, isPro),
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenRouter failed");
  return data.choices?.[0]?.message?.content?.trim();
}

// ✅ Route: Claude first, then Groq, then others
async function routeAI({ prompt, systemPrompt, mode, isPro }) {
  const errors = [];
  // Quick mode: Groq first (fastest), Claude fallback
  // Deep/Study/Math: Claude first (best quality), Groq fallback
  const route = mode === "quick"
    ? ["groq", "claude", "gemini", "openrouter", "openai"]
    : ["claude", "groq", "gemini", "openrouter", "openai"];
  for (const provider of route) {
    try {
      let answer = "";
      if (provider === "claude") answer = await callClaude({ prompt, systemPrompt, mode, isPro });
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
    status: "ok", message: "Instant Answer backend running", version: "3.0",
    providers: {
      claude: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY)
    }
  });
});

// ✅ Streaming — Claude first, Groq fallback
app.post("/ask-stream", rateLimit, async (req, res) => {
  try {
    const { input, mode = "quick" } = req.body || {};
    if (!input || typeof input !== "string") return res.status(400).json({ error: "Missing input" });
    const finalMode = detectMode(mode);
    const systemPrompt = buildSystemPrompt(finalMode);
    const prompt = buildUserPrompt({ input, mode: finalMode, memoryText: "" });

    // Quick = Groq (fast), Deep/Study/Math = Claude (quality)
    if (finalMode === "quick" && groq) {
      await callGroqStream(res, prompt, systemPrompt, finalMode, false);
    } else if (anthropic) {
      await callClaudeStream(res, prompt, systemPrompt, finalMode, false);
    } else if (groq) {
      await callGroqStream(res, prompt, systemPrompt, finalMode, false);
    } else {
      const ai = await routeAI({ prompt, systemPrompt, mode: finalMode, isPro: false });
      res.json({ answer: ai.answer, provider: ai.provider });
    }
  } catch (error) {
    console.error("Stream error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message, answer: "Something went wrong. Please try again." });
  }
});

app.post("/ask", rateLimit, async (req, res) => {
  try {
    const { input, mode = "quick" } = req.body || {};
    if (!input || typeof input !== "string") return res.status(400).json({ error: "Missing input", answer: "Input is missing." });
    const finalMode = detectMode(mode);
    const systemPrompt = buildSystemPrompt(finalMode);
    const prompt = buildUserPrompt({ input, mode: finalMode, memoryText: "" });
    const ai = await routeAI({ prompt, systemPrompt, mode: finalMode, isPro: false });
    res.json({ answer: ai.answer, provider: ai.provider, mode: finalMode });
  } catch (error) {
    console.error("Ask error:", error);
    res.status(500).json({ error: "Server error", answer: "Something went wrong. Please try again in a moment." });
  }
});

app.post("/ask-pdf", rateLimit, upload.single("pdf"), async (req, res) => {
  try {
    const { tool = "summary", question = "" } = req.body || {};
    if (!req.file) return res.status(400).json({ error: "Missing PDF", answer: "Please upload a PDF file first." });
    let parsed;
    if (typeof pdfParse.default === "function") parsed = await pdfParse.default(req.file.buffer);
    else if (typeof pdfParse === "function") parsed = await pdfParse(req.file.buffer);
    else parsed = await pdfParse.pdf(req.file.buffer);
    const pdfText = cleanText(parsed.text || "");
    if (!pdfText || pdfText.length < 20) return res.status(400).json({ error: "Empty PDF", answer: "Could not read this PDF. Make sure it contains actual text (not a scanned image). Try a different PDF." });
    const mode = "files";
    const systemPrompt = buildSystemPrompt(mode);
    const prompt = buildUserPrompt({ mode, memoryText: "", input: `File type: PDF\nTool: ${tool}\n\nUser question:\n${question || "Analyze this PDF."}\n\nPDF text:\n${limitText(pdfText, 14000)}` });
    const ai = await routeAI({ prompt, systemPrompt, mode, isPro: false });
    res.json({ answer: ai.answer, provider: ai.provider, fileName: req.file.originalname, tool });
  } catch (error) {
    console.error("PDF error:", error);
    res.status(500).json({ error: "PDF error", answer: "Could not analyze the PDF. Please try again or use a different file." });
  }
});

app.post("/ask-image", rateLimit, upload.single("image"), async (req, res) => {
  try {
    const { question = "" } = req.body || {};
    if (!req.file) return res.status(400).json({ error: "Missing image", answer: "Please upload an image first." });
    if (!openai) return res.status(500).json({ error: "OpenAI key missing", answer: "Image analysis is not available right now." });
    const mimeType = req.file.mimetype || "image/png";
    const base64 = req.file.buffer.toString("base64");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", temperature: 0.2, max_tokens: 1600,
      messages: [
        { role: "system", content: "You are Instant Answer Vision. Analyze the image clearly. Read any visible text. Answer in the user's language." },
        { role: "user", content: [{ type: "text", text: question || "Analyze this image." }, { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }] }
      ]
    });
    const answer = completion.choices?.[0]?.message?.content?.trim() || "Could not analyze image.";
    res.json({ answer, provider: "openai-vision", fileName: req.file.originalname });
  } catch (error) {
    console.error("Image error:", error);
    res.status(500).json({ error: "Image error", answer: "Could not analyze the image. Please try a clearer image." });
  }
});

app.post("/webhook", async (req, res) => {
  if (!stripe) return res.status(400).send("Stripe not configured");
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id;
    if (userId && supabase) {
      await supabase.from("profiles").update({ plan: "pro", stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null }).eq("id", userId);
      console.log(`✅ Pro activated for user: ${userId}`);
    }
  }
  // ✅ Remove Pro when subscription cancelled
  if (event.type === "customer.subscription.deleted") {
    const customerId = event.data.object.customer;
    if (customerId && supabase) {
      await supabase.from("profiles").update({ plan: "free" }).eq("stripe_customer_id", customerId);
      console.log(`❌ Pro removed for customer: ${customerId}`);
    }
  }
  res.json({ received: true });
});

app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!stripe || !sessionId) return res.send("Missing info.");
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const userId = session.client_reference_id;
    if (userId && supabase) {
      await supabase.from("profiles").update({ plan: "pro", stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null }).eq("id", userId);
    }
    res.send(`<html><head><meta charset="UTF-8"><title>Pro Activated</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#050505;color:white}.card{background:#1c1c1c;border:1px solid rgba(255,255,255,.12);padding:40px;border-radius:24px;text-align:center;max-width:400px;width:90%}h1{font-size:32px;margin-bottom:12px}h1 span{color:#c8ff57}p{color:#b8b8b8;margin-bottom:28px;line-height:1.6}button{background:#c8ff57;color:#050505;border:none;padding:16px 32px;border-radius:18px;font-size:16px;font-weight:900;cursor:pointer;width:100%}#done{display:none;color:#c8ff57;font-size:18px;font-weight:900;margin-top:16px}</style></head><body><div class="card"><h1>Welcome to <span>Pro</span> ⚡</h1><p>Payment successful!<br>Click below to activate Pro in your extension.</p><button onclick="activatePro()">Activate Pro in Extension</button><div id="done">✅ Pro activated! You can close this tab.</div></div><script>function activatePro(){try{chrome.runtime.sendMessage("${EXTENSION_ID}",{type:"PRO_ACTIVATED"},function(r){console.log("Extension:",r)});}catch(e){console.log("Error:",e);}document.querySelector("button").style.display="none";document.getElementById("done").style.display="block";setTimeout(()=>window.close(),3000);}</script></body></html>`);
  } catch (e) { res.send("Could not verify payment."); }
});

app.post("/check-pro", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const profile = await getUserProfile(user.id);
    const plan = profile?.plan || "free";
    res.json({ pro: plan === "pro", plan });
  } catch (e) { res.status(500).json({ error: "Check failed" }); }
});

app.post("/billing-portal", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
    const profile = await getUserProfile(user.id);
    if (!profile?.stripe_customer_id) return res.status(400).json({ error: "No Stripe customer found. Upgrade first." });
    const portalSession = await stripe.billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: "https://instant-answer-backend-clean.onrender.com" });
    res.json({ url: portalSession.url });
  } catch (e) { res.status(500).json({ error: "Could not create billing portal" }); }
});

app.get("/memory", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const memory = await getOrCreateMemoryProfile(user);
    res.json({ memory });
  } catch (e) { res.status(500).json({ error: "Could not fetch memory" }); }
});

app.get("/history", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const limit = Math.min(Number(req.query.limit || 30), 50);
    const { data, error } = await supabase.from("chat_history").select("id, mode, question, answer, provider, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (e) { res.status(500).json({ error: "Could not fetch history" }); }
});

app.post("/verify-payment", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ pro: false });
    const { email } = req.body || {};
    if (!email) return res.json({ pro: false });
    const customers = await stripe.customers.list({ email: email.trim().toLowerCase(), limit: 5 });
    if (!customers.data.length) return res.json({ pro: false });
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 5 });
      if (subs.data.length > 0) return res.json({ pro: true });
    }
    res.json({ pro: false });
  } catch (e) { res.status(500).json({ pro: false }); }
});

app.get("/latest-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ pro: false });
    const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - 30 * 60;
    const sessions = await stripe.checkout.sessions.list({ limit: 5, created: { gte: thirtyMinutesAgo } });
    const completed = sessions.data.find(s => s.payment_status === "paid");
    if (!completed) return res.json({ pro: false });
    res.json({ pro: true, session_id: completed.id });
  } catch (e) { res.status(500).json({ pro: false }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Instant Answer backend running on port ${PORT}`));