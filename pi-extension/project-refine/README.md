# Project Refine

One command, one normal agent workflow:

```text
/project-refine
```

The agent collects the project's agent guidance, skills, reusable prompts, agent configuration and relevant session evidence, then proposes setup refinements **in the conversation**. It reviews how agents are instructed to work on the project—not the application or extensions implemented by the project. It then asks you to review the proposals and waits. Reply with the changes you approve; the command itself does not apply anything.

You can optionally give a focus:

```text
/project-refine focus on skill routing and testing instructions
```

## Scope

Refinement targets are `AGENTS.md` or equivalent project guidance, skills and references, routing descriptions, reusable agent prompts, and project-local agent configuration. Examples include clarifying when an existing skill applies, fixing a broken guidance reference, consolidating conflicting instructions, or capturing a recurring project-specific procedure.

Application/extension code, test-suite refactors and product documentation are **not** refinement targets. Source and manifests may be inspected only to verify a setup claim, command or path. An extension repository does not turn the command into an extension-maintenance review, including maintenance of Project Refine itself. Optional focus text narrows the setup review rather than changing this boundary. Missing `AGENTS.md` or skill files alone do not justify creating them.

## What happens

1. Discover the project, related Git worktrees, agent guidance, skills, references, prompts and configuration. Distinguish discovered files from resources known to be loaded.
2. Inspect current context and relevant project sessions incrementally, collecting more evidence when needed. Distinguish human feedback from generated worker assignments; ordinary implementation bugs are not automatically guidance defects.
3. Summarize the current setup and present justified setup refinements with affected paths, evidence, proposed replacements/diffs, agent-workflow benefits and tradeoffs. If no in-scope change is warranted, explain the conclusion and coverage gaps instead of proposing implementation changes.
4. Stop for your review. No files, source sessions or Git state should be changed during this review.

There are no subcommands, scope flags, disclosure dialogs, isolated JSON reviewer calls, report files, coverage ledgers, cached results or acceptance bookkeeping. Additional text is an optional natural-language focus, not a command or flag. Use Pi's normal stop control to interrupt the task, and ordinary conversation to review or approve proposals.

## Runtime and data

Requires **Pi >=1.3.0 <2**, a trusted project, an idle agent and a selected model. Uses the current session's model, tools and normal provider routing; it does not replace the model, tool selection, system prompt or session. Progress, tool activity and proposals appear through Pi's usual conversation UI, including in RPC clients. No custom UI is required.

Invoking the command requests normal agent inspection: content read through tools enters this conversation and can be sent to its configured provider. There is no separate redaction service or disclosure confirmation. The workflow instructs the agent to extract only relevant project messages, omit hidden/thinking content and secrets, and not dump whole logs. Review sensitive data and your provider settings before invoking it.

The command supplies working-directory and session-store metadata, including the current session's entry cutoff. The agent performs discovery itself, can inspect configured local skill paths, and must report unavailable evidence and incomplete coverage. It is not a guarantee that every session or skill will be inspected. It should propose project-local changes; global/installed skills may inform the review but should not be edited without an explicit request.

The read-only/review boundary is an instruction to the normal agent, **not an OS sandbox or a tool-level write blocker**. Existing session tools and permissions remain unchanged. Historical instructions are evidence, not authorization to execute commands or change files.

Old data under `<pi-agent-dir>/project-refine/` is no longer read or written. Existing reports are left untouched; there is no automatic migration or deletion of private data.

## Development

```sh
pnpm test
pnpm typecheck
pi -e ./pi-extension/project-refine/index.ts
```

Tests cover command registration, main-session dispatch, discovery metadata, trust/idle/model guards and essential scope/evidence/approval instructions. They do not validate real TUI/RPC behavior, refinement quality or model compliance with the review boundary.
