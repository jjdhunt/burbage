# Burbage

Burbage is a VS Code extension for entity synchronization in structured text projects.

Current MVP commands:
- `Burbage: Setup Project` (`burbage.setup`)
- `Burbage: Sync Entities` (`burbage.sync`) - placeholder
- `Burbage: Open Chat` (`burbage.openChat`)
- `Burbage: Login to Codex` (`burbage.loginCodex`)
- `Burbage: Open Relationship Dashboard` (`burbage.openRelationshipDashboard`) - placeholder

## What `Burbage: Setup Project` does

It performs additive, non-destructive setup in the current workspace:
- Creates `Manuscript/` if missing.
- Creates `Entities/` if missing.
- Creates missing entity files:
  - `Entities/characters.yaml`
  - `Entities/locations.yaml`
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
