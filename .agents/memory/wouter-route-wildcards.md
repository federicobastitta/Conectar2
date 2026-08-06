---
name: Wouter v3 wildcard routes
description: Trailing "*" glued to a segment does not match subroutes in wouter v3.
---

In wouter v3 (regexparam), a pattern like `/reservar*` matches `/reservar` but NOT `/reservar/confirmar`. Subroutes silently fall through to later routes (e.g. a catch-all `/*`), causing wrong layouts/redirects.

**Why:** regexparam parses path segments split by `/`; `reservar*` is not a wildcard segment.

**How to apply:** use `/prefix/*?` (optional wildcard) to match both the base path and its subroutes, or `<Route path="/prefix" nest>`. Verify with `parse(pattern).pattern.test(url)` from regexparam when in doubt.
