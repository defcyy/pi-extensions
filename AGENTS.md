# Project agent guidance

- Keep extension-specific documentation under `pi-extension/<name>/`.
- Validate code changes with `pnpm test` and `pnpm typecheck`
  when execution is permitted.
- Test observable behavior, not logs or incidental prompt wording.
  Keep explicit safety and API-contract checks.
- Report automated checks separately from live Pi smoke tests.
  State when live behavior was not exercised.
- Use synthetic credential fixtures, never real credentials.
