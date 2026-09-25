# pi-github-skills

Loads GitHub Copilot repository skills from `.github/skills` into Pi. Copilot and Pi both use the [Agent Skills](https://agentskills.io/specification) layout: a folder with a `SKILL.md` that has `name` and `description` frontmatter. So existing Copilot skills work unchanged, including as `/skill:<name>` commands.

## Discovery

Pi looks for `.github/skills` in the current directory and each parent directory, the same way it finds `.agents/skills`:

- Inside a git repository, the search stops at the repository root. This includes worktrees and submodules, where `.git` is a file.
- Outside a git repository, the search continues up to the filesystem root.
- Directories that don't exist are skipped. If no `.github/skills` is found, nothing is added and Pi starts normally.
- Directories are returned nearest-first. When two skills share a name, Pi keeps the first one it finds, so the nearest one wins.

Skills load at startup and again on `/reload`.

## Trust

Pi treats folders without `.pi` or `.agents/skills` as trusted, so Copilot-only repositories load their skills without a prompt. If you explicitly chose not to trust a project, its `.github/skills` are not loaded either.

Skills can tell the model to run commands. Review a repository's skills before working in it.
