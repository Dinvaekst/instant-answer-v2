import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Stripe from "stripe";
import multer from "multer";
import pdfParse from "pdf-parse";

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

function extractYouTubeVideoId(input = "") {
  const text = String(input || "");

  const patterns = [
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return "";
}

function decodeXml(text = "") {
  return String(text)
    .replace(/<text start="([^"]+)"[^>]*>/g, "\n[$1] ")
    .replace(/<\/text>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function secondsToTimestamp(seconds = 0) {
  const total = Math.floor(Number(seconds) || 0);
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function formatTranscriptXml(xml = "") {
  const items = [...String(xml).matchAll(/<text start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)];

  if (items.length === 0) return decodeXml(xml);

  return items
    .map(match => {
      const timestamp = secondsToTimestamp(match[1]);
      const text = decodeXml(match[2]);
      return text ? `[${timestamp}] ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function getYouTubeTranscript(input = "") {
  const videoId = extractYouTubeVideoId(input);
  if (!videoId) return { text: "", videoId: "", transcriptFound: false };

  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const pageResponse = await fetch(watchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!pageResponse.ok) return { text: "", videoId, transcriptFound: false };

    const html = await pageResponse.text();
    const captionMatch = html.match(/"captionTracks":(\[.*?\])\s*,\s*"audioTracks"/);

    if (!captionMatch?.[1]) return { text: "", videoId, transcriptFound: false };

    let captionTracks = [];

    try {
      captionTracks = JSON.parse(captionMatch[1]);
    } catch {
      return { text: "", videoId, transcriptFound: false };
    }

    if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
      return { text: "", videoId, transcriptFound: false };
    }

    const preferredTrack =
      captionTracks.find(track => track.languageCode === "da") ||
      captionTracks.find(track => track.languageCode === "en") ||
      captionTracks[0];

    if (!preferredTrack?.baseUrl) return { text: "", videoId, transcriptFound: false };

    const transcriptResponse = await fetch(preferredTrack.baseUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!transcriptResponse.ok) return { text: "", videoId, transcriptFound: false };

    const xml = await transcriptResponse.text();
    const transcript = formatTranscriptXml(xml);

    if (!transcript || transcript.length < 20) {
      return { text: "", videoId, transcriptFound: false };
    }

    return { text: transcript, videoId, transcriptFound: true };
  } catch (error) {
    console.error("YouTube transcript error:", error.message);
    return { text: "", videoId, transcriptFound: false };
  }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), isPro ? 12000 : 8000);

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
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

    clearTimeout(timeout);

    if (!response.ok) {
      console.error("Tavily failed:", response.status, await response.text());
      return { text: "", sources: [] };
    }

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
  } catch (error) {
    console.error("Tavily error:", error.message);
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const response = await fetch(url, { signal: controller.signal });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error("Wolfram failed:", response.status);
      return { text: "", sources: [] };
    }

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
  } catch (error) {
    console.error("Wolfram error:", error.message);
    return { text: "", sources: [] };
  }
}

function buildMathPrompt(input, isPro, wolframText = "") {
  return `
You are Instant Answer Math.

User plan: ${isPro ? "PRO" : "FREE"}

Math rules:
- Solve step-by-step.
- Explain like a teacher.
- Use simple language.
- Show formulas before using them.
- Use clean LaTeX using \\( ... \\) or \\[ ... \\].
- Check the final answer.
- For word problems: write "Given", "Find", "Formula", "Calculation", "Answer".
- For graph questions: describe shape, intersections, slope, vertex and important points.
- Compare your result with WolframAlpha if included.

Output format:
1. Short answer
2. Step-by-step solution
3. Formula / LaTeX
4. Final answer
5. Check

If graph data is useful, include:
GRAPH:
y = expression

${wolframText}

User input:
${limitText(input, isPro ? 24000 : 14000)}
`;
}

function buildPdfPrompt({ pdfText, fileName, tool, question, isPro }) {
  const toolRules = {
    summary: "Give a clear PDF summary with main idea, sections and takeaway.",
    notes: "Create useful study notes with headings, bullets and simple explanations.",
    flashcards: "Create flashcards formatted as Q: and A:.",
    quiz: "Create a quiz with multiple choice, short answers and answers after the quiz.",
    citations: "Extract useful quotes or important text pieces. Do not invent page numbers.",
    important: "Find and rank the most important points.",
    qa: "Answer the user's question using only the PDF."
  };

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
${toolRules[tool] || toolRules.summary}

Important:
- Answer in the same language as the user.
- Use only the PDF text.
- Do not invent facts, quotes, sources or page numbers.
- If the PDF text is unclear, say it honestly.
- Be structured and useful.

PDF text:
${limitText(pdfText, isPro ? 26000 : 14000)}
`;
}

function buildYoutubePrompt(input, isPro, transcriptText = "") {
  return `
You are Instant Answer YouTube Study Assistant.

User plan: ${isPro ? "PRO" : "FREE"}

Goal:
Be the best YouTube study assistant.

YouTube rules:
- Use transcript when available.
- Use title, description, visible timestamps, chapters, comments and page context.
- Create study summaries, notes, key moments, quizzes and chapter suggestions.
- Detect chapters from timestamps if visible.
- If exact timestamps are not available, say that and create topic-based moments.
- Analyze comments separately from the video content.
- Do not invent exact timestamps.
- Be useful for students.

Transcript status:
${transcriptText ? "Transcript found and included." : "No transcript found. Use visible page content only."}

Transcript:
${limitText(transcriptText, isPro ? 26000 : 12000)}

Visible YouTube/page input:
${limitText(input, isPro ? 20000 : 12000)}
`;
}

function buildSmartPrompt(input, isPro, pageType) {
  return `
You are Instant Answer Smart Browser AI.

User plan: ${isPro ? "PRO" : "FREE"}
Page type: ${pageType}

Smart browser goals:
- Understand the browser page deeply.
- Classify the website/page type.
- Detect school assignments.
- Detect math automatically.
- Detect article/search/social/video/page type.
- Explain selected text if included.
- Understand Google/search result pages.
- Give practical next steps.

Rules:
- Answer in the same language as the user.
- Be direct and useful.
- Do not invent facts, quotes or sources.
- If the page has selected text, focus on it.
- If it looks like school work, help with structure and explanation.
- If it looks like math, solve step-by-step.
- If it is a website, classify purpose, content and user intent.

Input:
${limitText(input, isPro ? 26000 : 14000)}
`;
}

function buildImagePrompt({ tool, question, isPro }) {
  const toolRules = {
    screenshot: "Analyze this browser screenshot. Extract text, understand layout, identify questions, school assignments, math and important visual information.",
    image: "Analyze the uploaded image. Extract visible text, understand the image and answer the user's question.",
    context: "Use the image as browser context and explain what matters.",
    selected: "Focus on any visible selected or highlighted text in the image.",
    auto: "Auto-detect if the image contains math, school assignment, article, search, website UI or general content.",
    classify: "Classify what type of page/image this is and explain the useful next steps."
  };

  return `
You are Instant Answer Vision AI.

User plan: ${isPro ? "PRO" : "FREE"}

Tool:
${tool}

User question:
${question || "Analyze this image."}

Rules:
${toolRules[tool] || toolRules.image}

Important:
- Read visible text carefully.
- If there is math, solve it step-by-step.
- If it is a school assignment, explain what to do.
- If it is a webpage screenshot, classify the page and important content.
- If you cannot read something clearly, say it honestly.
- Answer in the same language as the user.
`;
}

function buildPrompt(mode, input, isPro, pageType, wolframText = "", youtubeTranscript = "") {
  if (mode === "smart") return buildSmartPrompt(input, isPro, pageType);
  if (mode === "youtube" || pageType === "youtube") return buildYoutubePrompt(input, isPro, youtubeTranscript);
  if (isMathRequest(input, mode)) return buildMathPrompt(input, isPro, wolframText);

  return `
You are Instant Answer.

User plan: ${isPro ? "PRO" : "FREE"}
Mode: ${mode}
Page type: ${pageType}

Main rules:
- Answer in the same language as the user.
- Do exactly what the user asks.
- Be direct, useful and human.
- Do not invent facts, quotes, sources or page numbers.
- Use current page context if included.
- If web results are included, trust them more than old knowledge.
- For Google results: summarize the best answer.
- For Reddit: summarize opinions, patterns, warnings and useful points.
- For webpages: focus on the visible content and user question.

User input:
${limitText(input, isPro ? 24000 : 14000)}
`;
}

function getMaxTokens(mode, isPro) {
  if (isPro) {
    if (mode === "quick") return 700;
    if (mode === "math") return 4200;
    if (mode === "pdf") return 4200;
    if (mode === "youtube") return 4200;
    if (mode === "smart") return 4200;
    if (mode === "vision") return 3500;
    if (mode === "study") return 3800;
    if (mode === "deep") return 3800;
    return 3500;
  }

  if (mode === "quick") return 300;
  if (mode === "math") return 1700;
  if (mode === "pdf") return 1700;
  if (mode === "youtube") return 1700;
  if (mode === "smart") return 1700;
  if (mode === "vision") return 1400;
  if (mode === "study") return 1400;
  if (mode === "deep") return 1400;
  return 1200;
}

async function preparePromptData(input, mode, deviceId) {
  const isPro = isProUser(deviceId);
  const pageType = detectPageType(input);
  const latestMessage = extractLatestUserMessage(input);

  const mathMode = isMathRequest(input, mode);
  const youtubeMode = mode === "youtube" || pageType === "youtube";
  const useSearch = shouldUseWebSearch(input, mode);

  const web = useSearch ? await searchWeb(latestMessage, isPro) : { text: "", sources: [] };
  const wolfram = mathMode ? await askWolframAlpha(latestMessage) : { text: "", sources: [] };
  const youtube = youtubeMode ? await getYouTubeTranscript(input) : { text: "", transcriptFound: false, videoId: "" };

  const finalInput = `
${input}

${web.text ? web.text : ""}

${wolfram.text ? wolfram.text : ""}

${youtube.text ? `YOUTUBE TRANSCRIPT:\n${youtube.text}` : ""}
`;

  const prompt = buildPrompt(
    youtubeMode ? "youtube" : mode,
    finalInput,
    isPro,
    pageType,
    wolfram.text,
    youtube.text
  );

  return {
    isPro,
    pageType,
    mathMode,
    youtubeMode,
    prompt,
    web,
    wolfram,
    youtube
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Instant Answer backend is running",
    version: "1.8-premium-ui-streaming"
  });
});

app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!sessionId) return res.send("Missing session id.");

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const deviceId = session.client_reference_id;

    if (!deviceId) return res.send("Missing device id.");

    proDevices.add(deviceId);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Instant Answer Pro</title></head>
        <body style="font-family:Arial;background:#f7f7f7;display:flex;align-items:center;justify-content:center;height:100vh;">
          <div style="background:white;padding:28px;border-radius:16px;box-shadow:0 4px 18px rgba(0,0,0,0.1);max-width:420px;text-align:center;">
            <h1>Pro activated</h1>
            <p>Thanks for upgrading to Instant Answer Pro.</p>
            <p>You can now go back to the extension.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Stripe success error:", error);
    res.send("Could not verify payment.");
  }
});

app.post("/check-pro", (req, res) => {
  const { deviceId } = req.body || {};
  res.json({ pro: isProUser(deviceId) });
});

app.post("/ask-stream", async (req, res) => {
  try {
    const { input, mode = "chat", deviceId } = req.body || {};

    if (!input || typeof input !== "string") {
      res.status(400).json({ error: "Missing input" });
      return;
    }

    const data = await preparePromptData(input, mode, deviceId);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const stream = await openai.chat.completions.create({
      model: data.isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: data.mathMode ? 0.1 : 0.2,
      max_tokens: getMaxTokens(data.youtubeMode ? "youtube" : data.mathMode ? "math" : mode, data.isPro),
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer, a fast premium AI assistant inside a Chrome extension. Give clean, structured answers. For Smart Browser AI, understand pages, selected text, websites, search pages, school assignments and math automatically."
        },
        {
          role: "user",
          content: data.prompt
        }
      ]
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({
      done: true,
      pro: data.isPro,
      pageType: data.pageType,
      mathMode: data.mathMode,
      usedSearch: Boolean(data.web.text),
      usedWolfram: Boolean(data.wolfram.text),
      usedYoutubeTranscript: Boolean(data.youtube.text),
      youtubeVideoId: data.youtube.videoId || null,
      sources: [
        ...data.web.sources.map(source => ({
          title: source.title,
          url: source.url
        })),
        ...data.wolfram.sources,
        ...(data.youtube.text
          ? [{
              title: "YouTube transcript",
              url: data.youtube.videoId ? `https://www.youtube.com/watch?v=${data.youtube.videoId}` : ""
            }]
          : [])
      ]
    })}\n\n`);

    res.end();
  } catch (error) {
    console.error("Stream error:", error);
    res.write(`data: ${JSON.stringify({ error: "Streaming failed" })}\n\n`);
    res.end();
  }
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

    const prompt = buildImagePrompt({ tool, question, isPro });

    const completion = await openai.chat.completions.create({
      model: isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: getMaxTokens("vision", isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer Vision AI. Analyze screenshots and images. Extract visible text, detect math, school assignments, page types and useful context. Be honest if something is unclear."
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
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
      tool
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

    const parsed = await pdfParse(req.file.buffer);
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

    const completion = await openai.chat.completions.create({
      model: isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: getMaxTokens("pdf", isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer PDF Assistant. Read PDF text carefully. Never invent page numbers or quotes."
        },
        { role: "user", content: prompt }
      ]
    });

    const answer =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Jeg kunne ikke analysere PDF'en.";

    res.json({
      answer,
      pro: isPro,
      fileName: req.file.originalname,
      pages: parsed.numpages || null,
      tool
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

    const data = await preparePromptData(input, mode, deviceId);

    const completion = await openai.chat.completions.create({
      model: data.isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: data.mathMode ? 0.1 : 0.2,
      max_tokens: getMaxTokens(data.youtubeMode ? "youtube" : data.mathMode ? "math" : mode, data.isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer, a fast premium AI assistant inside a Chrome extension. For Smart Browser AI, understand pages, selected text, websites, search pages, school assignments and math automatically."
        },
        { role: "user", content: data.prompt }
      ]
    });

    const answer =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Jeg kunne ikke lave et svar. Prøv igen.";

    res.json({
      answer,
      pro: data.isPro,
      usedSearch: Boolean(data.web.text),
      usedWolfram: Boolean(data.wolfram.text),
      usedYoutubeTranscript: Boolean(data.youtube.text),
      youtubeVideoId: data.youtube.videoId || null,
      mathMode: data.mathMode,
      pageType: data.pageType,
      sources: [
        ...data.web.sources.map(source => ({
          title: source.title,
          url: source.url
        })),
        ...data.wolfram.sources,
        ...(data.youtube.text
          ? [{
              title: "YouTube transcript",
              url: data.youtube.videoId ? `https://www.youtube.com/watch?v=${data.youtube.videoId}` : ""
            }]
          : [])
      ]
    });
  } catch (error) {
    console.error("Ask error:", error);

    res.status(500).json({
      error: "Server error",
      answer:
        "Der skete en fejl i AI-serveren. Prøv igen om lidt, eller gør spørgsmålet kortere."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Instant Answer backend running on http://localhost:${PORT}`);
});