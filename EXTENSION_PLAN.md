# Burbage VS Code Extension Plan

## Product Direction

Burbage is a VS Code extension for structured text projects that keeps corpus-derived entities synchronized while providing an agentic assistant experience.

Supported project types include (not limited to):
- Novels and long-form fiction.
- News/article collections.
- Research and intelligence corpora.
- Historical document sets.

Current architecture decision:
- Use Codex as the agent runtime for Burbage flows (rather than building a custom agent framework).
- Have a separate direct-LLM path for non-agentic character chat.

## Core User Experience

### 1. Project Setup Command

One setup command initializes a project in an additive, non-destructive way:
- Create `Manuscript/` if missing.
- Create `Entities/` if missing.
- Create missing entity files:
  - `Entities/characters.yaml`
  - `Entities/locations.yaml`
  - `Entities/events.yaml`
  - `Entities/relationships.yaml`
- Initialize git repo if missing.
- Create `AGENTS.md` from `AGENTS_burbage.md` if missing.
- Create `.vscode/settings.json` from `settings_burbage.json` if missing.

Behavior constraints:
- Never overwrite existing files silently.
- Always replace `AGENTS.md` from template.
- Never overwrite existing `.vscode/settings.json`.

### 2. Agentic Chat

- Extension provides a Burbage-branded chat UI.
- Chat proxies to Codex.
- This abstraction allows later chat-mode expansion (character personas, mixed tools, custom workflows).

### 3. Entity Sync Model

- Synchronization is based on working-tree change set (tracked + staged + untracked manuscript additions).
- Sync can be triggered manually or from pre-commit hooks.
- Pre-commit sync is advisory for now (no hard commit block in v1).

### 4. Dashboards

Webview panels for corpus intelligence views:
- Character relationship network (force-directed graph).
- Eventually other dashboards will be added (e.g. Event Timeline visualization).
- Built with D3.js.

### 5. Non-Agentic Character Chat

- Character chat runs against direct LLM APIs (not Codex).
- Keeps agentic editing and conversational roleplay paths separated.

## Technical Architecture

### Extension modules

- `ProjectSetupService`
  - Handles scaffolding, git init, templates, and safe file creation.

- `AgentAdapter` (Codex-backed)
  - Sends agentic tasks to Codex.
  - Handles request/response translation for Burbage UI.

- `LLMAdapter` (direct model chat)
  - Handles provider auth + direct LLM calls for non-agentic character chat.

- `EntitySyncService`
  - Builds change set from git + untracked manuscript files.
  - Runs sync/update actions for entity YAMLs.

- `ChatUI`
  - Burbage chat webview/sidebar.
  - Session controls, mode switcher (agentic vs character chat).

- `DashboardUI`
  - D3 webviews for relationship graph.

### Storage and config

- Workspace content:
  - `Manuscript/`
  - `Entities/*.yaml`
  - `AGENTS.md`
  - `.vscode/settings.json`

- Secrets:
  - Store API credentials via VS Code SecretStorage (never in repo files).

### Codex dependency strategy

- Prefer explicit user-consent install flow.
- On activation/setup:
  - detect Codex availability
  - if missing, prompt user to install or guide through install steps
- Avoid silent background install.

### Command Surface (MVP)

- `burbage.setup`
  - Additive project initialization/scaffolding.

- `burbage.sync`
  - Manual sync using current working-tree change set.

- `burbage.openChat`
  - Opens branded chat UI backed by Codex.

- `burbage.openRelationshipDashboard`
  - Opens relationship graph webview.

## Implementation Backlog

### Phase 0: Foundation

- Scaffold VS Code extension project.
- Define commands, activation events, logging.
- Add local debug launch config for Extension Development Host.

### Phase 1: Setup flow

- Implement `burbage.setup`.
- Add safe file creation + merge/replace/skip UX for existing files.
- Add git init logic (if `.git` missing).
- Add template copy from `AGENTS_burbage.md` and `settings_burbage.json`.

### Phase 2: Codex-backed Burbage chat

- Implement `AgentAdapter` for Codex bridge.
- Build Burbage chat UI webview/sidebar.
- Support basic prompt/response loop and error handling.

### Phase 3: Entity sync engine

- Implement `EntitySyncService` change-set builder.
- Support manual sync command.
- Add pre-commit hook integration in advisory mode.
- Ensure YAML parsing/repair for manually broken YAML files.

### Phase 4: Dashboards

- Build relationship graph D3 webview.
- Add lightweight data transforms from `Entities/*.yaml`.

### Phase 5: Non-agentic character chat

- Implement `LLMAdapter` with provider config + secret storage.
- Add character-chat mode and character context sourcing.
- Keep strict boundary from Codex agentic flows.

### Phase 6: Packaging and local distribution

- Configure `.vsix` packaging workflow.
- Add smoke-test checklist for local install/update/uninstall.
- Versioning + changelog discipline.

## v0.1 scope target

- Setup command `burbage.setup`.
- Burbage Codex chat MVP.
- Manual entity sync command `burbage.sync`.
- Basic relationship dashboards (read-only) `burbage.openRelationshipDashboard`.
- Local `.vsix` packaging for testing.

## Domain-General Framing

- Treat `Manuscript/` as the project's source corpus, not strictly fiction chapters.
- Treat "characters" as entities with agency or narrative relevance (including real people, groups, organizations, and states).
- Treat "events" as notable occurrences in the source corpus (fictional or real-world).
- Keep schema and sync logic domain-agnostic; avoid fiction-only assumptions in prompts and UI labels where possible.

## Open Decisions

- Exact Codex install UX (auto-install with explicit approval vs guided manual install).
- Initial model/provider defaults for non-agentic character chat.
- Final merge behavior for existing `.vscode/settings.json` (JSON patch strategy).
- Pre-commit hook installation mechanism (`.git/hooks` direct vs `core.hooksPath`).

## Status (2026-02-21)

Done:
- Extension scaffolded (TypeScript, commands, build/debug config).
- `burbage.setup` implemented and tested locally.
- Local `.vsix` packaging/install tested.
- Local Codex runtime install integrated into setup (`.burbage/runtime`) with platform-specific npm resolution.
- `burbage.openChat` implemented as a simple webview chat dialog backed by Codex CLI (`codex exec` + `codex exec resume` session continuity).
- `burbage.loginCodex` command added and setup now checks Codex login status.
- Burbage chat moved into an activity bar sidebar view with a `Sync` button that issues a sync prompt to Codex.

Next:
- Implement `burbage.sync` (change-set + entity sync engine).
- Implement `burbage.openRelationshipDashboard`.
