// Text-only AI helper. It talks to any OpenAI-compatible chat endpoint (OpenRouter, a local Ollama, or a custom URL)
// straight from the browser. The model writes words only (headlines, sub-lines and store text); the app does the
// design. Only the brief the user typed is sent: never screenshots, never the rendered images.
import { LIMITS, type StoreCopy } from "./model";

export type Provider = "openrouter" | "ollama" | "custom";
export type AiConfig = { provider: Provider; baseUrl: string; model: string; apiKey: string };

export const PROVIDERS: Record<Provider, { label: string; baseUrl: string; needsKey: boolean; host: string }> = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, host: "openrouter.ai" },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", needsKey: false, host: "your own computer" },
  custom: { label: "Custom (OpenAI-compatible)", baseUrl: "", needsKey: false, host: "the server you entered" },
};

export type Brief = { name: string; idea: string; audience: string; tone: string; language: string };
export type CopyResult = { slides: { headline: string; sub: string }[]; store: Partial<StoreCopy>; warnings: string[] };

const SYSTEM = `You are an expert App Store and Google Play copywriter (ASO). You write ONLY words; a separate tool designs the images.
Rules for screenshot captions:
- Each slide has a "headline" of 2-6 words (hard maximum 6) and a "sub" of one short sentence (maximum ${LIMITS.sub} characters).
- Slide 1 leads with the single biggest user benefit. Then follow a story: hook, pain solved, key features, social proof or trust.
- Benefit-led and concrete. No filler, no "the best", "#1", "free", emojis, ALL CAPS, competitor or platform names, or unverifiable claims.
- Headlines must work as large text on a phone-sized image, so keep them punchy.
Rules for store text (write in the requested language, natural and keyword-aware but never stuffed):
- title: max ${LIMITS.title} characters (app name plus, if room, one strong keyword).
- subtitle: max ${LIMITS.subtitle} characters (Apple). Do not repeat words used in the title.
- short: max ${LIMITS.short} characters (Google Play short description).
- promo: max ${LIMITS.promo} characters (Apple promotional text).
- keywords: max ${LIMITS.keywords} characters, comma-separated, no spaces after commas, no words already in title/subtitle, no brand or competitor names.
- description: up to 2500 characters; the first 3 lines must hook; short paragraphs and a bullet list of features; end with a call to action.
- whatsNew: 2-4 friendly lines for a first release.
Output ONLY one JSON object, no markdown fences, no commentary.`;

const SCHEMA = `{"slides":[{"headline":"","sub":""}],"store":{"title":"","subtitle":"","short":"","promo":"","keywords":"","description":"","whatsNew":""}}`;

const briefText = (b: Brief, n: number) =>
  `App name: ${b.name || "(not decided yet)"}\nWhat it does: ${b.idea}\nAudience: ${b.audience || "general"}\nTone: ${b.tone}\nLanguage to write in: ${b.language}\nNumber of slides: ${n}\nReturn exactly this JSON shape with exactly ${n} slides: ${SCHEMA}`;

function endpoint(cfg: AiConfig, path: string) {
  return `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
}

async function chat(cfg: AiConfig, messages: { role: string; content: string }[], signal: AbortSignal): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let res: Response;
  try {
    res = await fetch(endpoint(cfg, "/chat/completions"), {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.7, stream: false }),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(
      cfg.provider === "ollama"
        ? "Could not reach Ollama. Start it, and allow this page with: OLLAMA_ORIGINS=* ollama serve"
        : `Could not reach ${PROVIDERS[cfg.provider].label}. Check the URL and your connection.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("The provider rejected the API key.");
    if (res.status === 404 && cfg.provider === "ollama") throw new Error(`Ollama does not have the model “${cfg.model}”. Run: ollama pull ${cfg.model}`);
    throw new Error(`The provider returned ${res.status}. ${body.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => null);
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("The model returned an empty answer.");
  return text;
}

/** Lists available model names for the datalist; failures are fine (the field stays free text). */
export async function listModels(cfg: AiConfig): Promise<string[]> {
  try {
    if (cfg.provider === "ollama") {
      const origin = new URL(cfg.baseUrl).origin;
      const j = await (await fetch(`${origin}/api/tags`)).json();
      return (j.models ?? []).map((m: { name: string }) => m.name);
    }
    if (cfg.provider === "openrouter") {
      const j = await (await fetch(endpoint(cfg, "/models"))).json();
      return (j.data ?? []).map((m: { id: string }) => m.id).sort();
    }
  } catch { /* ignore */ }
  return [];
}

