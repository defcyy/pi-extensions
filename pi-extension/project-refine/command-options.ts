const ACTIONS = ["audit", "propose", "review", "history", "reset", "cancel", "help"] as const;
type Action = typeof ACTIONS[number];

export interface CommandOptions {
  action: Action;
  id?: string;
  since: number;
  root?: string;
  sessionRoots: string[];
  historicalRoots: string[];
  excludedWorktrees: string[];
  rereview: boolean;
}

function isAction(value: string): value is Action {
  return ACTIONS.some((action) => action === value);
}

/** Small command tokenizer, not a shell: quotes group paths; nothing is executed. */
function words(input: string): string[] {
  const result: string[] = [];
  let word = "";
  let quote = "";
  let present = false;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      present = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      present = true;
    } else if (/\s/.test(char)) {
      if (present) result.push(word);
      word = "";
      present = false;
    } else {
      word += char;
      present = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in project-refine arguments.");
  if (present) result.push(word);
  return result;
}

function sinceDate(value: string, now: number): number {
  if (value === "all") return 0;
  const match = /^([1-9]\d{0,3})d$/.exec(value);
  if (!match) throw new Error("--since must be 1d–9999d or all.");
  return now - Number(match[1]) * 86400_000;
}

export function parseCommand(input: string, now = Date.now()): CommandOptions {
  const args = words(input);
  const action = args.shift() ?? "help";
  if (!isAction(action)) {
    throw new Error("Unknown project-refine action. Use /project-refine help.");
  }
  const options: CommandOptions = {
    action,
    since: now - 14 * 86400_000,
    sessionRoots: [],
    historicalRoots: [],
    excludedWorktrees: [],
    rereview: false,
  };
  const proposalId = args[0];
  if (action === "review" && proposalId && !proposalId.startsWith("--")) {
    options.id = proposalId;
    args.shift();
  }

  let flag: string | undefined;
  while ((flag = args.shift()) !== undefined) {
    if (flag === "--rereview") {
      options.rereview = true;
      continue;
    }
    if (!["--since", "--root", "--session-root", "--historical-root", "--exclude-worktree"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = args.shift();
    if (!value?.trim() || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    switch (flag) {
      case "--since":
        options.since = sinceDate(value, now);
        break;
      case "--root":
        options.root = value;
        break;
      case "--session-root":
        options.sessionRoots.push(value);
        break;
      case "--historical-root":
        options.historicalRoots.push(value);
        break;
      case "--exclude-worktree":
        options.excludedWorktrees.push(value);
        break;
    }
  }
  if (options.id && !/^[a-f0-9]{64}$/.test(options.id)) {
    throw new Error("Use the full proposal ID from a report.");
  }
  return options;
}
