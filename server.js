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

const proDevices = new Set();

function cleanText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function limitText(text = "", max = 14000) {
  const value = String(text || "");
  return value.length > max
    ? value.slice(0, max) + "\n\n[Content shortened]"
    : value;
}

function isProUser(deviceId) {
  return Boolean(deviceId && proDevices.has(deviceId));
}

function detectMode(mode = "") {
  const allowed = ["quick", "deep", "study", "page", "youtube", "files", "math", "smart"];
  return allowed.includes(mode) ? mode : "quick";
}

function getMaxTokens(mode, isPro) {
  if (mode === "quick") return isPro ? 900 : 500;
  if (mode === "deep") return isPro ? 3500 : 1600;
  if (mode === "study") return isPro ? 3000 : 1500;
  if (mode === "page") return isPro ? 3000 : 1500;
  if (mode === "youtube") return isPro ? 3000 : 1500;
  if (mode === "files") return isPro ? 3200 : 1600;
  return isPro ? 2500 : 1200;
}

function buildSystemPrompt(mode) {
  if (mode === "quick") {
    return "You are Instant Answer Quick Mode. Give fast, clear, useful answers. Use simple wording. Be direct.";
  }

  if (mode === "deep") {
    return "You are Instant Answer Deep Mode. Give stronger, more complete answers with structure, examples and practical steps.";
  }

  if (mode === "study") {
    return "You are Instant Answer Study Mode. Explain like a good teacher. Make notes, quizzes or simple explanations depending on the request.";
  }

  if (mode === "page") {
    return "You are Instant Answer Page Mode. Use the provided page content. Summarize, explain and answer based only on the page when possible.";
  }

  if (mode === "youtube") {
    return "You are Instant Answer YouTube Mode. Use the provided YouTube page content. Make summaries, notes and quizzes. Do not invent timestamps.";
  }

  if (mode === "files") {
    return "You are Instant Answer Files Mode. Analyze PDFs and images clearly. Be honest if text is missing or unclear.";
  }

  return "You are Instant Answer. Be clear, useful and reliable.";
}

function buildUserPrompt({ input, mode, memoryText = "" }) {
  return `
Mode:
${mode}

Saved user memory:
${memoryText || "No saved memory."}

Rules:
- Answer in the same language as the user.
- Be clear and practical.
- Do not invent facts.
- If context is provided, use it.
- If the user asks for school help, explain simply.

User input:
${limitText(input, 26000)}
`;
}

async function getAuthUser(req) {
  if (!supabase) return null;

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  return data.user;
}

async function ensureProfile(user) {
  if (!supabase || !user?.id) return null;

  const { data, error } = await supabase
    .from("profiles")
    .upsert({
      id: user.id,
      email: user.email,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error("Profile error:", error.message);
    return null;
  }

  return data;
}

async function getUserMemory(userId) {
  if (!supabase || !userId) return "";

  const { data, error } = await supabase
    .from("memories")
    .select("content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error || !data) return "";

  return data.map(item => `- ${item.content}`).join("\n");
}

async function saveMemoryIfNeeded(userId, input = "") {
  if (!supabase || !userId) return;

  const text = cleanText(input);
  const lower = text.toLowerCase();

  const shouldRemember =
    lower.includes("remember that") ||
    lower.includes("husk at") ||
    lower.includes("husk det") ||
    lower.includes("gem det") ||
    lower.includes("save this");

  if (!shouldRemember || text.length < 8) return;

  await supabase.from("memories").insert({
    user_id: userId,
    content: text.slice(0, 1000)
  });
}

async function saveChatMessage(userId, mode, question, answer) {
  if (!supabase || !userId) return;

  const { data: chat, error: chatError } = await supabase
    .from("chats")
    .insert({
      user_id: userId,
      title: cleanText(question).slice(0, 80) || "New chat",
      mode
    })
    .select()
    .single();

  if (chatError || !chat) {
    console.error("Chat save error:", chatError?.message);
    return;
  }

  await supabase.from("messages").insert([
    {
      chat_id: chat.id,
      user_id: userId,
      role: "user",
      content: question
    },
    {
      chat_id: chat.id,
      user_id: userId,
      role: "assistant",
      content: answer
    }
  ]);
}

async function callGroq({ prompt, systemPrompt, mode, isPro }) {
  if (!groq) throw new Error("Groq key missing");

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: mode === "quick" ? 0.2 : 0.35,
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
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
      }
    ],
    generationConfig: {
      temperature: mode === "quick" ? 0.2 : 0.35,
      maxOutputTokens: getMaxTokens(mode, isPro)
    }
  });

  return result.response.text().trim();
}

async function callOpenAI({ prompt, systemPrompt, mode, isPro }) {
  if (!openai) throw new Error("OpenAI key missing");

  const completion = await openai.chat.completions.create({
    model: isPro ? "gpt-4o" : "gpt-4o-mini",
    temperature: mode === "quick" ? 0.2 : 0.3,
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
      model: mode === "quick"
        ? "meta-llama/llama-3.1-8b-instruct:free"
        : "google/gemini-flash-1.5",
      temperature: mode === "quick" ? 0.2 : 0.35,
      max_tokens: getMaxTokens(mode, isPro),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenRouter failed");
  }

  return data.choices?.[0]?.message?.content?.trim();
}

async function routeAI({ prompt, systemPrompt, mode, isPro }) {
  const errors = [];

  const route =
    mode === "quick"
      ? ["groq", "gemini", "openrouter", "openai"]
      : mode === "deep"
        ? ["gemini", "openai", "openrouter", "groq"]
        : mode === "study"
          ? ["gemini", "openai", "openrouter", "groq"]
          : mode === "page" || mode === "youtube"
            ? ["gemini", "openai", "openrouter", "groq"]
            : ["openai", "gemini", "openrouter", "groq"];

  for (const provider of route) {
    try {
      let answer = "";

      if (provider === "groq") {
        answer = await callGroq({ prompt, systemPrompt, mode, isPro });
      }

      if (provider === "gemini") {
        answer = await callGemini({ prompt, systemPrompt, mode, isPro });
      }

      if (provider === "openai") {
        answer = await callOpenAI({ prompt, systemPrompt, mode, isPro });
      }

      if (provider === "openrouter") {
        answer = await callOpenRouter({ prompt, systemPrompt, mode, isPro });
      }

      if (answer && answer.length > 2) {
        return { answer, provider };
      }
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
    version: "2.0-stable-modes-routing",
    modes: ["quick", "deep", "study", "page", "youtube", "files"],
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    }
  });
});

app.post("/check-pro", (req, res) => {
  const { deviceId } = req.body || {};
  res.json({ pro: isProUser(deviceId) });
});

app.get("/me", async (req, res) => {
  const user = await getAuthUser(req);

  if (!user) return res.status(401).json({ error: "Not logged in" });

  const profile = await ensureProfile(user);

  res.json({ user, profile });
});

app.get("/memory", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });

  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ memories: data });
});

app.get("/chats", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });

  const { data, error } = await supabase
    .from("chats")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ chats: data });
});

app.get("/preferences", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });

  const { data, error } = await supabase
    .from("user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ preferences: data });
});

app.post("/preferences", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });

  const { language, theme, tone } = req.body || {};

  const { data, error } = await supabase
    .from("user_preferences")
    .upsert({
      user_id: user.id,
      language: language || "auto",
      theme: theme || "dark",
      tone: tone || "clear",
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ preferences: data });
});

app.post("/ask", async (req, res) => {
  try {
    const { input, mode = "quick", deviceId } = req.body || {};

    if (!input || typeof input !== "string") {
      return res.status(400).json({
        error: "Missing input",
        answer: "Der mangler input."
      });
    }

    const finalMode = detectMode(mode);
    const isPro = isProUser(deviceId);

    const user = await getAuthUser(req);
    if (user) await ensureProfile(user);

    const memoryText = user ? await getUserMemory(user.id) : "";

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

    if (user) {
      await saveMemoryIfNeeded(user.id, input);
      await saveChatMessage(user.id, finalMode, input, ai.answer);
    }

    res.json({
      answer: ai.answer,
      provider: ai.provider,
      pro: isPro,
      mode: finalMode,
      loggedIn: Boolean(user),
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
    const { deviceId, tool = "summary", question = "" } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        error: "Missing PDF",
        answer: "Der mangler en PDF-fil."
      });
    }

    const isPro = isProUser(deviceId);

    let parsed;

    if (typeof pdfParse.default === "function") {
      parsed = await pdfParse.default(req.file.buffer);
    } else if (typeof pdfParse === "function") {
      parsed = await pdfParse(req.file.buffer);
    } else {
      parsed = await pdfParse.pdf(req.file.buffer);
    }

    const pdfText = cleanText(parsed.text || "");

    if (!pdfText || pdfText.length < 20) {
      return res.status(400).json({
        error: "Empty PDF",
        answer: "Jeg kunne ikke læse tekst fra PDF'en. Den kan være scannet som billede."
      });
    }

    const mode = "files";
    const systemPrompt = buildSystemPrompt(mode);

    const prompt = `
File type: PDF
Tool: ${tool}

User question:
${question || "Analyze this PDF."}

PDF text:
${limitText(pdfText, isPro ? 26000 : 14000)}
`;

    const ai = await routeAI({
      prompt,
      systemPrompt,
      mode,
      isPro
    });

    res.json({
      answer: ai.answer,
      provider: ai.provider,
      pro: isPro,
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
    const { deviceId, question = "" } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        error: "Missing image",
        answer: "Der mangler et billede."
      });
    }

    const isPro = isProUser(deviceId);
    const mimeType = req.file.mimetype || "image/png";
    const base64 = req.file.buffer.toString("base64");

    if (!openai) {
      return res.status(500).json({
        error: "OpenAI key missing",
        answer: "Image analysis kræver OPENAI_API_KEY på Render."
      });
    }

    const completion = await openai.chat.completions.create({
      model: isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: getMaxTokens("files", isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer Vision. Analyze the image clearly. Read visible text. Answer in the user's language."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: question || "Analyze this image."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`
              }
            }
          ]
        }
      ]
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Jeg kunne ikke analysere billedet.";

    res.json({
      answer,
      provider: "openai-vision",
      pro: isPro,
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
    const deviceId = session.client_reference_id;

    if (deviceId) proDevices.add(deviceId);

    res.send(`
      <html>
        <body style="font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;background:#f6f6f6;">
          <div style="background:white;padding:28px;border-radius:16px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.1);">
            <h1>Pro activated</h1>
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