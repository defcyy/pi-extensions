import { isRecord } from "./util.ts";

const REPLACEMENT = "[REDACTED]";
const LIMITATION = "Pattern-based redaction is incomplete; review the exact payload for sensitive content before disclosure. It does not make untrusted instructions safe.";
const SECRET_KEY = "(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|(?:api|private|access|secret|client|encryption|signing)[_-]?key|(?:access|refresh|auth|id)[_-]?token|client[_-]?secret|credential|credentials|authorization|cookie|signature|sig)(?:[_-](?:id|secret|token|key|value))?";
const SECRET_PROPERTY = new RegExp(`^(?:${SECRET_KEY})$`, "i");
// Retry only at identifier boundaries, not every character of a long word.
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_-])((?:["']?)(?:${SECRET_KEY})(?:["']?)\\s*[:=]\\s*)(\\[REDACTED\\]|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s&#;,}\\]"'<>]+)`,
  "gi",
);

export interface TextRedaction {
  text: string;
  redactions: number;
  warnings: string[];
}

interface ValueRedaction {
  // Redaction changes values: callers must validate before assigning a domain type.
  value: unknown;
  redactions: number;
  warnings: string[];
}

type Replacement = string | ((match: string, ...captures: string[]) => string);

/** Defense in depth only: deliberately does not read auth files or the environment. */
export function redactText(input: string): TextRedaction {
  let text = input;
  let redactions = 0;
  const replace = (pattern: RegExp, replacement: Replacement): void => {
    text = text.replace(pattern, (match: string, ...args: unknown[]) => {
      // These expressions have no named groups; the final arguments are offset/input.
      const captures = args.slice(0, -2).map((value) => typeof value === "string" ? value : "");
      const result = typeof replacement === "string" ? replacement : replacement(match, ...captures);
      if (result !== match) redactions++;
      return result;
    });
  };

  // OSC hyperlinks, CSI, escape sequences, and terminal/bidi controls. Preserve CRLF.
  const clean = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
  const controlsRemoved = clean !== text;
  if (controlsRemoved) {
    redactions++;
    text = clean;
  }

  replace(/<\|(?:im_start|im_end|im_sep|endoftext|start_header_id|end_header_id|eot_id|start|end|message|channel|meta_sep|meta_start|system|developer|tool|user|assistant|fim_prefix|fim_middle|fim_suffix)\|>|\[\/?(?:INST|SYSTEM|DEVELOPER|ASSISTANT)\]|<<\/?SYS>>|<\/?(?:s|end_of_turn|system|developer|assistant|tool|user|untrusted_text|untrusted_data)(?:\s[^>]*|\s*)>/gi, "[neutralized-delimiter]");
  // Incomplete PEMs are withheld too, rather than leaking the remaining body.
  replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g, REPLACEMENT);
  replace(/\b(?:Authorization|Proxy-Authorization)\s*:\s*[^\r\n]+/gi,
    (match) => `${match.slice(0, match.indexOf(":"))}: ${REPLACEMENT}`);
  replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi, REPLACEMENT);
  replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    (match) => `${match.slice(0, match.indexOf(":"))}: ${REPLACEMENT}`);
  replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{25,}|npm_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}|dckr_pat_[A-Za-z0-9_-]{16,})\b/g, REPLACEMENT);
  replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REPLACEMENT);
  replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/<>"'`@]+@/gi,
    (_match, scheme) => `${scheme}${REPLACEMENT}@`);
  replace(/([?&](?:key|auth|code|session(?:id|_id)?|jwt)=)([^&#\s<>"'`]+)/gi,
    (_match, prefix, value) => prefix + (value === REPLACEMENT ? value : REPLACEMENT));
  replace(ASSIGNMENT, (_match, prefix, value) => {
    if (value === REPLACEMENT || value === `"${REPLACEMENT}"` || value === `'${REPLACEMENT}'`) {
      return prefix + value;
    }
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
    return prefix + quote + REPLACEMENT + quote;
  });

  return {
    text,
    redactions,
    warnings: [LIMITATION, ...(controlsRemoved ? ["Terminal or directional control characters were removed."] : [])],
  };
}

/** Clone plain JSON-like values. Keys and metadata are not blanket-masked.
 * Arbitrary class instances are rejected instead of pretending to preserve T.
 */
export function redactValue(value: unknown): ValueRedaction {
  let redactions = 0;
  const warnings = new Set<string>([LIMITATION]);
  const seen = new WeakMap<object, unknown>();

  function visit(input: unknown): unknown {
    if (typeof input === "string") {
      const result = redactText(input);
      redactions += result.redactions;
      result.warnings.forEach((warning) => warnings.add(warning));
      return result.text;
    }
    if (input === null || typeof input !== "object") {
      if (["function", "symbol", "bigint"].includes(typeof input)) {
        throw new Error("Redaction accepts plain JSON-like values only.");
      }
      return input;
    }
    if (seen.has(input)) return seen.get(input);
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      seen.set(input, output);
      for (const item of input) output.push(visit(item));
      return output;
    }
    if (!isRecord(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      throw new Error("Redaction accepts plain JSON-like values only.");
    }

    const output: Record<string, unknown> = {};
    seen.set(input, output);
    for (const [key, item] of Object.entries(input)) {
      const sensitive = SECRET_PROPERTY.test(key) && typeof item === "string" && item.length > 0;
      if (sensitive && item !== REPLACEMENT) redactions++;
      Object.defineProperty(output, key, {
        value: sensitive ? REPLACEMENT : visit(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  }

  return { value: visit(value), redactions, warnings: [...warnings] };
}
