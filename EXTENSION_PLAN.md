# Burbage Extension Plan

## Purpose

Burbage is a VS Code extension for structured text projects (fiction or non-fiction corpora) that:
- scaffolds a Manuscript + Entities workspace,
- runs a Codex-backed assistant in the Burbage sidebar chat,
- and provides data dashboards over entity YAMLs.

Primary project dirs:
- `Manuscript/` (source corpus)
- `Entities/` (`documents.yaml`, `characters.yaml`, `locations.yaml`, `geography.yaml`, `events.yaml`, `relationships.yaml`)

## Current Ground Truth

Extension entrypoint:
- `src/extension.ts`

Current command surface (`package.json`):
- `burbage.setup`
- `burbage.sync`
- `burbage.openChat`
- `burbage.loginCodex`
- `burbage.openRelationshipDashboard`
- `burbage.openTimelineDashboard`
- `burbage.openLocationsHierarchyDashboard`
- `burbage.openGeographyDashboard`
- `burbage.openCausalDiagramDashboard`
- `burbage.openVonnegutDashboard`

Runtime dependency:
- `yaml`

## Implemented Features

### 1. Setup (`burbage.setup`)

Creates missing:
- `Manuscript/`
- `Entities/`
- `.vscode/`
- `Entities/documents.yaml`
- `Entities/characters.yaml`
- `Entities/locations.yaml`
- `Entities/geography.yaml`
- `Entities/events.yaml`
- `Entities/relationships.yaml`

Also:
- initializes git repo if missing,
- replaces `AGENTS.md` from `AGENTS_burbage.md`,
- creates `.vscode/settings.json` from template if missing,
- installs local Codex CLI in `.burbage/runtime`,
- configures workspace Codex settings,
- ensures `.gitignore` entries for `.burbage/runtime/` and `AGENTS.md`,
- checks Codex login status.

### 2. Sidebar Chat (`burbage.sidebar`)

- Activity bar webview chat with enter-to-send and Shift+Enter newline.
- `Sync` button sends a default sync prompt.
- Persistent Codex thread per sidebar session (`exec` + `exec resume`).
- Streaming progress updates with filtered tool noise.
- Prompt queueing while Codex is busy.

### 3. Dashboards

- Relationship Dashboard:
  - source: `characters.yaml`, `relationships.yaml`
  - graph view with watchers and hover detail

- Event Timeline:
  - event backbone
  - document mentions, character/event participation, location/event involvement

- Document Timeline:
  - document backbone ordered by `documents.yaml.index` (fallback by name)
  - document summaries on document nodes
  - character->document links derived from `events.yaml` (`events[].parties` + `events[].mentions`)
  - location->document links derived from `events.yaml` (`events[].locations` + `events[].mentions`)
  - no character<->event or location<->event links shown in this mode
  - curved backbone-to-entity links (same style as Event Timeline)

- Locations Hierarchy Dashboard:
  - source: `locations.yaml`

- Geography Dashboard:
  - source: `locations.yaml`, `geography.yaml`

- Causal Diagram Dashboard:
  - source: `events.yaml` causal fields

- Vonnegut Diagram Dashboard:
  - valence scatterplot from `events.yaml.valence`
  - toggle between event-sequence x-axis and document-sequence x-axis
  - document valence computed as mean of valenced events mentioning each document
  - smooth moving average curve (window = 3)

All dashboards support snapshot export and watcher-driven refresh.

### 4. Codex Integration

- CLI resolution order:
  1. workspace setting `burbage.codexCliPath`
  2. local runtime `.burbage/runtime/node_modules/.bin/codex(.cmd)`
  3. global `codex`/`codex.cmd`
- Login flow via `burbage.loginCodex`.
- Agent execution supports project-wide edits.

## Open Work / Roadmap

### Priority Dashboard TODOs

1. Pacing Dashboard
- Timeline of number/density of events per chapter/document.
- Inputs:
  - `documents.yaml.index`
  - `events.yaml.mentions`

2. Tables: Plot Grid
- Matrix view:
  - rows: characters
  - columns: events
  - cell: character role in event

3. Tables: Chapter Summary Timeline
- Row-based chapter/document summary table.
- Each row is one chapter/document summary.

### Other Planned Work

- Real sync engine (diff-aware orchestration) beyond prompt-only sync.
- Refactor `src/extension.ts` into modules.
- Add automated tests (parsing/transforms, setup behavior, dashboard data shaping).
- Reduce webview network dependency and improve packaging/bundling.

## Local Dev Workflow

Build:
```bash
npm install
npm run compile
```

Package:
```bash
npm run package
```

Install:
- VS Code -> `Extensions: Install from VSIX...`
- select `burbage-<version>.vsix` in repo root.
