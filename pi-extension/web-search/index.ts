import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  appendSiteFilter,
  assertHttpUrl,
  assertSupportedContentType,
  clipContent,
  createThrottle,
  githubHeaders,
  githubSearchUrl,
  duckDuckGoSearchUrl,
  isDuckDuckGoChallenge,
  normalizeFetchedContent,
  parseDuckDuckGoResults,
  type SearchResult,
} from "./web.ts";

import { requestText, fetchJson, githubItems } from "./http.ts";
import { budgetResults, parseSerperResults, searchConfiguration, serperRequest } from "./search.ts";

const Recency = StringEnum(["day", "week", "month", "year"] as const);
const RepoSort = StringEnum(["best-match", "stars", "updated"] as const);
const IssueState = StringEnum(["open", "closed", "all"] as const);
const IssueType = StringEnum(["issue", "pr", "all"] as const);
const IssueSort = StringEnum(["best-match", "updated", "comments", "created"] as const);

const WebSearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Web search query" }),
  site: Type.Optional(Type.String({ minLength: 1, description: "Restrict results to a domain, e.g. react.dev or github.com" })),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Results to return; default 5" })),
  recency: Type.Optional(Recency),
});
const GithubRepoSearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Repository search query" }),
  language: Type.Optional(Type.String({ minLength: 1, description: "Optional GitHub language qualifier" })),
  sort: Type.Optional(RepoSort),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Results to return; default 5" })),
});
const GithubIssueSearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Issue or pull-request query; exact errors should be quoted" }),
  repo: Type.Optional(Type.String({ minLength: 3, description: "Optional owner/repository restriction, e.g. vercel/next.js" })),
  state: Type.Optional(IssueState),
  type: Type.Optional(IssueType),
  sort: Type.Optional(IssueSort),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Results to return; default 5" })),
});
const FetchUrlParams = Type.Object({
  url: Type.String({ minLength: 1, description: "Absolute HTTP(S) URL to fetch" }),
});

type WebSearchInput = Static<typeof WebSearchParams>;
type GithubRepoSearchInput = Static<typeof GithubRepoSearchParams>;
type GithubIssueSearchInput = Static<typeof GithubIssueSearchParams>;
type FetchUrlInput = Static<typeof FetchUrlParams>;

function formatResults(results: SearchResult[]): string {
  return results.length === 0
    ? "No results found."
    : results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join("\n\n");
}

function normalizeRepo(value: string): string {
  const repo = value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must use the owner/repository form.");
  return repo;
}

// One DuckDuckGo request at a time, spaced out: parallel bursts trigger its bot challenge.
const DUCKDUCKGO_MIN_INTERVAL_MS = 1_500;

const DUCKDUCKGO_CHALLENGE_MESSAGE =
  "DuckDuckGo rate-limited this IP with a bot challenge; retrying now will not help and the block usually lasts several minutes. " +
  "Stop issuing web_search calls for now. Use github_issue_search / github_repo_search for GitHub content, or fetch_url on a known documentation URL.";

export default function webSearch(pi: ExtensionAPI) {
  const throttleDuckDuckGo = createThrottle(DUCKDUCKGO_MIN_INTERVAL_MS);
  let challengedUntil = 0;

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using the configured provider (DuckDuckGo by default, optionally Serper). Use site to restrict to a domain; do not also write site: in query. DuckDuckGo searches run one at a time. For GitHub issues, PRs, or repositories prefer github_issue_search / github_repo_search.",
    parameters: WebSearchParams,
    async execute(_toolCallId, params: WebSearchInput, signal) {
      const query = appendSiteFilter(params.query, params.site);
      if (!query.trim()) throw new Error("query cannot be blank.");
      const { provider, apiKey } = searchConfiguration();
      let results: SearchResult[];
      let text = "";
      if (provider === "serper") {
        const payload = await fetchJson("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": apiKey!, "Content-Type": "application/json" },
          body: JSON.stringify(serperRequest(query, params.numResults ?? 5, params.recency)),
        }, signal, "Serper search");
        results = parseSerperResults(payload).slice(0, params.numResults ?? 5);
      } else {
        results = await throttleDuckDuckGo(async () => {
          if (Date.now() < challengedUntil) {
            throw new Error(`${DUCKDUCKGO_CHALLENGE_MESSAGE} Cooldown: ${Math.ceil((challengedUntil - Date.now()) / 1000)} seconds remaining.`);
          }
          const fetched = await requestText(
            duckDuckGoSearchUrl({ query, recency: params.recency }),
            { headers: { Accept: "text/html" } }, signal, "DuckDuckGo search",
          );
          text = fetched.text;
          if (isDuckDuckGoChallenge(fetched.response.status, text)) {
            challengedUntil = Date.now() + 5 * 60_000;
            throw new Error(DUCKDUCKGO_CHALLENGE_MESSAGE);
          }
          return parseDuckDuckGoResults(text).slice(0, params.numResults ?? 5);
        }, signal);
      }
      if (results.length === 0) {
        if (provider === "duckduckgo" && !/class=["'][^"']*\bno-results\b/i.test(text)) {
          throw new Error("DuckDuckGo returned a page without recognizable result markup; its HTML format may have changed.");
        }
        return {
          content: [{ type: "text", text: "No results found. Try fewer or broader terms, or drop site/recency." }],
          details: { query, provider, results, truncated: false },
        };
      }
      const output = budgetResults(results, (result, index) => formatResults([result]).replace(/^1\./, `${index + 1}.`));
      return { content: [{ type: "text", text: output.text }], details: { query, provider, results: output.results, truncated: output.truncated } };
    },
  });

  pi.registerTool({
    name: "github_repo_search",
    label: "GitHub Repository Search",
    description: "Find GitHub repositories by name, topic, or keyword. GITHUB_TOKEN is optional but raises GitHub API limits.",
    parameters: GithubRepoSearchParams,
    async execute(_toolCallId, params: GithubRepoSearchInput, signal) {
      const query = `${params.query.trim()}${params.language?.trim() ? ` language:${params.language.trim()}` : ""}`;
      if (!query.trim()) throw new Error("query cannot be blank.");
      const url = new URL(githubSearchUrl("repositories", query, params.numResults ?? 5));
      if (params.sort && params.sort !== "best-match") url.searchParams.set("sort", params.sort);
      const payload = await fetchJson(url.toString(), { headers: githubHeaders() }, signal, "GitHub search");
      const results = githubItems(payload, "repositories").slice(0, params.numResults ?? 5).map((item: any) => ({
        fullName: item.full_name,
        description: item.description ?? "",
        url: item.html_url,
        stars: item.stargazers_count ?? 0,
        language: item.language ?? undefined,
        updatedAt: item.updated_at ?? undefined,
        homepage: item.homepage || undefined,
      }));
      const output = budgetResults(results, (result, index) =>
        `${index + 1}. ${result.fullName} · ★ ${result.stars}${result.language ? ` · ${result.language}` : ""}\n${result.url}\n${result.description}`);
      return { content: [{ type: "text", text: output.text || "No repositories found." }], details: { query, results: output.results, truncated: output.truncated } };
    },
  });

  pi.registerTool({
    name: "github_issue_search",
    label: "GitHub Issue Search",
    description: "Search GitHub issues and pull requests, optionally within one repository. GITHUB_TOKEN is optional but raises GitHub API limits.",
    parameters: GithubIssueSearchParams,
    async execute(_toolCallId, params: GithubIssueSearchInput, signal) {
      const qualifiers = [
        params.repo ? `repo:${normalizeRepo(params.repo)}` : "",
        params.state && params.state !== "all" ? `is:${params.state}` : "",
        params.type && params.type !== "all" ? `is:${params.type}` : "",
      ].filter(Boolean);
      const query = [params.query.trim(), ...qualifiers].filter(Boolean).join(" ");
      if (!query.trim()) throw new Error("query cannot be blank.");
      const url = new URL(githubSearchUrl("issues", query, params.numResults ?? 5));
      if (params.sort && params.sort !== "best-match") url.searchParams.set("sort", params.sort);
      const payload = await fetchJson(url.toString(), { headers: githubHeaders() }, signal, "GitHub search");
      const results = githubItems(payload, "issues").slice(0, params.numResults ?? 5).map((item: any) => ({
        title: item.title,
        url: item.html_url,
        repository: item.repository_url?.replace("https://api.github.com/repos/", "") ?? "",
        number: item.number,
        state: item.state,
        kind: item.pull_request ? "pull request" : "issue",
        comments: item.comments ?? 0,
        updatedAt: item.updated_at,
      }));
      const output = budgetResults(results, (result, index) =>
        `${index + 1}. ${result.repository}#${result.number} · ${result.kind} · ${result.state} · ${result.comments} comments\n${result.title}\n${result.url}`);
      return { content: [{ type: "text", text: output.text || "No issues or pull requests found." }], details: { query, results: output.results, truncated: output.truncated } };
    },
  });

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch an HTTP(S) result page, README, issue, source file, or documentation page and return readable text.",
    parameters: FetchUrlParams,
    async execute(_toolCallId, params: FetchUrlInput, signal) {
      const requestedUrl = assertHttpUrl(params.url).toString();
      const { response, text, truncated: bodyTruncated } = await requestText(
        requestedUrl,
        { headers: { Accept: "text/html, text/plain, application/json, */*;q=0.1" }, redirect: "follow" },
        signal,
        "Fetch",
        assertSupportedContentType,
      );
      const finalUrl = assertHttpUrl(response.url).toString();
      const contentType = response.headers.get("content-type");
      const normalized = normalizeFetchedContent(contentType, text);
      const clipped = clipContent(normalized.content);
      const truncated = bodyTruncated || clipped.truncated;
      const heading = [normalized.title, finalUrl, contentType].filter(Boolean).join("\n");
      const suffix = truncated ? "\n\n[Content truncated; fetch a more specific URL.]" : "";
      return {
        content: [{ type: "text", text: `${heading}\n\n${clipped.content}${suffix}` }],
        details: { url: finalUrl, title: normalized.title, contentType, truncated },
      };
    },
  });
}
