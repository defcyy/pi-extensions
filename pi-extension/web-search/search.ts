import { assertHttpUrl, type SearchResult } from "./web.ts";

export type SearchProvider = "duckduckgo" | "serper";
export const SEARCH_OUTPUT_LIMIT = 12_000;
const FIELD_LIMIT = 1_000;

export function searchConfiguration(): { provider: SearchProvider; apiKey?: string } {
  const configured = process.env.PI_WEB_SEARCH_PROVIDER?.trim() || "duckduckgo";
  if (!["duckduckgo", "serper", "auto"].includes(configured)) {
    throw new Error("PI_WEB_SEARCH_PROVIDER must be duckduckgo, serper, or auto.");
  }
  const apiKey = process.env.SERPER_API_KEY?.trim();
  const provider: SearchProvider = configured === "serper" || (configured === "auto" && apiKey) ? "serper" : "duckduckgo";
  if (provider === "serper" && !apiKey) {
    throw new Error("Serper requires SERPER_API_KEY. Get a key at https://serper.dev, or select PI_WEB_SEARCH_PROVIDER=duckduckgo for keyless search.");
  }
  return { provider, ...(provider === "serper" ? { apiKey } : {}) };
}

export function serperRequest(query: string, count: number, recency?: "day" | "week" | "month" | "year") {
  const periods = { day: "d", week: "w", month: "m", year: "y" };
  return { q: query, num: count, ...(recency ? { tbs: `qdr:${periods[recency]}` } : {}) };
}

export function parseSerperResults(payload: unknown): SearchResult[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as any).organic)) {
    throw new Error("Serper returned an unexpected response: expected an organic results array.");
  }
  return (payload as { organic: unknown[] }).organic.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Serper returned a malformed result.");
    const result = item as Record<string, unknown>;
    if (typeof result.link !== "string" || typeof result.title !== "string" ||
        (result.snippet !== undefined && typeof result.snippet !== "string")) {
      throw new Error("Serper returned a malformed result.");
    }
    return { title: result.title, url: assertHttpUrl(result.link).toString(), snippet: result.snippet as string || "" };
  });
}

/** Bound complete result records, including data retained in tool details. */
export function budgetResults<T extends object>(results: T[], format: (result: T, index: number) => string) {
  const bounded: T[] = [];
  const records: string[] = [];
  let used = 0;
  let truncated = false;
  for (const result of results) {
    const entry = Object.fromEntries(Object.entries(result).map(([key, value]) => {
      if (key === "url" || key === "homepage" || typeof value !== "string" || value.length <= FIELD_LIMIT) return [key, value];
      truncated = true;
      return [key, value.slice(0, FIELD_LIMIT - 1) + "…"];
    })) as T;
    const record = format(entry, bounded.length);
    if (used + record.length + 2 > SEARCH_OUTPUT_LIMIT - 100) { truncated = true; break; }
    bounded.push(entry);
    records.push(record);
    used += record.length + 2;
  }
  return { results: bounded, text: records.join("\n\n") + (truncated ? "\n\n[Search output truncated.]" : ""), truncated };
}
