---
name: Legacy frontend fetches lack auth headers
description: When adding Bearer auth to old API endpoints, the legacy frontend pages break silently unless updated.
---

Older pages in the web frontend (worklist, tablero, etc.) call the API with raw `fetch(..., { credentials: "include" })` and NO Authorization header. The session token lives in `localStorage` under `auth_token`.

**Why:** When Bearer auth was added to the informes endpoints, the worklist pages would have started failing (empty lists / silent 401s) because their fetches sent no token.

**How to apply:** Any time an endpoint gains `getUserFromRequest` auth, grep the frontend for fetches to that path and add `Authorization: Bearer ${localStorage.getItem("auth_token") ?? ""}`. Newer pages already do this; legacy ones often don't.
