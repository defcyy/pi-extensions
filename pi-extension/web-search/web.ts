export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_FETCH_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 60_000;

export function appendSiteFilter(query: string, site?: string): string {
  const normalizedQuery = query.trim();
  const normalizedSite = site?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return normalizedSite ? `${normalizedQuery} site:${normalizedSite}` : normalizedQuery;
}

export function duckDuckGoSearchUrl(params: {
  query: string;
  recency?: "day" | "week" | "month" | "year";
}): string {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", params.query);
  const dateFilter = params.recency === "day" ? "d"
    : params.recency === "week" ? "w"
      : params.recency === "month" ? "m"
        : params.recency === "year" ? "y" : undefined;
  if (dateFilter) url.searchParams.set("df", dateFilter);
  return url.toString();
}

export function githubSearchUrl(kind: "repositories" | "issues", query: string, perPage: number): string {
  const url = new URL(`https://api.github.com/search/${kind}`);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(perPage));
  return url.toString();
}

export function assertHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a valid absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https.");
  }
  return url;
}

export function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function readResponseBody(response: Response, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_FETCH_BYTES - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, Math.max(0, remaining)));
        total = MAX_FETCH_BYTES;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_FETCH_BYTES) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

export function plainTextFromHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match, code: string) => {
      const value = code.startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isSafeInteger(value) ? String.fromCodePoint(value) : "";
    });
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return match ? plainTextFromHtml(match[1]) || undefined : undefined;
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2];
}

function hasClass(attributes: string, className: string): boolean {
  return (htmlAttribute(attributes, "class") ?? "").split(/\s+/).includes(className);
}

function duckDuckGoResultUrl(href: string): string | undefined {
  try {
    const url = new URL(href, "https://html.duckduckgo.com/");
    const redirected = url.searchParams.get("uddg");
    return redirected ? new URL(redirected).toString() : url.toString();
  } catch {
    return undefined;
  }
}

/** Parse the stable result anchor/snippet classes from DuckDuckGo's HTML endpoint. */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const anchors = [...html.matchAll(/<a\b([\s\S]*?)>([\s\S]*?)<\/a\s*>/gi)]
    .filter((match) => hasClass(match[1], "result__a"));
  return anchors.flatMap((anchor, index) => {
    const href = htmlAttribute(anchor[1], "href");
    const url = href ? duckDuckGoResultUrl(href) : undefined;
    if (!url) return [];
    const nextStart = anchors[index + 1]?.index ?? html.length;
    const followingHtml = html.slice((anchor.index ?? 0) + anchor[0].length, nextStart);
    const snippetMatch = [...followingHtml.matchAll(/<(?:a|div|span)\b([\s\S]*?)>([\s\S]*?)<\/(?:a|div|span)\s*>/gi)]
      .find((match) => hasClass(match[1], "result__snippet"));
    return [{
      title: plainTextFromHtml(anchor[2]) || "Untitled result",
      url,
      snippet: snippetMatch ? plainTextFromHtml(snippetMatch[2]) : "",
    }];
  });
}

export function htmlToText(html: string): { title?: string; content: string } {
  const title = extractTitle(html);
  const content = decodeHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|header|footer|nav|aside|h[1-6]|li|tr|pre|blockquote)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title, content };
}

export function normalizeFetchedContent(contentType: string | null, body: string): { title?: string; content: string } {
  if (contentType?.toLowerCase().includes("text/html")) return htmlToText(body);
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      return { content: JSON.stringify(JSON.parse(body), null, 2) };
    } catch {
      // Keep malformed JSON as text.
    }
  }
  return { content: body };
}

export function clipContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_OUTPUT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}
