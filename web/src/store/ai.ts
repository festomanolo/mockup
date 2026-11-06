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

function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object found");
  return JSON.parse(cleaned.slice(a, b + 1));
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "").trim() || s.slice(0, n));

/** Returns problems that justify one automatic retry. */
function problems(j: any, n: number): string[] {
  const out: string[] = [];
  if (!Array.isArray(j?.slides) || j.slides.length !== n) out.push(`"slides" must be an array of exactly ${n} items`);
  else j.slides.forEach((s: any, i: number) => {
    if (typeof s?.headline !== "string" || !s.headline.trim()) out.push(`slide ${i + 1} has no headline`);
    else if (words(s.headline) > LIMITS.headlineWords) out.push(`slide ${i + 1} headline has ${words(s.headline)} words (maximum ${LIMITS.headlineWords})`);
    if (typeof s?.sub !== "string") out.push(`slide ${i + 1} has no "sub"`);
  });
  if (typeof j?.store !== "object" || !j.store) out.push(`"store" object is missing`);
  return out;
}

function finalize(j: any, n: number): CopyResult {
  const warnings: string[] = [];
  const slides = Array.from({ length: n }, (_, i) => {
    const s = j?.slides?.[i] ?? {};
    let headline = typeof s.headline === "string" ? s.headline.trim() : "";
    const w = headline.split(/\s+/);
    if (w.length > LIMITS.headlineWords + 2) { headline = w.slice(0, LIMITS.headlineWords).join(" "); warnings.push(`Slide ${i + 1} headline was shortened.`); }
    return { headline, sub: clip(typeof s.sub === "string" ? s.sub.trim() : "", LIMITS.sub) };
  });
  const st = (j?.store ?? {}) as Record<string, unknown>;
  const limit: Record<keyof StoreCopy, number> = {
    title: LIMITS.title, subtitle: LIMITS.subtitle, short: LIMITS.short, promo: LIMITS.promo, keywords: LIMITS.keywords,
    description: LIMITS.description, whatsNew: LIMITS.whatsNew,
  };
  const store: Partial<StoreCopy> = {};
  for (const k of Object.keys(limit) as (keyof StoreCopy)[]) {
    const v = st[k];
    if (typeof v !== "string") continue;
    store[k] = v.trim().length > limit[k] ? clip(v.trim(), limit[k]) : v.trim();
    if (v.trim().length > limit[k]) warnings.push(`“${k}” was over its ${limit[k]}-character limit and was trimmed.`);
  }
  return { slides, store, warnings };
}

/** Generates all slide copy plus store text. One automatic retry with the validation errors fed back. */
export async function generateCopy(cfg: AiConfig, brief: Brief, n: number, signal: AbortSignal): Promise<CopyResult> {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: briefText(brief, n) }];
  let text = await chat(cfg, messages, signal);
  for (let attempt = 0; ; attempt++) {
    let json: any, errs: string[];
    try { json = extractJson(text); errs = problems(json, n); } catch (e) { errs = [`the answer was not valid JSON (${(e as Error).message})`]; }
    if (!errs.length) return finalize(json, n);
    if (attempt >= 1) {
      if (json && Array.isArray(json.slides) && json.slides.length >= 1) {
        const r = finalize({ ...json, slides: json.slides.slice(0, n) }, n);
        r.warnings.unshift(`The model did not fully follow the format (${errs[0]}). Review the text.`);
        return r;
      }
      throw new Error(`The model did not return usable JSON (${errs[0]}). Try another model.`);
    }
    messages.push({ role: "assistant", content: text }, { role: "user", content: `Fix these problems and return only the corrected JSON: ${errs.join("; ")}.` });
    text = await chat(cfg, messages, signal);
  }
}

/** Rewrites one slide's headline and sub-line, keeping the rest of the story in mind. */
export async function regenerateSlide(cfg: AiConfig, brief: Brief, all: { headline: string; sub: string }[], index: number, signal: AbortSignal): Promise<{ headline: string; sub: string }> {
  const ctx = all.map((s, i) => `${i + 1}. ${s.headline} — ${s.sub}`).join("\n");
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${briefText(brief, all.length)}\n\nCurrent slides:\n${ctx}\n\nWrite a different, fresher option for slide ${index + 1} only. Do not repeat the wording of the other slides. Return only JSON: {"headline":"","sub":""}` },
  ];
  let text = await chat(cfg, messages, signal);
  for (let attempt = 0; ; attempt++) {
    try {
      const j = extractJson(text);
      if (typeof j.headline === "string" && j.headline.trim() && words(j.headline) <= LIMITS.headlineWords + 1) {
        return { headline: j.headline.trim(), sub: clip(typeof j.sub === "string" ? j.sub.trim() : "", LIMITS.sub) };
      }
    } catch { /* retry */ }
    if (attempt >= 1) throw new Error("The model did not return a usable headline. Try again or edit it by hand.");
    messages.push({ role: "assistant", content: text }, { role: "user", content: `Return only valid JSON {"headline":"","sub":""} with a headline of at most ${LIMITS.headlineWords} words.` });
    text = await chat(cfg, messages, signal);
  }
}
