# pi-web-search

A compact, keyless web-access extension for everyday development research. It provides DuckDuckGo web search, GitHub repository and issue/PR search, and readable page fetching.

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

`web_search` uses DuckDuckGo's HTML results endpoint and needs no API key.

GitHub tools work without authentication but GitHub's unauthenticated API limits are low. Set a token to increase the limit:

```bash
export GITHUB_TOKEN="github_pat_..."
```

The extension sends `GITHUB_TOKEN` only to the GitHub API.

## Tools

### `web_search`

Search the web through DuckDuckGo. Use `site` to target official docs, GitHub, or another domain.

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

Fetch a result page as readable text. HTML is simplified, JSON is formatted, and plain-text source files are preserved. Responses are limited to 1 MB read / 60,000 output characters.

```ts
fetch_url({ url: "https://react.dev/reference/react/useEffect" });
```

## Scope and limitations

This deliberately does not automate a browser, crawl sites, log in to websites, or create a separate documentation index. Use `site:` filtering to find official docs, then `fetch_url` to inspect the selected source. DuckDuckGo's HTML endpoint is an external public webpage rather than a versioned search API, so its markup or availability may change.
