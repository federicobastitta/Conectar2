---
name: drizzle-kit push in non-interactive shells
description: How to apply schema changes when drizzle-kit push demands a TTY confirmation
---

`pnpm --filter @workspace/db run push` fails when drizzle-kit detects data-loss statements (e.g. adding a NOT NULL column without default to a non-empty table): it tries an interactive prompt and aborts with "Interactive prompts require a TTY terminal".

**How to apply:** clean up conflicting dev rows first if appropriate, then run drizzle-kit directly with the force flag from the package dir:

```
cd lib/db && npx drizzle-kit push --config ./drizzle.config.ts --force
```

Note: `pnpm run push -- --force` does NOT work — pnpm passes `--` literally and drizzle-kit rejects it.

**Why:** the sandbox shell is non-TTY, so any drizzle-kit confirmation prompt hard-fails instead of asking.
