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

async function getUserFromToken(req) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token || !supabase) return null;

    const {
      data: { user },
      error
    } = await supabase.auth.getUser(token);

    if (error || !user) return null;
    return user;
  } catch (error) {
    console.error("Token verify error:", error);
    return null;
  }
}

async function getUserPlan(userId) {
  if (!supabase || !userId) return "free";

  const { data, error } = await supabase
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .single();

  if (error) return "free";
  return data?.plan || "free";
}

async function getOrCreateMemoryProfile(user) {
  if (!supabase || !user?.id) return null;

  const { data: existing } = await supabase
    .from("memory_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (existing) return existing;

  const fullName =
    user.user_metadata?.full_name ||
    user.email?.split("@")?.[0] ||
    "User";

  const { data: created, error } = await supabase
    .from("memory_profiles")
    .insert({
      user_id: user.id,
      full_name: fullName,
      favorite_language: "English",
      favorite_mode: "quick",
      answer_style: "clear and simple",
      subjects: [],
      notes: ""
    })
    .select("*")
    .single();

  if (error) {
    console.error("Create memory error:", error.message);
    return null;
  }

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

  await supabase
    .from("memory_profiles")
    .update({
      favorite_mode: mode,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", userId);
}

function cleanText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function limitText(text = "", max = 14000) {
  const value = String(text || "");
  return value.length > max
    ? value.slice(0, max) + "\n\n[Content shortened]"
    : value;
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

  if (mode === "quick") {
    return `${base}
MODE: QUICK
Rules:
- Give a short answer.
- 3-6 sentences max unless the user asks for more.
- Simple wording.
- No long introductions.
- Answer directly.
`;
  }

  if (mode === "deep") {
    return `${base}
MODE: DEEP
Rules:
- Give a detailed answer.
- Use clear structure.
- Include examples when useful.
- Explain the "why", not only the answer.
`;
  }

  if (mode === "study") {
    return `${base}
MODE: STUDY
Rules:
- Explain like a good teacher.
- Use simple words.
- Make the student understand the topic.
`;
  }

  if (mode === "page") {
    return `${base}
MODE: PAGE
Rules:
- Use the provided webpage/page text.
- Answer based on the page.
`;
  }

  if (mode === "youtube") {
    return `${base}
MODE: YOUTUBE
Rules:
- Use the provided YouTube page content.
- Do not invent exact timestamps.
`;
  }

  if (mode === "files") {
    return `${base}
MODE: FILES
Rules:
- Analyze uploaded PDFs/images clearly.
- If text is missing, say what is missing.
`;
  }

  return `${base}
MODE: GENERAL
Be clear, useful and reliable.
`;
}

function buildUserPrompt({ input, mode, memoryText = "" }) {
  return `
Current mode: ${mode}

Saved user memory:
${memoryText || "No saved memory."}

User request and/or provided context:
${limitText(input, 26000)}
`;
}

async function callGroq({ prompt, systemPrompt, mode, isPro }) {
  if (!groq) throw new Error("Groq key missing");

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: mode === "quick" ? 0.15 : 0.3,
    max_tokens: getMaxTokens(mode, isPro),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim();
}

async function callGemini({ prompt, systemPrompt, mode, isPro }) {
  if (!gemini) throw new Error("Gemini key missing");

  const model = gemini.getGenerativeModel({
    model: mode === "quick" ? "gemini-1.5-flash" : "gemini-1.5-pro"
  });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }],
    generationConfig: {
      temperature: mode === "quick" ? 0.15 : 0.3,
      maxOutputTokens: getMaxTokens(mode, isPro)
    }
  });

  return result.response.text().trim();
}

async function callOpenAI({ prompt, systemPrompt, mode, isPro }) {
  if (!openai) throw new Error("OpenAI key missing");

  const completion = await openai.chat.completions.create({
    model: isPro ? "gpt-4o" : "gpt-4o-mini",
    temperature: mode === "quick" ? 0.15 : 0.25,
    max_tokens: getMaxTokens(mode, isPro),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim();
}

async function callOpenRouter({ prompt, systemPrompt, mode, isPro }) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OpenRouter key missing");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://instant-answer.local",
      "X-Title": "Instant Answer"
    },
    body: JSON.stringify({
      model:
        mode === "quick"
          ? "meta-llama/llama-3.1-8b-instruct:free"
          : "google/gemini-flash-1.5",
      temperature: mode === "quick" ? 0.15 : 0.3,
      max_tokens: getMaxTokens(mode, isPro),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenRouter failed");

  return data.choices?.[0]?.message?.content?.trim();
}

async function routeAI({ prompt, systemPrompt, mode, isPro }) {
  const errors = [];
  const route = mode === "quick"
    ? ["groq", "gemini", "openrouter", "openai"]
    : ["openai", "gemini", "openrouter", "groq"];

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

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Instant Answer backend is running",
    version: "2.6-memory-complete",
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

app.post("/check-pro", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const plan = await getUserPlan(user.id);

    res.json({
      pro: plan === "pro",
      plan
    });
  } catch (error) {
    console.error("Check pro error:", error);
    res.status(500).json({ error: "Check failed" });
  }
});

app.get("/memory", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const memory = await getOrCreateMemoryProfile(user);

    res.json({ memory });
  } catch (error) {
    console.error("Memory error:", error);
    res.status(500).json({ error: "Could not fetch memory" });
  }
});

app.patch("/memory", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const allowed = {};
    const {
      full_name,
      favorite_language,
      favorite_mode,
      answer_style,
      subjects,
      notes
    } = req.body || {};

    if (typeof full_name === "string") allowed.full_name = full_name.slice(0, 120);
    if (typeof favorite_language === "string") allowed.favorite_language = favorite_language.slice(0, 60);
    if (typeof favorite_mode === "string") allowed.favorite_mode = favorite_mode.slice(0, 40);
    if (typeof answer_style === "string") allowed.answer_style = answer_style.slice(0, 200);
    if (Array.isArray(subjects)) allowed.subjects = subjects.map(String).slice(0, 12);
    if (typeof notes === "string") allowed.notes = notes.slice(0, 1000);

    allowed.updated_at = new Date().toISOString();

    await getOrCreateMemoryProfile(user);

    const { data, error } = await supabase
      .from("memory_profiles")
      .update(allowed)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    res.json({ memory: data });
  } catch (error) {
    console.error("Update memory error:", error);
    res.status(500).json({ error: "Could not update memory" });
  }
});

app.get("/history", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = Math.min(Number(req.query.limit || 30), 50);

    const { data, error } = await supabase
      .from("chat_history")
      .select("id, mode, question, answer, provider, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ history: data || [] });
  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ error: "Could not fetch history" });
  }
});

app.delete("/history", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { error } = await supabase
      .from("chat_history")
      .delete()
      .eq("user_id", user.id);

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete history error:", error);
    res.status(500).json({ error: "Could not delete history" });
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const { deviceId } = req.body || {};

    if (process.env.STRIPE_PAYMENT_LINK) {
      return res.json({ url: process.env.STRIPE_PAYMENT_LINK });
    }

    if (!stripe || !process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: user.id,
      customer_email: user.email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      metadata: {
        userId: user.id,
        email: user.email || "",
        deviceId: deviceId || ""
      },
      success_url: `${process.env.BACKEND_URL || "https://instant-answer-backend-clean.onrender.com"}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.CANCEL_URL || "https://google.com"
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/ask", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({
        error: "Unauthorized",
        answer: "Login required."
      });
    }

    const { input, mode = "quick" } = req.body || {};

    if (!input || typeof input !== "string") {
      return res.status(400).json({
        error: "Missing input",
        answer: "Der mangler input."
      });
    }

    const finalMode = detectMode(mode);
    const plan = await getUserPlan(user.id);
    const isPro = plan === "pro";

    const memory = await getOrCreateMemoryProfile(user);
    const memoryText = buildMemoryText(memory);

    const systemPrompt = buildSystemPrompt(finalMode);
    const prompt = buildUserPrompt({
      input,
      mode: finalMode,
      memoryText
    });

    const ai = await routeAI({
      prompt,
      systemPrompt,
      mode: finalMode,
      isPro
    });

    await saveChatHistory({
      userId: user.id,
      mode: finalMode,
      question: input,
      answer: ai.answer,
      provider: ai.provider
    });

    await updateMemoryUsage({
      userId: user.id,
      mode: finalMode
    });

    res.json({
      answer: ai.answer,
      provider: ai.provider,
      pro: isPro,
      plan,
      mode: finalMode,
      sources: []
    });
  } catch (error) {
    console.error("Ask error:", error);
    res.status(500).json({
      error: "Server error",
      answer: `Der skete en fejl i AI-serveren: ${error.message}`
    });
  }
});

app.post("/ask-pdf", upload.single("pdf"), async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized", answer: "Login required." });
    }

    const { tool = "summary", question = "" } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        error: "Missing PDF",
        answer: "Der mangler en PDF-fil."
      });
    }

    const plan = await getUserPlan(user.id);
    const isPro = plan === "pro";

    let parsed;
    if (typeof pdfParse.default === "function") parsed = await pdfParse.default(req.file.buffer);
    else if (typeof pdfParse === "function") parsed = await pdfParse(req.file.buffer);
    else parsed = await pdfParse.pdf(req.file.buffer);

    const pdfText = cleanText(parsed.text || "");

    if (!pdfText || pdfText.length < 20) {
      return res.status(400).json({
        error: "Empty PDF",
        answer: "Jeg kunne ikke læse tekst fra PDF'en. Den kan være scannet som billede."
      });
    }

    const memory = await getOrCreateMemoryProfile(user);
    const memoryText = buildMemoryText(memory);

    const mode = "files";
    const systemPrompt = buildSystemPrompt(mode);

    const prompt = buildUserPrompt({
      mode,
      memoryText,
      input: `
File type: PDF
Tool: ${tool}

User question:
${question || "Analyze this PDF."}

PDF text:
${limitText(pdfText, isPro ? 26000 : 14000)}
`
    });

    const ai = await routeAI({
      prompt,
      systemPrompt,
      mode,
      isPro
    });

    await saveChatHistory({
      userId: user.id,
      mode,
      question: question || `PDF: ${req.file.originalname}`,
      answer: ai.answer,
      provider: ai.provider
    });

    await updateMemoryUsage({ userId: user.id, mode });

    res.json({
      answer: ai.answer,
      provider: ai.provider,
      pro: isPro,
      plan,
      fileName: req.file.originalname,
      pages: parsed.numpages || null,
      tool
    });
  } catch (error) {
    console.error("PDF error:", error);
    res.status(500).json({
      error: "PDF server error",
      answer: `Der skete en fejl med PDF'en: ${error.message}`
    });
  }
});

app.post("/ask-image", upload.single("image"), async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized", answer: "Login required." });
    }

    const { question = "" } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        error: "Missing image",
        answer: "Der mangler et billede."
      });
    }

    const plan = await getUserPlan(user.id);
    const isPro = plan === "pro";
    const mimeType = req.file.mimetype || "image/png";
    const base64 = req.file.buffer.toString("base64");

    if (!openai) {
      return res.status(500).json({
        error: "OpenAI key missing",
        answer: "Image analysis kræver OPENAI_API_KEY på Render."
      });
    }

    const memory = await getOrCreateMemoryProfile(user);
    const memoryText = buildMemoryText(memory);

    const completion = await openai.chat.completions.create({
      model: isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: getMaxTokens("files", isPro),
      messages: [
        {
          role: "system",
          content:
            `You are Instant Answer Vision. Analyze the image clearly. Read visible text. Answer in the user's language.\n\nSaved user memory:\n${memoryText}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: question || "Analyze this image." },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` }
            }
          ]
        }
      ]
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Jeg kunne ikke analysere billedet.";

    await saveChatHistory({
      userId: user.id,
      mode: "files",
      question: question || `Image: ${req.file.originalname}`,
      answer,
      provider: "openai-vision"
    });

    await updateMemoryUsage({ userId: user.id, mode: "files" });

    res.json({
      answer,
      provider: "openai-vision",
      pro: isPro,
      plan,
      fileName: req.file.originalname
    });
  } catch (error) {
    console.error("Image error:", error);
    res.status(500).json({
      error: "Image server error",
      answer: `Der skete en fejl med billedanalysen: ${error.message}`
    });
  }
});

app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!stripe) return res.send("Stripe is not configured.");
  if (!sessionId) return res.send("Missing session id.");

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const userId = session.client_reference_id;

    if (userId && supabase) {
      await supabase
        .from("profiles")
        .update({
          plan: "pro",
          stripe_customer_id:
            typeof session.customer === "string"
              ? session.customer
              : session.customer?.id || null
        })
        .eq("id", userId);
    }

    res.send(`
      <html>
        <body style="font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;background:#f6f6f6;">
          <div style="background:white;padding:28px;border-radius:16px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.1);">
            <h1>Pro activated ✅</h1>
            <p>You can now go back to Instant Answer.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Stripe success error:", error);
    res.send("Could not verify payment.");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Instant Answer backend running on port ${PORT}`);
});