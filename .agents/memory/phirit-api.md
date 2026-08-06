---
name: Phir-it PACS API
description: Non-obvious behavior of the official Phir-it imaging (PACS) API used for live study lookup.
---

# Phir-it PACS API

Official REST API (distinct from the older web-scraper poller). Used to look up a patient's
imaging studies live by DNI and embed a DICOM viewer.

- **Errors come back on HTTP 200**, not via HTTP status. The JSON `mensaje` field carries the
  real outcome: `"token-invalido"`, `"cliente-invalido"`, `"cliente-no-habilitado"`. You must
  inspect `mensaje` even when `res.ok` is true.
  **Why:** a naive check of only `res.ok` treats an expired token / bad client as success with
  `data=[]` — a silent false negative.
  **How to apply:** validate HTTP status *and* re-check `mensaje` on every attempt, including the
  retry after token renewal.
- **Token lifetime ~1h**; generated via `POST /api/cliente/generar-token`. Cache it (we use 55min)
  and renew once on `token-invalido`, then retry the same request.
- **codCli**: the real client code lives in secret `PHIRIT_API_COD_CLIENTE` (32 chars). The value
  in public docs (`70cd9e84455f1c7cc2a6579f637dc95d`) is a different/sample code — do not hardcode.
- **Study response** (`GET /api/estudios?id=DNI&codCli=&token=`) returns `data[]` with per-study:
  `studyIUID`, `modalidad` (DICOM: US/DX/CR/MR/CT/MG…), `numSeries`, `numInstancias`,
  `informes[]`, and viewer links `linkVisualizadorOhif` (OHIF), `linkVisualizador` (Oviyam),
  `linkVisualizadorComp`, `linkPortal`. These links are served from `*.phir-it.ar`.
- **Privacy:** do not log DNI (health PII). Log only counts/latency.
- **Embedding viewer:** allowlist the viewer host (`*.phir-it.ar`, https) before rendering the
  iframe `src`, since the URL originates upstream.
- v1 is **live query, not persisted** (no DB write). Tables `estudios_externos` and
  `informes.pacs_study_id`/`pacs_viewer_url` exist but are unused by this path.

## Token vigente (jul 2026)
DiagnostiPACS rotó el token: el vigente se guarda en el secreto CONECTAR_INTEGRATION_TOKEN (PACS_API_TOKEN quedó como fallback histórico en diagnostipacs-api). Si el PACS devuelve 401 en todos los endpoints, sospechar rotación de token, no bug de código.
