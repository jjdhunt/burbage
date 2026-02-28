# Burbage Extension Handoff Plan

## Purpose

Burbage is a VS Code extension for structured text projects (fiction or non-fiction corpora) that:
- scaffolds a corpus + entity workspace,
- runs an agentic assistant (Codex-backed) in a custom Burbage chat UI,
- and visualizes entity structure (currently relationship graph).

Primary project dirs:
- `Manuscript/` (source corpus)
- `Entities/` (`documents.yaml`, `characters.yaml`, `locations.yaml`, `geography.yaml`, `events.yaml`, `relationships.yaml`)

## Current Repo Snapshot (Ground Truth)

This section describes the current checked-in code state in this workspace.

- Extension entrypoint: `src/extension.ts`
- Command contributions currently registered in `package.json`:
  - `burbage.setup`
  - `burbage.sync`
  - `burbage.openChat`
  - `burbage.loginCodex`
  - `burbage.openRelationshipDashboard`
- Sidebar view container exists (`burbage.sidebar` webview in activity bar).
- Runtime dependency: `yaml` (packaged via `node_modules/yaml/**`).

Important drift note:
- Recent local iterations may have produced higher `.vsix` versions, but this repo currently reflects the command set above.
- No `openTimelineDashboard` command exists in current `package.json` or `src/extension.ts`.

## What Is Implemented

### 1. Setup Command (`burbage.setup`)

Behavior:
- Creates missing:
  - `Manuscript/`
  - `Entities/`
  - `.vscode/`
  - `Entities/documents.yaml`
  - `Entities/characters.yaml`
  - `Entities/locations.yaml`
  - `Entities/geography.yaml`
  - `Entities/events.yaml`
  - `Entities/relationships.yaml`
- Initializes git repo if `.git/` is missing.
- Copies templates:
  - `AGENTS_burbage.md` -> `AGENTS.md` (always replace)
  - `settings_burbage.json` -> `.vscode/settings.json` (skip if exists)
- Installs local Codex CLI into `.burbage/runtime` (npm-based).
- Writes workspace Codex settings into `.vscode/settings.json`:
  - `burbage.codexCliPath`
  - `burbage.codexCliMode = "local"`
- Ensures `.gitignore` entries:
  - `.burbage/runtime/`
  - `AGENTS.md`
- Checks Codex login status and reports summary.

### 2. Burbage Chat Sidebar

Implemented in `BurbageSidebarProvider`:
- Activity-bar webview chat with:
  - Enter-to-send
  - Shift+Enter newline
  - `Sync` button (sends a default sync prompt)
- Persistent Codex thread per sidebar lifecycle (`exec` then `exec resume`).
- Streaming status shown as:
  - `Burbage is working...`
  - plus recent progress lines (tool-call noise filtered).
- Working status message is shown in transcript and replaced by final reply.
- Queueing logic for concurrent user prompts while Codex is busy.

### 3. Codex Integration

Implemented:
- Local Codex command resolution priority:
  1. workspace setting `burbage.codexCliPath`
  2. local runtime `.burbage/runtime/node_modules/.bin/codex(.cmd)`
  3. global `codex` / `codex.cmd`
- Login support:
  - `burbage.loginCodex` opens terminal and runs `codex login`.
  - login verification via `codex login status`.
- Command execution:
  - JSON event parsing for thread id and assistant messages.
  - streaming runner for progress/status updates.

Current behavior note:
- Agent runs with `--dangerously-bypass-approvals-and-sandbox` for project-wide edits.

### 4. Relationship Dashboard (`burbage.openRelationshipDashboard`)

Implemented:
- Loads from `Entities/characters.yaml` + `Entities/relationships.yaml`.
- Opens D3 force-directed webview panel.
- Auto-refreshes via file watchers on:
  - `Entities/characters.yaml`
  - `Entities/relationships.yaml`
- Node features:
  - one node per character/entity
  - color by character type
  - persistent text label (name)
  - hover annotation with type, bio, mentions
- Edge features:
  - links from relationship parties
  - hover annotation with relationship type, formation, status, description, mentions
- Tooltip suppression during drag.

## What Is Not Implemented Yet

- Timeline dashboard command and UI (`burbage.openTimelineDashboard`) are not implemented.
- True sync engine for diff-aware entity updates is not implemented as dedicated service.
  - Current `burbage.sync` sends a sync prompt to chat.
- Non-agentic character chat path (direct LLM adapter) is not implemented.
- Provider/auth UI beyond Codex login terminal flow is not implemented.
- Marketplace publishing pipeline is not finalized (local VSIX workflow exists).

## Core Files and Roles

- `src/extension.ts`
  - currently monolithic implementation of setup, chat, codex bridge, and dashboard.
- `AGENTS_burbage.md`
  - canonical sync policy + YAML schemas for entities.
- `settings_burbage.json`
  - template workspace settings applied on setup.
- `README.md`
  - user/developer usage doc (currently partially outdated).
- `package.json`
  - command contributions, activation events, scripts, packaging includes.

## Local Dev Workflow

### Prerequisites
- Node.js + npm available in host shell.
- VS Code desktop >= 1.109.
- Codex account login performed via `Burbage: Login to Codex`.

### Build
```bash
npm install
npm run compile
```

### Package
```bash
npm run package
```

### Install
- VS Code: `Extensions: Install from VSIX...`
- select generated `burbage-<version>.vsix` at repo root.

## Testing Checklist (Manual)

1. Setup
- Run `Burbage: Setup Project` in empty folder.
- Verify created dirs/files and `.gitignore` entries.
- Verify local Codex runtime install path exists.

2. Chat
- Open Burbage sidebar.
- Send prompt with Enter.
- Verify in-chat working status updates then replacement by final assistant response.
- Verify Sync button sends default sync prompt.

3. Relationship dashboard
- Open `Burbage: Open Relationship Dashboard`.
- Verify graph renders from `Entities/*.yaml`.
- Edit `characters.yaml` or `relationships.yaml` and save.
- Verify panel auto-refreshes.

## Known Technical Debt

- `src/extension.ts` is too large; needs modularization.
- README and plan can drift from code; update docs whenever command surface changes.
- No automated tests (unit/integration/e2e) yet.
- Webview D3 is loaded from CDN (network dependency).
- VSIX includes many JS files; bundling optimization not yet applied.

## Suggested Refactor Plan (Next)

1. Split modules:
- `setup.ts`
- `codex.ts`
- `chatSidebar.ts`
- `dashboards/relationship.ts`
- `yaml.ts` utilities

2. Introduce a real sync engine:
- change-set collector (`git diff` + untracked manuscript files)
- entity updater orchestration
- review/apply workflow hooks

3. Add timeline dashboard as a first-class command:
- `burbage.openTimelineDashboard`
- parse `events.yaml` + manuscript docs
- watcher-driven refresh

4. Add basic test harness:
- parsing/data transform unit tests
- setup behavior tests in temp workspace

5. Clean packaging/docs:
- align README with actual feature set
- add changelog discipline
- consider bundling build for performance.
