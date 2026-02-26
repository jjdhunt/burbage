# Project Overview

- A project has the following components that should be kept in sync:
  - The Manuscript (in `Manuscript/`) is a collection of ground-truth documents. You may never modify it unless explicitly told to, and even then you may only make minimal edits.
  - The Entities:
    - The Characters (in `Entities/characters.yaml`) are all of the unique individuals, groups, organizations, polities, or other entities with agency or narrative relevance in the Manuscript.
    - The Locations (in `Entities/locations.yaml`) are all of the unique physical, imaginary, conceptual, or mental places mentioned in the Manuscript.
    - The Geography (in `Entities/geography.yaml`) is the set of direct geographic connections between locations in `Entities/locations.yaml`.
    - The Events (in `Entities/events.yaml`) are all of the unique occurrences or pivotal decisions mentioned in the Manuscript. Events should be listed in as close to chronological order as possible.
    - The Relationships (in `Entities/relationships.yaml`) are all meaningful relationships between entities in `Entities/characters.yaml`. A relationship can include two or more entities.

# Project Synchronization Rules

- All the Entities should be kept in sync with each other and the Manuscript.
- Synchronization input is the current working-tree change set, defined as:
  - tracked changes from `git diff --name-status HEAD -- Manuscript/ Entities/`
  - untracked Manuscript files from `git ls-files --others --exclude-standard -- Manuscript/`
  - Then take the union of all changed paths above and use that as the sync input.
- All changes made by the user are considered official. Do not revert them unless asked to.
- If there are changes to the Manuscript, then you should update the Entities to agree.
- If there are changes to the Entities, then you should review the Manuscript for inconsistencies. If you find any, notify the user and suggest a way to modify the Manuscript to resolve the issue. You can then edit the Manuscript only if explicitly instructed.
- Only significant semantic changes matter. Minor wording-only edits that do not change facts do not require updates.
- After completing a synchronization, you should commit all modified and untracked files along with a short commit message. Do this automatically without asking the user for permission.

Documents outside the `Manuscript/` and `Entities/` dirs do not need to be synchronized with these.

# Named Entity Schemas

All extracted data is stored in separate YAML files in `Entities/` using a consistent structural pattern:
- Use a "top-level mapping keyed by name + block mappings for fields + flow-style sequences for compact lists."
- Top-level structure: mapping (dictionary)
- Each top-level key is the canonical display name of the entity
- Entity keys/names are unique within each file.
- Each key maps to a nested block-style mapping of fields
- Lists use flow-style sequences: `[item1, item2, ...]`
- Text fields are plain scalars (unquoted unless required by YAML syntax)
- Files should not include `#` comments
- Schema templates below use angle-bracket placeholders (for example `<event title>`) to indicate required structure, not literal values.
- Optional fields can be left empty (`null` or `[]`) if unknown.
- Non-empty entity cross-references must exactly match entity keys.
- No additional top-level wrapper keys (for example do not wrap in `events:`).
- Avoid unnecessary quoting unless required by YAML syntax.
- Keep entries compact and human-readable.
- It is possible that the files may violate valid YAML syntax due to user manual editing. If you detect this, you should do your best to fix things.

## characters.yaml

Purpose: stores character/entity definitions.

Structure:

```yaml
<character name>:
  mentions: [<document reference>, ...]
  type: <species, class, organization type, or form>
  age: <birth information, lifespan, or descriptive age>
  sex: <sex or gender identifier>
  appearance: <concise physical description>
  biography: <paragraph-length background summary>
  personality: [<trait>, ...]
```

Field definitions:

- `mentions` (Required): list of Manuscript documents that mention the character.
- `type` (Required): species, class, organization type, or form.
- `age` (Optional): birth information, lifespan, or descriptive age.
- `sex` (Optional): sex or gender identifier.
- `appearance` (Optional): concise physical description.
- `biography` (Required): paragraph-length background summary.
- `personality` (Optional): flow-style list of traits.

## locations.yaml

Purpose: stores geographic, political, or conceptual locations.

Structure:

```yaml
<location name>:
  mentions: [<document reference>, ...]
  region: <parent location name or `null`>
  description: <short description>
```

Field definitions:

- `mentions` (Required): list of Manuscript documents that mention the location.
- `region` (Optional): parent region/location key; if non-empty, must match another key in `locations.yaml`.
- `description` (Required): short free-text description.

## events.yaml

Purpose: stores historical or narrative events.

Structure:

```yaml
<event title>:
  mentions: [<document reference>, ...]
  date: <in-universe time marker or `null`>
  locations: [<location name>, ...]
  parties: [<character name>, ...]
  summary: <short prose description>
  valence: <protagonist goodness score, integer>
  causes: [<event that caused this one>, ...]
  explanation: <short prose description of how the causes led to the event, or `null`>
```

Field definitions:

- `mentions` (Required): list of Manuscript documents that mention the event.
- `date` (Optional): in-universe time marker.
- `locations` (Optional): list of location keys; if non-empty, must match keys in `Entities/locations.yaml`.
- `parties` (Optional): list of character/entity keys; if non-empty, must match keys in `Entities/characters.yaml`.
- `summary` (Required): short prose description.
- `valence` (Required): subjective 'goodness' score, from the perspective of the protagonist. 1-10, with 1 - worst thing that happens in the Manuscript, 10 - best thing that happens in the Manuscript.
- `causes` (Optional): list of event(s) that most directly caused this one, or empty if no known, distinct event caused it; if non-empty, must match other keys in `Entities/events.yaml`. May be empty if the event was: a random occurrence (e.g. two people meet by chance), a character's independent decision (e.g. a person spontaneously decides to go for a walk), a periodic/seasonal event (e.g. the sun rose), or the cause is never specified in the Manuscript. Typically, causal relationships should be acyclic and chronological, but this is not strictly enforced because some fictional narratives may violate physical/logical constraints.
- `explanation` (Optional): Manuscript-supported explanation of how the cause(s) resulted in the event. `null` for events with empty `causes`.

## relationships.yaml

Purpose: stores relationships between entities defined in `Entities/characters.yaml`.

Structure:

```yaml
<relationship name>:
  mentions: [<document reference>, ...]
  parties: [<character A name>, <character B name>, ...]
  type: <relationship type>
  formation: <in-universe time when relationship began or `null`>
  status: <current relationship state>
  description: <short description>
```

Field definitions:

- `mentions` (Required): list of Manuscript documents that mention the relationship.
- `parties` (Required): list of two or more involved entity names; every entry must match keys in `Entities/characters.yaml`.
- `type` (Required): relationship category (for example ally, rival, parent, subordinate, patron).
- `formation` (Optional): in-universe time when the relationship began.
- `status` (Required): current relationship state (for example active, strained, broken, unknown).
- `description` (Required): short description.

## geography.yaml

Purpose: stores geographic relationships between locations. Each entry is a connection between two locations mentioned in the Manuscript. Connected locations are physically adjacent or directly connected by a travel route. If someone travels from location A to B to C, then A and B are connected, B and C are connected, but A and C are not connected.

Structure:

```yaml
<connection name>:
  location_a: <location>
  location_b: <location>
  mentions: [<document reference>, ...]
  description: <short description of connection>
```

Field definitions:
- `location_a` (Required): first of the two connected locations. Must match a key in `locations.yaml`.
- `location_b` (Required): second of the two connected locations. Must match a key in `locations.yaml`.
- `mentions` (Required): list of Manuscript documents that mention the relationship between the locations.
- `description` (Required): short free-text description of the connection.
- `location_a` and `location_b` together define an undirected pair. `A-B` is identical to `B-A`.
- `location_a` must not equal `location_b`.
- Only one entry may exist per unordered location pair (no duplicate connections in opposite order).

# Additional Instructions

- When one or more documents are added to the Manuscript for the first time, there can be a lot of work to do. It is best to update the Entities in this order: Characters, Locations, Geography, Events, Relationships. As you progress through updating each, you might need to go back to update a previous Entity YAML (e.g. to add a missed Location where an Event takes place). You must read the entirety of each new Manuscript document. Proceed carefully; getting things right the first time will make it easy to update based on small diffs later. 
