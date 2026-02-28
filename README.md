# Burbage

Burbage is a VS Code extension for entity synchronization in structured text projects.

Entity schemas in `Entities/`:
- `documents.yaml`
- `characters.yaml`
- `locations.yaml`
- `geography.yaml`
- `events.yaml`
- `relationships.yaml`

Current MVP commands:
- `Burbage: Setup Project` (`burbage.setup`)
- `Burbage: Sync Entities` (`burbage.sync`) - sends a sync request into Burbage chat
- `Burbage: Open Chat` (`burbage.openChat`)
- `Burbage: Login to Codex` (`burbage.loginCodex`)
- `Burbage: Open Relationship Dashboard` (`burbage.openRelationshipDashboard`) - placeholder
- `Burbage: Open Timeline Dashboard` (`burbage.openTimelineDashboard`) - opens to Document Timeline view by default with in-dashboard toggle
- `Burbage: Open Locations Hierarchy Dashboard` (`burbage.openLocationsHierarchyDashboard`)
- `Burbage: Open Geography Dashboard` (`burbage.openGeographyDashboard`)
- `Burbage: Open Causal Diagram Dashboard` (`burbage.openCausalDiagramDashboard`)
- `Burbage: Open Vonnegut Diagram` (`burbage.openVonnegutDashboard`)
- `Burbage: Open Pacing Dashboard` (`burbage.openPacingDashboard`)

## What `Burbage: Setup Project` does

It performs additive, non-destructive setup in the current workspace:
- Creates `Manuscript/` if missing.
- Creates `Entities/` if missing.
- Creates missing entity files:
  - `Entities/documents.yaml`
  - `Entities/characters.yaml`
  - `Entities/locations.yaml`
  - `Entities/geography.yaml`
  - `Entities/events.yaml`
  - `Entities/relationships.yaml`
- Initializes git repository if missing.
- Creates or replaces `AGENTS.md` from `AGENTS_burbage.md`.
- Creates `.vscode/settings.json` from `settings_burbage.json` if missing (does not overwrite existing settings).
- Ensures Codex CLI is installed locally in `.burbage/runtime` (workspace-local, not global).
- Writes workspace settings to use local Codex CLI:
  - `burbage.codexCliMode = "local"`
  - `burbage.codexCliPath = ".burbage/runtime/node_modules/.bin/codex(.cmd on Windows)"`

Notes:
- Setup always replaces `AGENTS.md`.
- Setup always skips overwriting an existing `.vscode/settings.json`.
- Local Codex installation requires `npm` to be available on the machine.
- Setup verifies Codex login status and reports if login is required.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Build:

```bash
npm run compile
```

3. Launch Extension Development Host:

- Press `F5` in VS Code (using `.vscode/launch.json`).

## Package `.vsix` for local install

```bash
npm run package
```

This produces a `.vsix` in the project root.

To install:
- VS Code -> Command Palette -> `Extensions: Install from VSIX...`
- Select the generated `.vsix`.

## Codex login

If setup reports login is required:
- Run `Burbage: Login to Codex`.
- Complete login in the opened terminal.
- Then use `Burbage: Open Chat`.

## Chat behavior

- Chat lives in the Burbage activity bar sidebar.
- Chat uses a persistent Codex thread per open sidebar session (`exec` then `exec resume`).
- Sidebar includes a `Sync` button that sends a synchronization request prompt to Burbage.
- Chat currently runs Codex with `--dangerously-bypass-approvals-and-sandbox` to allow file edits across the project workspace.
