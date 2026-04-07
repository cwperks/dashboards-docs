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

That runs the repo optimizer and produces `target/public/dashboardsDocs.plugin.js`, which is the browser asset Dashboards serves at runtime for the app.

If you want the explicit command from the repo root, run:

```bash
PATH="/Users/craigperkins/.local/share/mise/installs/node/22.22.0/bin:$PATH" \
node scripts/build_opensearch_dashboards_platform_plugins.js \
  --no-examples --no-core --filter dashboardsDocs
```

Notes:

- Use Node `22.22.0` for local Dashboards work in this repo.
- `yarn build` in this plugin creates the distributable zip under `build/`; it is not the command that restores the runtime browser bundle in `target/public`.
