# Dashboards Docs

`dashboards-docs` is the OpenSearch Dashboards companion plugin for the new `opensearch-docs` backend.

The first pass focuses on:

- a workspace-friendly documents app
- a Quip-like split editor and preview
- autosave with optimistic concurrency
- polling-based refresh to surface remote edits

The browser talks to Dashboards server routes under `/api/_plugins/_dashboards_docs`, and those routes proxy the request to the backend OpenSearch plugin.

## Local development

When running OpenSearch Dashboards from the repo root, this plugin may need its browser bundle generated once before the app can load cleanly.

From `plugins/dashboards-docs`, run:

```bash
yarn build:bundle
```

That produces `target/public/dashboardsDocs.plugin.js`, which is the asset Dashboards serves at runtime for the app.
