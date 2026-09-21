import assert from "node:assert/strict";
import test from "node:test";
import webSearchExtension from "../pi-extension/web-search/index.ts";
import {
  appendSiteFilter,
  assertHttpUrl,
  clipContent,
  duckDuckGoSearchUrl,
  githubSearchUrl,
  htmlToText,
  normalizeFetchedContent,
  parseDuckDuckGoResults,
} from "../pi-extension/web-search/web.ts";

test("the extension exposes only the four focused web tools", () => {
  const tools: string[] = [];
  webSearchExtension({
    registerTool(tool: { name: string }) { tools.push(tool.name); },
  } as any);
  assert.deepEqual(tools, [
    "web_search",
    "github_repo_search",
    "github_issue_search",
    "fetch_url",
  ]);
});

test("an already-aborted tool signal reaches the request", async () => {
  const tools = new Map<string, any>();
  webSearchExtension({
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as any);
  const originalFetch = globalThis.fetch;
  let observedAborted = false;
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    observedAborted = init?.signal?.aborted === true;
    throw init?.signal instanceof AbortSignal ? init.signal.reason : new Error("missing signal");
  }) as typeof fetch;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  try {
    await assert.rejects(
      tools.get("web_search").execute("call", { query: "typescript" }, controller.signal),
      /cancelled/,
    );
    assert.equal(observedAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url rejects a non-OK response before reading a stalled body", async () => {
  const tools = new Map<string, any>();
  webSearchExtension({
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as any);
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(
    new ReadableStream({ cancel() { cancelled = true; } }),
    { status: 404, statusText: "Not Found" },
  )) as typeof fetch;
  try {
    const outcome = await Promise.race([
      tools.get("fetch_url").execute("stalled-404", { url: "https://example.test/missing" })
        .then(() => "resolved", (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 250)),
    ]);
    assert.equal(outcome, "Fetch failed with HTTP 404 Not Found.");
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DuckDuckGo queries keep the user query and apply site/recency filters", () => {
  const query = appendSiteFilter('"Cannot find module" vite', "vite.dev/");
  assert.equal(query, '"Cannot find module" vite site:vite.dev');
  const url = new URL(duckDuckGoSearchUrl({ query, recency: "week" }));
  assert.equal(url.hostname, "html.duckduckgo.com");
  assert.equal(url.searchParams.get("q"), query);
  assert.equal(url.searchParams.get("df"), "w");
});

test("DuckDuckGo result parsing resolves redirect URLs and extracts snippets", () => {
  const results = parseDuckDuckGoResults(`
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference">React Reference</a>
      <a class="result__snippet">Official React &amp; API documentation.</a>
    </div>
    <div class="result">
      <a class="result__a extra" href="https://typescriptlang.org/docs/">TypeScript Docs</a>
      <div class="result__snippet">Documentation for TypeScript.</div>
    </div>
  `);
  assert.deepEqual(results, [
    {
      title: "React Reference",
      url: "https://react.dev/reference",
      snippet: "Official React & API documentation.",
    },
    {
      title: "TypeScript Docs",
      url: "https://typescriptlang.org/docs/",
      snippet: "Documentation for TypeScript.",
    },
  ]);
});

test("GitHub search URL encodes qualifiers", () => {
  const url = new URL(githubSearchUrl("issues", '"fetch failed" repo:nodejs/node is:open', 10));
  assert.equal(url.pathname, "/search/issues");
  assert.equal(url.searchParams.get("q"), '"fetch failed" repo:nodejs/node is:open');
  assert.equal(url.searchParams.get("per_page"), "10");
});

test("HTML extraction removes non-readable elements and retains readable text", () => {
  const result = htmlToText(`
    <html><head><title>Example &amp; Docs</title><style>.x { color: red }</style></head>
    <body><nav>Navigation</nav><main><h1>Hello</h1><p>Use &lt;code&gt; safely.</p><script>alert(1)</script><ul><li>One</li></ul></main></body></html>
  `);
  assert.equal(result.title, "Example & Docs");
  assert.match(result.content, /Hello/);
  assert.match(result.content, /Use <code> safely\./);
  assert.match(result.content, /- One/);
  assert.doesNotMatch(result.content, /Navigation|alert|color: red/);
});

test("fetch helpers validate URL, format JSON, and clip content", () => {
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), /http or https/);
  assert.equal(assertHttpUrl("https://example.com/docs").hostname, "example.com");
  assert.equal(normalizeFetchedContent("application/json", '{"answer":42}').content, '{\n  "answer": 42\n}');
  assert.equal(clipContent("short").truncated, false);
});
