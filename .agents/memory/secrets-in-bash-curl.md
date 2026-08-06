---
name: Secrets interpolated in bash curl get mangled
description: Why testing token-protected endpoints with curl "$SECRET" fails with 401 in this sandbox
---

Rule: never test token-protected endpoints by interpolating a secret env var into a `curl` command (`-H "Authorization: Bearer $SECRET"`). The sandbox alters the expanded secret value (observed: 32-char token arrived as 35 chars at the server), so the server correctly returns 401 even though the code is fine.

**Why:** Debugging the DiagnostiPACS webhook wasted several cycles chasing a phantom auth bug; hashes proved the received token differed from the env value in both bash and the server.

**How to apply:** Use `node -e` with `fetch` reading `process.env.SECRET` directly (no shell interpolation) to test such endpoints. Length/hash logging (never the raw value) is a safe way to confirm mismatches.
