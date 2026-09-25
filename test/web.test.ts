import assert from "node:assert/strict";
import test from "node:test";
import webSearchExtension from "../pi-extension/web-search/index.ts";
import {
  appendSiteFilter,
  assertHttpUrl,
  clipContent,
  createThrottle,
  duckDuckGoSearchUrl,
  isDuckDuckGoChallenge,
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

test("site filter replaces site: operators already written into the query", () => {
  assert.equal(
    appendSiteFilter("site:buf.build/docs gradle plugin build.buf", "buf.build"),
    "gradle plugin build.buf site:buf.build",
  );
  assert.equal(appendSiteFilter("site:a.com foo", undefined), "site:a.com foo");
  assert.equal(appendSiteFilter("site:a.com", "b.com"), "site:b.com");
});

test("DuckDuckGo bot challenges are detected by status or anomaly markup", () => {
  assert.equal(isDuckDuckGoChallenge(202, ""), true);
  assert.equal(isDuckDuckGoChallenge(200, '<div class="anomaly-modal__box"></div>'), true);
  assert.equal(isDuckDuckGoChallenge(200, '<a class="result__a" href="https://x.test">x</a>'), false);
});

test("web_search reports a DuckDuckGo challenge as a rate limit instead of a parse failure", async () => {
  const tools = new Map<string, any>();
  webSearchExtension({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<form id="challenge-form"></form>', { status: 202 })) as typeof fetch;
  try {
    await assert.rejects(
      tools.get("web_search").execute("challenged", { query: "typescript", site: "github.com" }),
      /rate-limited this IP with a bot challenge/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("throttle serializes tasks and spaces their starts", async () => {
  let clock = 0;
  const throttle = createThrottle(100, () => clock);
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    starts.push(clock);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock += 10;
    active -= 1;
  };
  await Promise.all([throttle(task), throttle(task), throttle(task)]);
  assert.equal(maxActive, 1);
  assert.equal(starts[0], 0);
  assert.equal(starts.length, 3);
});

test("throttle does not wedge after a failed task", async () => {
  const throttle = createThrottle(0);
  await assert.rejects(throttle(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await throttle(async () => "ok"), "ok");
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
