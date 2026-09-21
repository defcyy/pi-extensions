import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  appendSiteFilter,
  assertHttpUrl,
  clipContent,
  githubHeaders,
  githubSearchUrl,
  duckDuckGoSearchUrl,
  normalizeFetchedContent,
  parseDuckDuckGoResults,
  readResponseBody,
  type SearchResult,
} from "./web.ts";

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

interface TextResponse {
  response: Response;
  text: string;
  truncated: boolean;
}

async function requestText(
  url: string,
  init: RequestInit = {},
  parentSignal?: AbortSignal,
  failureLabel?: string,
): Promise<TextResponse> {
  const timeoutSignal = AbortSignal.timeout(20_000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, { ...init, signal, redirect: "follow" });
  if (failureLabel && !response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${failureLabel} failed with HTTP ${response.status} ${response.statusText}.`);
  }
  const body = await readResponseBody(response, signal);
  return { response, ...body };
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
  const { response, text } = await requestText(url, init, signal);
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`The search provider returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? `: ${payload.message}` : "";
    throw new Error(`The search provider returned HTTP ${response.status}${message}`);
  }
  return payload;
}

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

export default function webSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web through DuckDuckGo's HTML results. Use site to restrict to official documentation, GitHub, or another domain. No API key is required.",
    parameters: WebSearchParams,
    async execute(_toolCallId, params: WebSearchInput, signal) {
      const query = appendSiteFilter(params.query, params.site);
      if (!query.trim()) throw new Error("query cannot be blank.");
      const { response, text } = await requestText(
        duckDuckGoSearchUrl({ query, recency: params.recency }),
        { headers: { Accept: "text/html" } },
        signal,
        "DuckDuckGo search",
      );
      const results = parseDuckDuckGoResults(text).slice(0, params.numResults ?? 5);
      if (results.length === 0) {
        throw new Error("DuckDuckGo returned no recognizable result entries; its HTML markup may have changed or the request may have been challenged.");
      }
      return { content: [{ type: "text", text: formatResults(results) }], details: { query, results } };
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
      const payload = await fetchJson(url.toString(), { headers: githubHeaders() }, signal);
      const results = Array.isArray(payload.items) ? payload.items.map((item: any) => ({
        fullName: item.full_name,
        description: item.description ?? "",
        url: item.html_url,
        stars: item.stargazers_count ?? 0,
        language: item.language ?? undefined,
        updatedAt: item.updated_at ?? undefined,
        homepage: item.homepage || undefined,
      })) : [];
      const text = results.length === 0 ? "No repositories found." : results.map((result: any, index: number) =>
        `${index + 1}. ${result.fullName} · ★ ${result.stars}${result.language ? ` · ${result.language}` : ""}\n${result.url}\n${result.description}`,
      ).join("\n\n");
      return { content: [{ type: "text", text }], details: { query, results } };
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
      const payload = await fetchJson(url.toString(), { headers: githubHeaders() }, signal);
      const results = Array.isArray(payload.items) ? payload.items.map((item: any) => ({
        title: item.title,
        url: item.html_url,
        repository: item.repository_url?.replace("https://api.github.com/repos/", "") ?? "",
        number: item.number,
        state: item.state,
        kind: item.pull_request ? "pull request" : "issue",
        comments: item.comments ?? 0,
        updatedAt: item.updated_at,
      })) : [];
      const text = results.length === 0 ? "No issues or pull requests found." : results.map((result: any, index: number) =>
        `${index + 1}. ${result.repository}#${result.number} · ${result.kind} · ${result.state} · ${result.comments} comments\n${result.title}\n${result.url}`,
      ).join("\n\n");
      return { content: [{ type: "text", text }], details: { query, results } };
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
        { headers: { Accept: "text/html, text/plain, application/json, */*;q=0.1" } },
        signal,
        "Fetch",
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
