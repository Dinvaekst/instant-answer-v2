import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Stripe from "stripe";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "4mb" }));

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

  if (text.includes("reddit.com") || text.includes("page type:\nreddit")) return "reddit";
  if (text.includes("google search results") || text.includes("search query:")) return "google";
  if (text.includes("youtube.com") || text.includes("page type:\nyoutube")) return "youtube";
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
  if (!process.env.WOLFRAM_APP_ID) {
    return { text: "", sources: [] };
  }

  if (!query || query.length < 2) {
    return { text: "", sources: [] };
  }

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

    if (usefulPods.length === 0) {
      return { text: "", sources: [] };
    }

    return {
      text: `
WOLFRAMALPHA MATH VALIDATION

Query:
${query}

Results:
${usefulPods.join("\n\n")}

Rules:
- Use this to validate calculations.
- If Wolfram gives a result, compare it with your own reasoning.
- Still explain step-by-step like a teacher.
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
You are Instant Answer Math, an expert math teacher inside a browser extension.

User plan: ${isPro ? "PRO" : "FREE"}

Main goal:
Build the best browser math helper for students.

Math rules:
- Understand equations, functions, word problems and gymnasium-level math.
- Solve step-by-step.
- Explain like a teacher.
- Use simple language.
- Always identify what is given and what must be found.
- Show formulas before using them.
- Use clean LaTeX for formulas.
- Put important formulas in LaTeX using \\( ... \\) or \\[ ... \\].
- Check the final answer.
- If there are multiple methods, choose the simplest one first.
- If the problem is unclear, make the most reasonable assumption and say it shortly.
- Do not skip algebra steps.
- For word problems: write "Given", "Find", "Formula", "Calculation", "Answer".
- For graph questions: describe shape, intersections, slope, vertex and important points.
- For validation: compare your result with WolframAlpha if included.

Output format:
1. Short answer
2. Step-by-step solution
3. Formula / LaTeX
4. Final answer
5. Check

If graph data is useful, include a small graph instruction like:
GRAPH:
y = expression

${wolframText}

User input:
${limitText(input, isPro ? 24000 : 14000)}
`;
}

function buildPrompt(mode, input, isPro, pageType, wolframText = "") {
  if (isMathRequest(input, mode)) {
    return buildMathPrompt(input, isPro, wolframText);
  }

  return `
You are Instant Answer.

User plan: ${isPro ? "PRO" : "FREE"}
Mode: ${mode}
Page type: ${pageType}

Main rules:
- Answer in the same language as the user.
- Do exactly what the user asks.
- Be direct, useful and human.
- If the user asks for text, write the text.
- If the user asks for a long answer, write a long answer.
- If it cannot fit, write Part 1 and end with: "Skriv fortsæt, så skriver jeg næste del."
- Do not invent facts, quotes, sources or page numbers.
- Use current page context if included.
- If web results are included, trust them more than old knowledge.
- For Google results: understand the search intent and summarize the best answer.
- For Reddit: summarize opinions, patterns, warnings and useful points.
- For webpages: focus on the visible content and user question.

Quality:
- Strong structure.
- Clear explanation.
- Concrete examples when useful.
- No generic filler.

User input:
${limitText(input, isPro ? 24000 : 14000)}
`;
}

function getMaxTokens(mode, isPro) {
  if (isPro) {
    if (mode === "quick") return 700;
    if (mode === "math") return 4200;
    if (mode === "assignment") return 4000;
    if (mode === "study") return 3800;
    if (mode === "deep") return 3800;
    return 3500;
  }

  if (mode === "quick") return 300;
  if (mode === "math") return 1700;
  if (mode === "assignment") return 1400;
  if (mode === "study") return 1400;
  if (mode === "deep") return 1400;
  return 1200;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Instant Answer backend is running",
    version: "1.4-math-upgrade"
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
        <head>
          <title>Instant Answer Pro</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background: #f7f7f7;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
            }
            .box {
              background: white;
              padding: 28px;
              border-radius: 16px;
              box-shadow: 0 4px 18px rgba(0,0,0,0.1);
              max-width: 420px;
              text-align: center;
            }
            p { color: #555; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="box">
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

app.post("/ask", async (req, res) => {
  try {
    const { input, mode = "chat", deviceId } = req.body || {};

    if (!input || typeof input !== "string") {
      return res.status(400).json({
        error: "Missing input",
        answer: "Der mangler input."
      });
    }

    const isPro = isProUser(deviceId);
    const pageType = detectPageType(input);
    const latestMessage = extractLatestUserMessage(input);

    const mathMode = isMathRequest(input, mode);
    const useSearch = shouldUseWebSearch(input, mode);

    const web = useSearch ? await searchWeb(latestMessage, isPro) : { text: "", sources: [] };
    const wolfram = mathMode ? await askWolframAlpha(latestMessage) : { text: "", sources: [] };

    const finalInput = `
${input}

${web.text ? web.text : ""}

${wolfram.text ? wolfram.text : ""}
`;

    const prompt = buildPrompt(mode, finalInput, isPro, pageType, wolfram.text);

    const completion = await openai.chat.completions.create({
      model: isPro ? "gpt-4o" : "gpt-4o-mini",
      temperature: mathMode ? 0.1 : isPro ? 0.2 : 0.3,
      max_tokens: getMaxTokens(mathMode ? "math" : mode, isPro),
      messages: [
        {
          role: "system",
          content:
            "You are Instant Answer, a fast premium AI assistant inside a Chrome extension. For math, act like a precise teacher: solve step-by-step, use LaTeX, validate calculations, and explain clearly."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const answer =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Jeg kunne ikke lave et svar. Prøv igen.";

    res.json({
      answer,
      pro: isPro,
      usedSearch: Boolean(web.text),
      usedWolfram: Boolean(wolfram.text),
      mathMode,
      pageType,
      sources: [
        ...web.sources.map(source => ({
          title: source.title,
          url: source.url
        })),
        ...wolfram.sources
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