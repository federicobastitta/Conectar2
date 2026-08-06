---
name: Phir-it portal scraping
description: Non-obvious quirks of logging into and scraping the Phir-it web portal (external system, no outbound webhook in this deployment).
---

# Phir-it portal (diagnosticar.phir-it.ar) scraping

This Phir-it deployment does NOT push outbound webhooks, so we poll its web portal
with the clinic's credentials. These facts are about the **external system** and are
not discoverable from our code alone.

## Login (ASP.NET Core, behind Cloudflare)
- Form POST `/login` with fields: `UserName`, `Password`, `EmpresaId=1`, and the
  hidden `__RequestVerificationToken` extracted from the GET `/login` page.
- Must send the cookies from GET `/login` on the POST (antiforgery pairs a cookie
  with the token).
- Success = HTTP 302 to a non-`/login` location (e.g. `/Home`).
- Auth is carried by the `.AspNetCore.Session` cookie (session state server-side);
  there is no separate identity cookie.
- **Always `.trim()` the credentials.** A trailing space on the username produced
  a misleading "email inválido" error and cost real debugging time.

## Studies list & detail
- List: `GET /estudios?page=N` (1-indexed). No working `estado` filter — the query
  param is ignored. Rows come duplicated (desktop + mobile layout).
- Detail: `GET /estudio/detalle/{id}?route=<base64('/estudios')>`. **The `route`
  param is required** — without it the detail page returns HTTP 500.
- **The "ID" Phir-it shows for a study is the patient's DNI** (confirmed by the
  clinic). That is the matching key against our `pacientes.dni`.
- `externalId` for our dedupe = the detail id (e.g. `134195`), stable and unique.

## Parsing (regex, fragile by design)
- Estado badge = the estado-vocabulary badge nearest **before** the
  `/estudio/detalle/{id}` link (badges also carry modality codes US/DX/MR/CT/RX,
  so filter by a known estado vocabulary to disambiguate).
- DNI in the list = a 7-9 digit number immediately before a `dd/mm/yyyy` date.
  `btn_copy_{id}{dni}` concatenates id+dni with **no separator** — not reliable.
- If the list row lacks a DNI, fall back to the detail page.

**Why:** markup-based scraping breaks silently when Phir-it changes its HTML. The
poller logs a per-cycle "lista parseada" count (total/informados/sinDni) so a
regression shows up as a sudden drop to 0 instead of going unnoticed.
