# pi-web-search

A compact web-access extension for everyday development research, keyless by default. It provides DuckDuckGo web search, GitHub repository and issue/PR search, and readable page fetching.

## Install

```bash
pi install git:github.com/defcyy/pi-extensions
```

For local development:

```bash
pnpm install
pi -e ./pi-extension/web-search/index.ts
```

Pi extensions run with your user permissions. Review the source before installation.

## Configuration

`web_search` defaults to DuckDuckGo's HTML results endpoint and needs no API key. To use Google's structured search results through Serper instead:

```bash
export PI_WEB_SEARCH_PROVIDER="serper"
export SERPER_API_KEY="your-serper-api-key"
```

Get a key at https://serper.dev. Supported provider values:

- `duckduckgo` (default): keyless, even if a Serper key is present.
- `serper`: requires a key; failures never silently fall back to DuckDuckGo.
- `auto`: selects Serper when a nonblank key exists, otherwise DuckDuckGo.

Configuration is read on each call from the running process environment. Changing variables in another shell does not update an already-running Pi process. Serper receives the query, site filter, result count, and recency filter; its API key is sent only to `https://google.serper.dev/search`. No credential files are read. Serper usage is subject to its pricing and limits.

GitHub tools work without authentication but GitHub's unauthenticated API limits are low. Set a token to increase the limit:

```bash
export GITHUB_TOKEN="github_pat_..."
```

The extension sends `GITHUB_TOKEN` only to the GitHub API. Authenticated API calls reject redirects to avoid forwarding credentials. Page fetching never includes either API credential.

Requests have a 20-second timeout and honor tool cancellation. HTTP 502/503/504 receives at most one retry after 250 ms (including Serper searches, which may consume another request). Authentication failures, rate limits, and bot challenges are not retried; rate-limit errors include retry/reset headers when available. Provider errors do not echo upstream response bodies.

## Tools

### `web_search`

Search the web through the configured provider. Use `site` to target official docs or another domain; any `site:` operators already in `query` are replaced by it. Prefer the GitHub tools for GitHub issues, PRs, and repositories.

DuckDuckGo searches are serialized and spaced at least 1.5 s apart, because parallel bursts trigger its bot challenge (often an HTTP 202 "anomaly" page). A detected challenge starts a five-minute cooldown for this extension instance: subsequent and already queued searches fail without another network request. Reloading resets this local state, not any upstream IP block. Use the GitHub tools or fetch a known URL instead. A genuine empty result returns "No results found."; malformed provider responses fail explicitly.

Search output is limited to 12,000 characters, with 1,000-character descriptive fields and complete result records. URLs are never shortened; oversized records are omitted. Truncation is marked in text and tool details. Details identify the web-search provider. Only organic Serper results are returned; knowledge graphs and related questions are not included.

```ts
web_search({
  query: "useEffect cleanup",
  site: "react.dev",
  recency: "year",
  numResults: 5,
});
```

### `github_repo_search`

Find repositories, optionally filtered by language or sorted by stars/updated time.

```ts
github_repo_search({ query: "fast node http framework", language: "TypeScript", sort: "stars" });
```

### `github_issue_search`

Search GitHub issues and pull requests globally or within a repository.

```ts
github_issue_search({
  repo: "vercel/next.js",
  query: '"Cannot find module"',
  state: "all",
  type: "issue",
  sort: "updated",
});
```

### `fetch_url`

Fetch a result page as readable text. HTML is simplified while preserving links, code whitespace and basic tables; JSON is formatted, and plain-text source files are preserved. Useful header/aside content is retained. Declared binary types (including PDFs and images) are rejected before reading their bodies. Missing content types are allowed, so binary sniffing is not guaranteed. Responses are limited to 1 MB read / 60,000 output characters.

```ts
fetch_url({ url: "https://react.dev/reference/react/useEffect" });
```

## Scope and limitations

This deliberately does not automate a browser, crawl sites, log in to websites, or create a separate documentation index. Use the `site` parameter to find official docs, then `fetch_url` to inspect the selected source. HTML extraction is a conservative regex-based fallback, not a browser or full HTML5 parser; complex layouts and relative links may still need manual interpretation. Search responses are not cached. DuckDuckGo's HTML endpoint is an external public webpage rather than a versioned search API, so its markup or availability may change.
