import { posix } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./util.ts";

export interface SkillFields {
  name?: string;
  description?: string;
}

const validName = (name: string) => name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
const ignoreWarning = (_message: string): void => {};

/** A deliberately non-executing YAML subset, not an ambient Pi resource loader.
 * Parse only routing scalar fields; do not construct YAML objects/tags/aliases.
 * Existing malformed metadata is diagnostic data, never a validation failure.
 */
export function skillFields(content: string, path: string, warn: (message: string) => void = ignoreWarning): SkillFields {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    warn(`Missing skill frontmatter: ${path}`);
    return {};
  }
  const end = lines.findIndex((line, i) => i > 0 && (line === "---" || line === "..."));
  if (end < 0) {
    warn(`Malformed skill frontmatter (missing closing delimiter): ${path}`);
    return {};
  }
  const seen = new Set<string>();
  const fields: SkillFields = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      // Nested metadata is data, not something this scalar validator evaluates.
      warn(`Nested or multiline skill frontmatter not fully validated: ${path}`);
      continue;
    }
    const match = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!match) {
      warn(`Malformed or unsupported skill frontmatter line ${i + 1}: ${path}`);
      continue;
    }
    const [, key] = match;
    if (seen.has(key)) warn(`Duplicate skill frontmatter key ${key}: ${path}`);
    seen.add(key);
    let value = (match[2] ?? "").trim();
    let parsed: string | undefined;
    if (/^[|>][+-]?(?:\s+#.*)?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < end && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) {
        block.push(lines[++i]);
      }
      let indentation = Infinity;
      for (const entry of block) {
        if (entry.trim()) indentation = Math.min(indentation, /^\s*/.exec(entry)![0].length);
      }
      const text = block.map((entry) => entry.slice(Number.isFinite(indentation) ? indentation : 0));
      parsed = value.startsWith(">") ? text.join(" ").trim() : text.join("\n").trim();
    } else if (value.startsWith('"')) {
      try {
        const quoted = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(value);
        if (!quoted) throw new Error("quote");
        const decoded: unknown = JSON.parse(quoted[1]);
        if (typeof decoded !== "string") throw new Error("scalar");
        parsed = decoded;
      } catch {
        warn(`Malformed or unsupported quoted skill field ${key}: ${path}`);
      }
    } else if (value.startsWith("'")) {
      const quoted = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value);
      if (quoted) parsed = quoted[1].replace(/''/g, "'");
      else warn(`Malformed quoted skill field ${key}: ${path}`);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
      const nonString = /^[!&*[{|>]|:\s/.test(value)
        || (/^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?)$/i.test(value) && key !== "disable-model-invocation");
      if (nonString) warn(`Unsupported non-string skill field ${key}: ${path}`);
      else parsed = value;
    }
    if (key === "disable-model-invocation") {
      if (value !== "true" && value !== "false") warn(`Invalid disable-model-invocation boolean: ${path}`);
    } else if ((key === "name" || key === "description") && parsed !== undefined) {
      fields[key] = parsed;
    }
  }
  if (!fields.name) warn(`Missing skill name (host may use directory fallback): ${path}`);
  else if (!validName(fields.name)) warn(`Invalid skill name ${JSON.stringify(fields.name)}: ${path}`);
  if (!fields.description?.trim()) warn(`Missing skill description: ${path}`);
  else if (fields.description.length > 1024) warn(`Skill description exceeds 1024 characters: ${path}`);
  return fields;
}

/** Keep existing names in collision checks even when other metadata is broken.
 * The path is manifest-relative (POSIX), independent of the host filesystem.
 */
export function existingSkillName(content: string, path: string, warn?: (message: string) => void): string {
  const { name } = skillFields(content, path, warn);
  if (name?.trim()) return name;
  return posix.basename(path) === "SKILL.md"
    ? posix.basename(posix.dirname(path))
    : posix.basename(path, posix.extname(path));
}

/** Proposed content must remain valid full frontmatter with required routing
 * fields. Only this strict edit path uses the host's non-executing YAML parser;
 * audit and unrelated existing skills always use the tolerant scalar subset.
 */
export function proposedSkillName(content: string): string {
  let frontmatter: unknown;
  try {
    frontmatter = parseFrontmatter(content).frontmatter;
  } catch {
    throw new Error("Invalid skill frontmatter in proposed edit.");
  }
  if (!isRecord(frontmatter)) throw new Error("Invalid skill frontmatter in proposed edit.");
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !validName(name)
    || typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new Error("Proposed skills require a valid name and description.");
  }
  return name;
}
