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
  return value.length > max ? value.slice(0, max) + "\n\n[Content shortened]" : value;
}

function isProUser(deviceId) {
  return Boolean(deviceId && proDevices.has(deviceId));
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
- Use bullets or short sections.
- Explain the "why", not only the answer.
`;
  }

  if (mode === "study") {
    return `${base}
MODE: STUDY
Rules:
- Explain like a good teacher.
- Use simple words.
- If the user asks for notes, make clean study notes.
- If the user asks for quiz, make quiz questions and answers.
- If the user asks for explanation, explain step by step.
- Make the student understand the topic.
`;
  }

  if (mode === "page") {
    return `${base}
MODE: PAGE
Rules:
- Use the provided webpage/page text.
- If the page text exists, answer based on it.
- Summarize, explain or answer the user's question from the page.
- Do not ask for a link if page content is already included.
`;
  }

  if (mode === "youtube") {
    return `${base}
MODE: YOUTUBE
Rules:
- Use the provided YouTube page content.
- Summarize the video/page clearly.
- If transcript is missing, use visible title/description/page text.
- Do not invent exact timestamps.
- If notes requested, make study notes.
- If quiz requested, create quiz questions and answers.
`;
  }

  if (mode === "files") {
    return `${base}
MODE: FILES
Rules:
- Analyze uploaded PDFs/images clearly.
- If text is missing, say what is missing.
- Make summaries, notes or answers depending on request.
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
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
      }
    ],
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
      model: mode === "quick"
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
        ? ["openai", "gemini", "openrouter", "groq"]
        : mode === "study"
          ? ["openai", "gemini", "openrouter", "groq"]
          : mode === "page" || mode === "youtube"
            ? ["openai", "gemini", "openrouter", "groq"]
            : ["openai", "gemini", "openrouter", "groq"];

  for (const provider of route) {
    try {
      let answer = "";

      if (provider === "groq") answer = await callGroq({ prompt, systemPrompt, mode, isPro });
      if (provider === "gemini") answer = await callGemini({ prompt, systemPrompt, mode, isPro });
      if (provider === "openai") answer = await callOpenAI({ prompt, systemPrompt, mode, isPro });
      if (provider === "openrouter") answer = await callOpenRouter({ prompt, systemPrompt, mode, isPro });

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
    version: "2.1-fixed-modes-upgrade",
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

app.post("/check-pro", (req, res) => {
  const { deviceId } = req.body || {};
  res.json({ pro: isProUser(deviceId) });
});

app.post("/create-checkout", async (req, res) => {
  try {
    const { deviceId } = req.body || {};

    if (process.env.STRIPE_PAYMENT_LINK) {
      return res.json({
        url: process.env.STRIPE_PAYMENT_LINK
      });
    }

    if (!stripe || !process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({
        error: "Stripe is not configured"
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: deviceId || "unknown_device",
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
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
    const { input, mode = "quick", deviceId } = req.body || {};

    if (!input || typeof input !== "string") {
      return res.status(400).json({
        error: "Missing input",
        answer: "Der mangler input."
      });
    }

    const finalMode = detectMode(mode);
    const isPro = isProUser(deviceId);

    const systemPrompt = buildSystemPrompt(finalMode);
    const prompt = buildUserPrompt({
      input,
      mode: finalMode,
      memoryText: ""
    });

    const ai = await routeAI({
      prompt,
      systemPrompt,
      mode: finalMode,
      isPro
    });

    res.json({
      answer: ai.answer,
      provider: ai.provider,
      pro: isPro,
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