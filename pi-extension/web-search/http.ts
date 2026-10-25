import { setTimeout as sleep } from "node:timers/promises";
import { readResponseBody } from "./web.ts";

export async function requestText(
  url: string,
  init: RequestInit = {},
  parentSignal?: AbortSignal,
  failureLabel = "Request",
  validateContentType?: (contentType: string | null) => void,
): Promise<{ response: Response; text: string; truncated: boolean }> {
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    // Never forward API credentials through a redirect, even to a different API host.
    const response = await fetch(url, { ...init, signal, redirect: init.redirect ?? "error" });
    if ([502, 503, 504].includes(response.status) && attempt === 0) {
      await response.body?.cancel().catch(() => {});
      await sleep(250, undefined, { signal });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const retry = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      const guidance = limited ? ` Rate limited.${retry ? ` Retry-After: ${retry.slice(0, 100)}.` : ""}${reset ? ` Reset epoch: ${reset.slice(0, 100)}.` : ""}`
        : [401, 403].includes(response.status) ? " Check credentials and access permissions." : "";
      throw new Error(`${failureLabel} failed with HTTP ${response.status} ${response.statusText}.${guidance}`);
    }
    try {
      validateContentType?.(response.headers.get("content-type"));
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    const body = await readResponseBody(response, signal);
    return { response, ...body };
  }
}

export async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal, label = "Search provider"): Promise<any> {
  const { text, truncated } = await requestText(url, init, signal, label);
  if (truncated) throw new Error(`${label} returned an oversized JSON response.`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON.`); }
}

export function githubItems(payload: any, kind: "repositories" | "issues"): any[] {
  if (!payload || !Array.isArray(payload.items) || payload.items.some((item: any) =>
    !item || typeof item !== "object" || typeof item.html_url !== "string" ||
    (kind === "repositories"
      ? typeof item.full_name !== "string" || (item.description != null && typeof item.description !== "string")
      : typeof item.title !== "string" || typeof item.number !== "number" || typeof item.state !== "string" ||
        (item.repository_url != null && typeof item.repository_url !== "string")))) {
    throw new Error("GitHub returned an unexpected search response.");
  }
  return payload.items;
}
