# Burbage

Burbage is a VS Code extension for entity synchronization in structured text projects.

Current MVP commands:
- `Burbage: Setup Project` (`burbage.setup`)
- `Burbage: Sync Entities` (`burbage.sync`) - placeholder
- `Burbage: Open Chat` (`burbage.openChat`) - placeholder
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
- Creates `AGENTS.md` from `AGENTS_burbage.md` if missing.
- Creates `.vscode/settings.json` from `settings_burbage.json` if missing.

If `AGENTS.md` or `.vscode/settings.json` already exists, setup prompts for:
- `Skip`
- `Merge`
- `Replace`

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
