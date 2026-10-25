import { setTimeout as sleep } from "node:timers/promises";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_FETCH_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 60_000;

const SITE_OPERATOR = /(^|\s)site:\S+/gi;

/**
 * Apply the `site` parameter as a single `site:` operator. When `site` is set,
 * any `site:` operators the model also wrote into the query are dropped so the
 * search engine never receives conflicting restrictions.
 */
export function appendSiteFilter(query: string, site?: string): string {
  const normalizedSite = site?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!normalizedSite) return query.trim();
  const strippedQuery = query.replace(SITE_OPERATOR, " ").replace(/\s+/g, " ").trim();
  return strippedQuery ? `${strippedQuery} site:${normalizedSite}` : `site:${normalizedSite}`;
}

/**
 * DuckDuckGo answers automated traffic bursts with HTTP 202 and an "anomaly"
 * challenge page instead of results.
 */
export function isDuckDuckGoChallenge(status: number, html: string): boolean {
  if (status === 202) return true;
  return /anomaly-modal|anomaly\.js|challenge-form/i.test(html);
}

/**
 * Serializes calls and keeps a minimum gap between their starts. Parallel
 * bursts of searches are what trigger DuckDuckGo's bot challenge.
 */
export function createThrottle(minIntervalMs: number) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  return function throttle<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = tail.then(async () => {
      signal?.throwIfAborted();
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait, undefined, { signal });
      signal?.throwIfAborted();
      lastStart = Date.now();
      return task();
    });
    tail = run.catch(() => {});
    return run;
  };
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

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    copy: "©", reg: "®", ndash: "–", mdash: "—", hellip: "…",
  };
  // Decode once: &amp;lt; is literal &lt;, not a second layer of markup.
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? match;
    const hex = entity[1].toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
      && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return match ? plainTextFromHtml(match[1]) || undefined : undefined;
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, "i"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtml(value);
}

function hasClass(attributes: string, className: string): boolean {
  return (htmlAttribute(attributes, "class") ?? "").split(/\s+/).includes(className);
}

function duckDuckGoResultUrl(href: string): string | undefined {
  try {
    const url = new URL(href, "https://html.duckduckgo.com/");
    const redirected = url.searchParams.get("uddg");
    return assertHttpUrl(redirected ?? url.toString()).toString();
  } catch {
    return undefined;
  }
}

/** Parse the stable result anchor/snippet classes from DuckDuckGo's HTML endpoint. */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const anchors = [...html.matchAll(/<a\b([\s\S]*?)>([\s\S]*?)<\/a\s*>/gi)]
    .filter((match) => hasClass(match[1], "result__a"));
  const seen = new Set<string>();
  return anchors.flatMap((anchor, index) => {
    const href = htmlAttribute(anchor[1], "href");
    const url = href ? duckDuckGoResultUrl(href) : undefined;
    if (!url || seen.has(url)) return [];
    seen.add(url);
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
  // Protected fragments retain code whitespace and decoded attribute values.
  // This is deliberately a bounded HTML-to-text fallback, not an HTML5 parser.
  const fragments: string[] = [];
  const protect = (text: string): string => {
    const expanded = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => fragments[Number(index)]);
    return `\u0000${fragments.push(expanded) - 1}\u0000`;
  };
  const codeSpan = (text: string): string => {
    const ticks = "`".repeat([...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0) + 1);
    return `${ticks} ${text} ${ticks}`;
  };
  const content = decodeHtml(
    html.replace(/\u0000/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|svg|template|nav|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, body: string) => {
        const text = decodeHtml(body.replace(/<[^>]*>/g, "")).replace(/^\n|\n$/g, "");
        const fence = "`".repeat([...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 2) + 1);
        return `\n\n${protect(`${fence}\n${text}\n${fence}`)}\n\n`;
      })
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_match, body: string) =>
        protect(codeSpan(decodeHtml(body.replace(/<[^>]*>/g, "")))))
      .replace(/<a\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/a\s*>/gi,
        (_match, attributes: string, body: string) => {
          const href = htmlAttribute(attributes, "href");
          const label = plainTextFromHtml(body).replace(/([\[\]\\])/g, "\\$1");
          if (!href || /^(?:javascript|data|vbscript):/i.test(href.replace(/[\s\u0000-\u001f]/g, ""))) return protect(label);
          const destination = href.replace(/\s/g, (c) => encodeURIComponent(c))
            .replace(/</g, "%3C").replace(/>/g, "%3E");
          return protect(`[${label}](<${destination}>)`);
        })
      .replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_match, body: string) => {
        const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
          [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)]
            .map((cell) => plainTextFromHtml(cell[1]).replace(/\|/g, "\\|")));
        if (!rows.length) return body;
        const width = Math.max(...rows.map((row) => row.length));
        const lines = rows.map((row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`);
        lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
        return `\n\n${protect(lines.join("\n"))}\n\n`;
      })
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|header|footer|nav|aside|h[1-6]|li|tr|pre|blockquote)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => fragments[Number(index)]);
  return { title, content };
}

/** Validate response headers before reading a potentially binary/stalled body.
 * Missing Content-Type remains allowed for servers that omit it.
 */
export function assertSupportedContentType(contentType: string | null): void {
  const mime = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (!mime || mime.startsWith("text/") || /^application\/(?:json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|x-javascript|graphql|sql|toml|yaml|x-yaml)$/.test(mime)) return;
  throw new Error(`Unsupported content type: ${mime}. Only textual content is supported.`);
}

export function normalizeFetchedContent(contentType: string | null, body: string): { title?: string; content: string } {
  assertSupportedContentType(contentType);
  const mime = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return htmlToText(body);
  if (mime === "application/json" || mime?.endsWith("+json")) {
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
