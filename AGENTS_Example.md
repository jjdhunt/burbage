- A project has the following components that should be kept in sync:
  - The Manuscript (in `Manuscript/`) is a collection of ground-truth documents or chapters. You may never modify it unless explicitly told to, and even then you may only make minimal edits.
  - Named Entities:
    - The Characters (in `Characters/characters.yaml`) are all of the unique individuals, groups, organizations, polities, or other entities with agency or narrative relevance in the Manuscript.
    - The Locations (in `Locations/locations.yaml`) are all of the unique physical, imaginary, conceptual, or mental places mentioned in the Manuscript.
    - The Events (in `Events/events.yaml`) are all of the unique occurrences or pivotal decisions mentioned in the Manuscript. Events should be listed in as close to chronological order as possible.
    - The Relationships (in `Relationships/relationships.yaml`) are all meaningful relationships between entities in `Characters/characters.yaml`. A relationship can include two or more entities.

  Synchronization rules:
   - All the Named Entities should be kept in sync with each other and the Manuscript.
   - Source of truth is the Manuscript.
   - Synchronization can be triggered either manually (user asks Burbage to sync) or automatically (e.g. by pre-commit hooks or timer).
   - Synchronization is based on the current git diff of the whole working tree (all working-tree diffs). When synchronization is triggered, Burbage should look at the diff and update the Named Entities accordingly.
   - Update only components affected by significant semantic changes. Minor wording-only edits that do not change facts do not require updates.
   - If user edits the Named Entities directly, check for Manuscript consistency.
   - If an inconsistency is found, do not automatically change the Manuscript. Notify the user and suggest a resolution. Only edit the Manuscript if explicitly instructed.
   - If an inconsistency is intentionally ignored by user instruction, note that in the relevant Named Entities entry.
   - Pre-commit sync is advisory in this phase: do not hard-block commit.

Documents outside `Manuscript/`, `Characters/`, `Locations/`, `Events/`, and `Relationships/` do not need to be synchronized with these.

---
All extracted data is stored in separate YAML files using a consistent structural pattern:

Top-level structure: mapping (dictionary)

Each top-level key is the canonical display name of the entity

Each key maps to a nested block-style mapping of fields

Lists use flow-style sequences: `[item1, item2, ...]`

Text fields are plain scalars (unquoted unless required by YAML syntax)

Files may include `#` comments

Schema templates may use angle-bracket placeholders (for example `<event title>`) to indicate required structure

This is "top-level mapping keyed by name + block mappings for fields + flow-style sequences for compact lists."

`Characters/characters.yaml`

Purpose: stores character/entity definitions.

Structure:

`<character name (free text)>:`
`  type: <species, class, organization type, or form (free text)>`
`  age: <birth information, lifespan, or descriptive age (free text)>`
`  sex: <sex or gender identifier (free text)>`
`  appearance: <concise physical or presentation description (free text)>`
`  biography: <paragraph-length background summary (free text)>`
`  personality: <flow-style list of traits>`

`Locations/locations.yaml`

Purpose: stores geographic, political, or conceptual locations.

Structure:

`<location name>:`
`  region: <parent region or N/A. Must be key name of another listed Location>`
`  description: <short description (free text)>`

`Events/events.yaml`

Purpose: stores historical or narrative events.

Structure:

`<event title>:`
`  chapters: [<chapter reference>, ...]`
`  date: <in-universe time marker (free text)>`
`  locations: [<location name>, ...]`
`  parties: [<character name>, ...]`
`  summary: <short prose description (free text)>`

Field definitions:

`chapters`: list of chapters/documents that mention the event.

`locations`: list of location names or 'N/A'; should match keys in `Locations/locations.yaml` when applicable.

`parties`: list of involved entity names or 'N/A'; must match keys in `Characters/characters.yaml` when applicable.

`Relationships/relationships.yaml`

Purpose: stores relationships between entities defined in `Characters/characters.yaml`.

Structure:

`<relationship name>:`
`  parties: [<character name>, ...]`
`  type: <relationship type (free text)>`
`  formation: <in-universe time when relationship began (free text)>`
`  status: <current relationship state (free text)>`
`  description: <optional short description of relationship (free text)>`

Field definitions:

`parties`: list of involved entity names or 'N/A'; must match keys in `Characters/characters.yaml` when applicable.

`type`: relationship category (for example ally, rival, parent, subordinate, patron)

`status`: current relationship state (for example active, strained, broken, unknown)

Conventions

Entity keys/names are unique within each file.

Cross-references use exact string matches to other entity keys.

No additional top-level wrapper keys (for example do not wrap in `events:`).

Keep entries compact and human-readable.

Avoid unnecessary quoting unless required by YAML syntax.

Angle-bracket placeholders indicate schema, not literal values.
