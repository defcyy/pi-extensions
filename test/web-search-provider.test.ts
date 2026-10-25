import assert from "node:assert/strict";
import test from "node:test";
import extension from "../pi-extension/web-search/index.ts";
import { budgetResults, SEARCH_OUTPUT_LIMIT, searchConfiguration } from "../pi-extension/web-search/search.ts";
import { fetchJson } from "../pi-extension/web-search/http.ts";

function tools() {
  const registered = new Map<string, any>();
  extension({ registerTool(tool: any) { registered.set(tool.name, tool); } } as any);
  return registered;
}

async function fixture(provider: string, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const saved = { provider: process.env.PI_WEB_SEARCH_PROVIDER, serper: process.env.SERPER_API_KEY, github: process.env.GITHUB_TOKEN };
  process.env.PI_WEB_SEARCH_PROVIDER = provider;
  process.env.SERPER_API_KEY = "synthetic-serper-key";
  process.env.GITHUB_TOKEN = "synthetic-github-key";
  try { await run(); } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["PI_WEB_SEARCH_PROVIDER", saved.provider], ["SERPER_API_KEY", saved.serper], ["GITHUB_TOKEN", saved.github]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
}

test("provider selection is explicit and credentials are resolved on each call", async () => {
  await fixture("auto", async () => {
    assert.equal(searchConfiguration().provider, "serper");
    delete process.env.SERPER_API_KEY;
    assert.equal(searchConfiguration().provider, "duckduckgo");
    process.env.PI_WEB_SEARCH_PROVIDER = "serper";
    assert.throws(searchConfiguration, /SERPER_API_KEY/);
    process.env.PI_WEB_SEARCH_PROVIDER = "invalid";
    assert.throws(searchConfiguration, /must be/);
    delete process.env.PI_WEB_SEARCH_PROVIDER;
    process.env.SERPER_API_KEY = "synthetic";
    assert.equal(searchConfiguration().provider, "duckduckgo");
  });
});

test("Serper receives site, recency and count; credentials stay on their own API", async () => {
  await fixture("serper", async () => {
    const registered = tools();
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: any, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("google.serper.dev")) return Response.json({ organic: [{ title: "Docs", link: "https://docs.test/", snippet: "Reference" }] });
      if (String(url).includes("api.github.com")) return Response.json({ items: [] });
      const response = new Response("Page", { headers: { "content-type": "text/plain" } });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    }) as typeof fetch;
    const output = await registered.get("web_search").execute("s", { query: "api site:old.test", site: "docs.test", recency: "week", numResults: 3 });
    assert.equal(output.details.provider, "serper");
    assert.equal(output.details.results[0].url, "https://docs.test/");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { q: "api site:docs.test", num: 3, tbs: "qdr:w" });
    assert.equal(new Headers(calls[0].init.headers).get("X-API-KEY"), "synthetic-serper-key");
    assert.equal(new Headers(calls[0].init.headers).has("Authorization"), false);
    assert.equal(calls[0].init.redirect, "error");
    await registered.get("github_repo_search").execute("g", { query: "example" });
    assert.equal(new Headers(calls[1].init.headers).get("Authorization"), "Bearer synthetic-github-key");
    assert.equal(new Headers(calls[1].init.headers).has("X-API-KEY"), false);
    await registered.get("fetch_url").execute("f", { url: "https://docs.test/" });
    assert.equal(new Headers(calls[2].init.headers).has("Authorization"), false);
    assert.equal(new Headers(calls[2].init.headers).has("X-API-KEY"), false);
  });
});

test("queued DuckDuckGo calls stop after a challenge", async () => {
  await fixture("duckduckgo", async () => {
    const search = tools().get("web_search");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('<form id="challenge-form"></form>'); }) as typeof fetch;
    const outcomes = await Promise.allSettled([search.execute("a", { query: "one" }), search.execute("b", { query: "two" })]);
    assert.equal(calls, 1);
    assert.ok(outcomes.every((result) => result.status === "rejected"));
  });
});

test("malformed provider responses fail instead of looking empty, without fallback", async () => {
  await fixture("serper", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ unexpected: [] }); }) as typeof fetch;
    await assert.rejects(tools().get("web_search").execute("s", { query: "example" }), /unexpected response/);
    assert.equal(calls, 1);
    await assert.rejects(tools().get("github_issue_search").execute("g", { query: "example" }), /unexpected search response/);
  });
});

test("API failures distinguish limits, auth, invalid JSON and transient retries", async () => {
  await fixture("serper", async () => {
    globalThis.fetch = (async () => new Response("secret upstream body", { status: 429, headers: { "retry-after": "60" } })) as typeof fetch;
    await assert.rejects(fetchJson("https://example.test", {}), /Rate limited.*Retry-After: 60/);
    globalThis.fetch = (async () => new Response("secret upstream body", { status: 401 })) as typeof fetch;
    await assert.rejects(fetchJson("https://example.test", {}), (error: Error) => /credentials/.test(error.message) && !error.message.includes("secret"));
    globalThis.fetch = (async () => new Response("not JSON")) as typeof fetch;
    await assert.rejects(fetchJson("https://example.test", {}), /invalid JSON/);
    let attempts = 0;
    globalThis.fetch = (async () => ++attempts === 1 ? new Response("", { status: 503 }) : Response.json({ ok: true })) as typeof fetch;
    assert.deepEqual(await fetchJson("https://example.test", {}), { ok: true });
    assert.equal(attempts, 2);
  });
});

test("fetch_url rejects declared binary content before consuming a stalled body", async () => {
  await fixture("duckduckgo", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { "content-type": "application/pdf" },
    })) as typeof fetch;
    await assert.rejects(tools().get("fetch_url").execute("f", { url: "https://example.test/file.pdf" }), /Unsupported content type/);
    assert.equal(cancelled, true);
  });
});

test("empty structured results succeed and oversized JSON is rejected", async () => {
  await fixture("serper", async () => {
    globalThis.fetch = (async () => Response.json({ organic: [] })) as typeof fetch;
    const output = await tools().get("web_search").execute("s", { query: "example" });
    assert.deepEqual(output.details.results, []);
    assert.equal(output.details.truncated, false);
    globalThis.fetch = (async () => new Response(JSON.stringify({ organic: [], padding: "x".repeat(1_000_000) }))) as typeof fetch;
    await assert.rejects(tools().get("web_search").execute("s", { query: "example" }), /oversized JSON/);
  });
});

test("queued cancelled searches never issue another request", async () => {
  await fixture("duckduckgo", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('<a class="result__a" href="https://example.test">Example</a>'); }) as typeof fetch;
    const search = tools().get("web_search");
    const first = search.execute("a", { query: "example" });
    const controller = new AbortController();
    const second = search.execute("b", { query: "cancelled" }, controller.signal);
    controller.abort(new Error("cancelled"));
    await assert.rejects(second, /cancelled/);
    await first;
    assert.equal(calls, 1);
  });
});

test("search budgets bound text and details without splitting URLs", () => {
  const url = "https://example.test/" + "x".repeat(1500);
  const result = budgetResults(Array.from({ length: 10 }, () => ({ title: "t".repeat(5000), url, snippet: "s".repeat(5000) })),
    (item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`);
  assert.ok(result.text.length <= SEARCH_OUTPUT_LIMIT);
  assert.equal(result.truncated, true);
  assert.equal(result.results[0].url, url);
  assert.ok(result.results[0].snippet.length <= 1000);
  assert.ok(result.results.length < 10);
});
