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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: "8mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const proDevices = new Set();

function isProUser(deviceId) {
  return Boolean(deviceId && proDevices.has(deviceId));
}

function cleanText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function limitText(text = "", max = 12000) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, max) + "\n\n[Content shortened for stability]";
}

async function getAuthUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) return null;

  return data.user;
}

async function ensureProfile(user) {
  if (!user?.id) return null;

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
  if (!userId) return "";

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
  if (!userId) return;

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
  if (!userId) return;

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

function extractLatestUserMessage(input = "") {
  const text = String(input || "");

  const latestMatch = text.match(/User's latest message:\s*([\s\S]*?)(?:\n\nRules:|\nRules:|$)/i);
  if (latestMatch?.[1]) return cleanText(latestMatch[1]).slice(0, 700);

  const searchMatch = text.match(/SEARCH QUERY:\s*([\s\S]*?)(?:\n\nVISIBLE RESULTS:|\nVISIBLE RESULTS:|$)/i);
  if (searchMatch?.[1]) return cleanText(searchMatch[1]).slice(0, 700);

  return cleanText(text).slice(0, 700);
}

function detectPageType(input = "") {
  const text = input.toLowerCase();

  if (text.includes("youtube.com/watch") || text.includes("page type:\nyoutube")) return "youtube";
  if (text.includes("reddit.com") || text.includes("page type:\nreddit")) return "reddit";
  if (text.includes("google search results") || text.includes("search query:")) return "google";
  if (text.includes("pdf file") || text.includes("pdf text")) return "pdf";
  if (text.includes("school_assignment")) return "school_assignment";
  if (text.includes("math_page")) return "math_page";
  if (text.includes("article")) return "article";
  if (text.includes("current page") || text.includes("page content")) return "webpage";

  return "normal";
}

function isMathRequest(input = "", mode = "") {
  const text = input.toLowerCase();

  const mathWords = [
    "solve", "equation", "calculate", "graph", "formula", "latex",
    "differentiate", "derivative", "integral", "factor", "expand",
    "function", "parabola", "linear", "quadratic", "matrix",
    "ligning", "beregn", "udregn", "funktion", "graf", "formel",
    "differential", "integral", "afledte", "gymnasie", "matematik",
    "procent", "sandsynlighed", "statistik", "trigonometri"
  ];

  const symbols = /[=+\-*/^√π∫Σ()]/.test(text);
  const hasNumbers = /\d/.test(text);

  return mode === "math" || mathWords.some(word => text.includes(word)) || (symbols && hasNumbers);
}

function shouldUseWebSearch(input = "", mode = "chat") {
  const text = input.toLowerCase();
  const pageType = detectPageType(input);

  if (pageType === "google") return true;
  if (pageType === "pdf") return false;
  if (pageType === "youtube") return false;
  if (mode === "smart") return false;
  if (isMathRequest(input, mode)) return false;

  const searchTriggers = [
    "søg", "search", "google", "find information", "find info",
    "nyeste", "latest", "aktuel", "current", "i dag", "today",
    "nyheder", "news", "pris", "price", "hvem er", "who is",
    "hvornår", "when", "opdateret", "updated", "2025", "2026"
  ];

  return searchTriggers.some(word => text.includes(word));
}

async function searchWeb(query, isPro) {
  if (!process.env.TAVILY_API_KEY) return { text: "", sources: [] };
  if (!query || query.length < 3) return { text: "", sources: [] };

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query,
        topic: "general",
        search_depth: isPro ? "advanced" : "basic",
        max_results: isPro ? 6 : 4,
        include_answer: true,
        include_raw_content: false
      })
    });

    if (!response.ok) return { text: "", sources: [] };

    const data = await response.json();

    const sources = Array.isArray(data.results)
      ? data.results.slice(0, isPro ? 6 : 4).map((item, index) => ({
          number: index + 1,
          title: item.title || "Untitled source",
          url: item.url || "",
          content: item.content || ""
        }))
      : [];

    const sourceText = sources.map(source => `
Source ${source.number}
Title: ${source.title}
URL: ${source.url}
Content: ${limitText(source.content, 1000)}
`).join("\n");

    return {
      text: `
WEB SEARCH RESULTS

Query:
${query}

Direct answer:
${data.answer || "No direct answer"}

Sources:
${sourceText}
`,
      sources
    };
  } catch {
    return { text: "", sources: [] };
  }
}

async function askWolframAlpha(query) {
  if (!process.env.WOLFRAM_APP_ID) return { text: "", sources: [] };
  if (!query || query.length < 2) return { text: "", sources: [] };

  try {
    const url =
      `https://api.wolframalpha.com/v2/query?appid=${process.env.WOLFRAM_APP_ID}` +
      `&input=${encodeURIComponent(query)}` +
      `&output=json&format=plaintext`;

    const response = await fetch(url);

    if (!response.ok) return { text: "", sources: [] };

    const data = await response.json();
    const pods = data?.queryresult?.pods || [];

    const usefulPods = pods
      .map(pod => {
        const values = (pod.subpods || [])
          .map(subpod => subpod.plaintext)
          .filter(Boolean)
          .join("\n");

        if (!values) return null;
        return `${pod.title}:\n${values}`;
      })
      .filter(Boolean)
      .slice(0, 8);

    if (usefulPods.length === 0) return { text: "", sources: [] };

    return {
      text: `
WOLFRAMALPHA MATH VALIDATION

Query:
${query}

Results:
${usefulPods.join("\n\n")}
`,
      sources: [
        {
          title: "WolframAlpha calculation",
          url: "https://www.wolframalpha.com/"
        }
      ]
    };
  } catch {
    return { text: "", sources: [] };
  }
}

function getAiMode(mode, input = "", isPro = false) {
  const text = input.toLowerCase();

  if (mode === "quick") return "fast";
  if (mode === "math") return "smart";
  if (mode === "pdf") return "smart";
  if (mode === "youtube") return "smart";
  if (mode === "smart") return "smart";
  if (mode === "deep") return "deep";
  if (text.includes("deep") || text.includes("grundigt") || text.includes("analyser")) return "deep";
  if (!isPro) return "fast";

  return "smart";
}

function getMaxTokens(mode, isPro) {
  if (isPro) {
    if (mode === "fast") return 1200;
    if (mode === "smart") return 3500;
    if (mode === "deep") return 5200;
    if (mode === "vision") return 3500;
    return 3500;
  }

  if (mode === "fast") return 900;
  if (mode === "smart") return 1700;
  if (mode === "deep") return 2000;
  if (mode === "vision") return 1400;
  return 1200;
}

function buildPrompt(mode, input, isPro, pageType, wolframText = "", memoryText = "", aiMode = "fast") {
  return `
You are Instant Answer.

User plan: ${isPro ? "PRO" : "FREE"}
Mode: ${mode}
AI speed mode: ${aiMode}
Page type: ${pageType}

Saved user memory:
${memoryText || "No saved memory yet."}

Rules:
- Answer in the same language as the user.
- Use saved memory only when useful.
- Do not expose private memory unless relevant.
- Be direct, useful and structured.
- If it is math, solve step-by-step.
- If it is school work, explain clearly.
- If web results are included, use them as current context.
- If AI speed mode is fast, answer shorter and faster.
- If AI speed mode is smart, give a stronger answer.
- If AI speed mode is deep, give the most detailed and reliable answer.

Extra math validation:
${wolframText || "None"}

User input:
${limitText(input, isPro ? 26000 : 14000)}
`;
}

async function callOpenAI(prompt, { aiMode, isPro, temperature = 0.2 }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI API key missing.");

  const model =
    aiMode === "deep" && isPro
      ? "gpt-4o"
      : aiMode === "smart" && isPro
        ? "gpt-4o"
        : "gpt-4o-mini";

  const completion = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens: getMaxTokens(aiMode, isPro),
    messages: [
      {
        role: "system",
        content:
          "You are Instant Answer. Be fast, reliable and useful. Use memory only when helpful."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  const answer = completion?.choices?.[0]?.message?.content?.trim();

  if (!answer) throw new Error("OpenAI returned empty answer.");

  return {
    answer,
    provider: "openai",
    model
  };
}

async function callGemini(prompt, { aiMode, isPro }) {
  if (!gemini) throw new Error("Gemini API key missing.");

  const modelName =
    aiMode === "deep" && isPro
      ? "gemini-1.5-pro"
      : "gemini-1.5-flash";

  const model = gemini.getGenerativeModel({ model: modelName });

  const result = await model.generateContent(prompt);
  const answer = result?.response?.text()?.trim();

  if (!answer) throw new Error("Gemini returned empty answer.");

  return {
    answer,
    provider: "gemini",
    model: modelName
  };
}

async function callGroq(prompt, { aiMode, isPro, temperature = 0.2 }) {
  if (!groq) throw new Error("Groq API key missing.");

  const model =
    aiMode === "deep" && isPro
      ? "llama-3.3-70b-versatile"
      : "llama-3.1-8b-instant";

  const completion = await groq.chat.completions.create({
    model,
    temperature,
    max_tokens: getMaxTokens(aiMode, isPro),
    messages: [
      {
        role: "system",
        content:
          "You are Instant Answer. Be fast, clear and useful."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  const answer = completion?.choices?.[0]?.message?.content?.trim();

  if (!answer) throw new Error("Groq returned empty answer.");

  return {
    answer,
    provider: "groq",
    model
  };
}

async function callOpenRouter(prompt, { aiMode, isPro, temperature = 0.2 }) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OpenRouter API key missing.");
  }

  const model =
    aiMode === "deep" && isPro
      ? "google/gemini-2.0-flash-001"
      : "openai/gpt-4o-mini";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://instant-answer.ai",
      "X-Title": "Instant Answer"
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: getMaxTokens(aiMode, isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer. Be reliable, structured and useful."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter failed: ${response.status}`);
  }

  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();

  if (!answer) throw new Error("OpenRouter returned empty answer.");

  return {
    answer,
    provider: "openrouter",
    model
  };
}

function getProviderOrder({ aiMode, mode, isPro, mathMode }) {
  if (mathMode) {
    return ["openai", "gemini", "openrouter", "groq"];
  }

  if (aiMode === "fast") {
    return ["groq", "openai", "gemini", "openrouter"];
  }

  if (aiMode === "smart") {
    return ["openai", "gemini", "openrouter", "groq"];
  }

  if (aiMode === "deep") {
    return ["openrouter", "openai", "gemini", "groq"];
  }

  return ["openai", "groq", "gemini", "openrouter"];
}

async function routeAI(prompt, options) {
  const providerOrder = getProviderOrder(options);
  const errors = [];

  for (const provider of providerOrder) {
    try {
      if (provider === "openai") return await callOpenAI(prompt, options);
      if (provider === "gemini") return await callGemini(prompt, options);
      if (provider === "groq") return await callGroq(prompt, options);
      if (provider === "openrouter") return await callOpenRouter(prompt, options);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.error(`AI provider failed (${provider}):`, error.message);
    }
  }

  throw new Error(`All AI providers failed. ${errors.join(" | ")}`);
}

async function preparePromptData(input, mode, deviceId, memoryText = "") {
  const isPro = isProUser(deviceId);
  const pageType = detectPageType(input);
  const latestMessage = extractLatestUserMessage(input);

  const mathMode = isMathRequest(input, mode);
  const youtubeMode = mode === "youtube" || pageType === "youtube";
  const useSearch = shouldUseWebSearch(input, mode);
  const aiMode = getAiMode(mode, input, isPro);

  const web = useSearch ? await searchWeb(latestMessage, isPro) : { text: "", sources: [] };
  const wolfram = mathMode ? await askWolframAlpha(latestMessage) : { text: "", sources: [] };

  const finalInput = `
${input}

${web.text ? web.text : ""}

${wolfram.text ? wolfram.text : ""}
`;

  const prompt = buildPrompt(
    youtubeMode ? "youtube" : mode,
    finalInput,
    isPro,
    pageType,
    wolfram.text,
    memoryText,
    aiMode
  );

  return {
    isPro,
    pageType,
    mathMode,
    youtubeMode,
    aiMode,
    prompt,
    web,
    wolfram
  };
}

function buildPdfPrompt({ pdfText, fileName, tool, question, isPro }) {
  return `
You are Instant Answer PDF Assistant.

User plan: ${isPro ? "PRO" : "FREE"}

PDF file:
${fileName}

PDF tool:
${tool}

User question:
${question || "Analyze this PDF."}

Rules:
- Answer in the same language as the user.
- Use only the PDF text.
- Do not invent facts, quotes, sources or page numbers.
- Be structured and useful.

PDF text:
${limitText(pdfText, isPro ? 26000 : 14000)}
`;
}

function buildImagePrompt({ tool, question, isPro }) {
  return `
You are Instant Answer Vision AI.

User plan: ${isPro ? "PRO" : "FREE"}

Tool:
${tool}

User question:
${question || "Analyze this image."}

Rules:
- Read visible text carefully.
- If there is math, solve it step-by-step.
- If it is school work, explain clearly.
- If you cannot read something clearly, say it honestly.
- Answer in the same language as the user.
`;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Instant Answer backend is running",
    version: "2.0-ai-model-routing-speed-no-claude",
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      claude: false
    }
  });
});

app.get("/me", async (req, res) => {
  const user = await getAuthUser(req);

  if (!user) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const profile = await ensureProfile(user);

  res.json({
    user,
    profile
  });
});

app.get("/memory", async (req, res) => {
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

app.post("/memory", async (req, res) => {
  const user = await getAuthUser(req);

  if (!user) return res.status(401).json({ error: "Not logged in" });

  const { content } = req.body || {};

  if (!content) return res.status(400).json({ error: "Missing content" });

  const { data, error } = await supabase
    .from("memories")
    .insert({
      user_id: user.id,
      content: cleanText(content).slice(0, 1000)
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ memory: data });
});

app.get("/chats", async (req, res) => {
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

app.get("/chats/:chatId/messages", async (req, res) => {
  const user = await getAuthUser(req);

  if (!user) return res.status(401).json({ error: "Not logged in" });

  const { chatId } = req.params;

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("user_id", user.id)
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ messages: data });
});

app.get("/preferences", async (req, res) => {
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

app.post("/check-pro", (req, res) => {
  const { deviceId } = req.body || {};
  res.json({ pro: isProUser(deviceId) });
});

app.post("/ask-image", upload.single("image"), async (req, res) => {
  try {
    const { deviceId, tool = "image", question = "" } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        error: "Missing image",
        answer: "Der mangler et billede."
      });
    }

    const isPro = isProUser(deviceId);
    const mimeType = req.file.mimetype || "image/png";
    const base64 = req.file.buffer.toString("base64");

    const prompt = buildImagePrompt({
      tool,
      question,
      isPro
    });

    const completion = await openai.chat.completions.create({
      model: isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: getMaxTokens("vision", isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer Vision AI. Analyze screenshots and images carefully."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
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
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Jeg kunne ikke analysere billedet.";

    res.json({
      answer,
      pro: isPro,
      fileName: req.file.originalname,
      tool,
      provider: "openai",
      model: isPro ? "gpt-4o" : "gpt-4o-mini"
    });
  } catch (error) {
    console.error("Image error:", error);

    res.status(500).json({
      error: "Image server error",
      answer:
        "Der skete en fejl med billedanalysen. Prøv et mindre billede eller et tydeligere screenshot."
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

    const parser = pdfParse.default || pdfParse;
    const parsed = await parser(req.file.buffer);
    const pdfText = cleanText(parsed.text || "");

    if (!pdfText || pdfText.length < 20) {
      return res.status(400).json({
        error: "Empty PDF",
        answer: "Jeg kunne ikke læse tekst fra PDF'en. Den kan være scannet som billede."
      });
    }

    const prompt = buildPdfPrompt({
      pdfText,
      fileName: req.file.originalname,
      tool,
      question,
      isPro
    });

    const aiMode = getAiMode("pdf", question, isPro);

    const ai = await routeAI(prompt, {
      aiMode,
      mode: "pdf",
      isPro,
      mathMode: false,
      temperature: 0.2
    });

    res.json({
      answer: ai.answer,
      pro: isPro,
      fileName: req.file.originalname,
      pages: parsed.numpages || null,
      tool,
      provider: ai.provider,
      model: ai.model,
      aiMode
    });
  } catch (error) {
    console.error("PDF error:", error);

    res.status(500).json({
      error: "PDF server error",
      answer:
        "Der skete en fejl med PDF'en. Prøv en mindre PDF eller en PDF med rigtig tekst."
    });
  }
});

app.post("/ask", async (req, res) => {
  try {
    const { input, mode = "chat", deviceId } = req.body || {};

    if (!input || typeof input !== "string") {
      return res.status(400).json({
        error: "Missing input",
        answer: "Der mangler input."
      });
    }

    const user = await getAuthUser(req);
    if (user) await ensureProfile(user);

    const memoryText = user ? await getUserMemory(user.id) : "";
    const data = await preparePromptData(input, mode, deviceId, memoryText);

    const ai = await routeAI(data.prompt, {
      aiMode: data.aiMode,
      mode,
      isPro: data.isPro,
      mathMode: data.mathMode,
      temperature: data.mathMode ? 0.1 : 0.2
    });

    const answer = ai.answer || "Jeg kunne ikke lave et svar. Prøv igen.";

    if (user) {
      await saveMemoryIfNeeded(user.id, input);
      await saveChatMessage(user.id, mode, input, answer);
    }

    res.json({
      answer,
      pro: data.isPro,
      usedSearch: Boolean(data.web.text),
      usedWolfram: Boolean(data.wolfram.text),
      mathMode: data.mathMode,
      pageType: data.pageType,
      loggedIn: Boolean(user),
      aiMode: data.aiMode,
      provider: ai.provider,
      model: ai.model,
      sources: [
        ...data.web.sources.map(source => ({
          title: source.title,
          url: source.url
        })),
        ...data.wolfram.sources
      ]
    });
  } catch (error) {
    console.error("Ask error:", error);

    res.status(500).json({
      error: "Server error",
      answer:
        "Der skete en fejl i AI-serveren. Alle AI-modeller fejlede eller API keys mangler."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Instant Answer backend running on http://localhost:${PORT}`);
});