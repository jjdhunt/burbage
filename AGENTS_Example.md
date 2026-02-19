- A project has the following components that must always be kept in sync:
  - The Manuscript (in Manuscript/) is a collection of ground-truth documents or 'Chapters'. You may never modify it unless explicitly told to, and even then you may only make minimal edits.
  - The Characters (in Characters/characters.yaml) are all the unique individuals, groups, organizations, polities, etc. that have any agency or relevance in the Manuscript. Characters have these attributes: Name, Type, Age, Sex, Appearance, Biography, Personality/Characteristics, and Mentions (count throughout the Manuscript).
  - The Locations (in Locations/locations.yaml) are all the unique locations mentioned in the Manuscript. They may be physical, imaginary, conceptual, or mental in nature. Locations have these attributes: Name, Region, Description, and Mentions (count throughout the Manuscript).
  - The Events (in Events/events.yaml) are all the unique occurrences or pivotal decisions mentioned in the Manuscript. Events have these attributes: Name, Chapters (in which it is mentioned), Date, Locations (where it takes place), Parties (involved/relevant Characters), and Summary. The Locations and Parties must be from the listed Characters and Locations - you can add new ones if needed. The events must be listed in as close to chronological order order as possible.

  These four components must always be kept in sync in this way:
   - If the Manuscript changes in a way that affects the Characters, Locations, or Events, then you should update the relevant components. For example, if a new location is mentioned, or a person's description changes in a significant way.
   - You can update multiple components if needed. For example, if a new event is described and you realize that it involves a place not listed in the Locations, then you can add the new location after you add the event.
   - You do not always have to update the components, only for significant changes. For example, if the text of a character's description changes but the basic facts remain the same, then you don't need to update the Character's dossier.
   - If the contents of the Characters, Locations, or Events are changed by the user, you should check the Manuscript for consistency. If you discover an inconsistency, you should not automatically change the Manuscript. Instead, you should notify the user of the inconsistency and suggest a way to resolve it. Only if the user explicitly tells you to do so should you make any edits to the Manuscript.
   - When asked to synchronize or update things, you should look at the current git diff of the whole document-project and base the needed changes on that diff.
   - Anytime you discover an inconsistency you should either fix it or notify the user. If the user says to ignore the inconsistency you should note that in the relevant dossier.

Documents not in the Manuscript, Characters, Locations, or Events directories do not need to be synchronized or consistent with the contents of those directories.

---
All extracted data is stored in separate YAML files using a consistent structural pattern:

Top-level structure: a mapping (dictionary)

Each top-level key is the canonical display name of the entity

Each key maps to a nested block-style mapping of fields

Lists use flow-style sequences: [item1, item2, ...]

Text fields are plain scalars (unquoted unless required by YAML syntax)

Files may include # comments

Schema templates may use angle-bracket placeholders (e.g., <event title>) to indicate required structure

This is “top-level mapping keyed by name + block mappings for fields + flow-style sequences for compact lists.”

Events

Purpose: Stores historical or narrative events.

Structure:

<event title key>:
chapters: [<chapter name, optional "ch. N">; ...]
date: <in-world time marker (free text)>
locations: [<location name>; ...]
parties: [<faction or actor name>; ...]
summary: <short prose description>

Field definitions:

chapters: List of references in the format Chapter Name, ch. Num

date: In-universe time reference (free text)

locations: List of location names (should correspond to keys in locations.yaml when applicable)

parties: List of factions, groups, or individuals involved

summary: 1–3 sentence description of the event

characters.yaml

Purpose: Stores character definitions.

Structure:

<character name>:
type: <species or form, including transformations if applicable>
age: <birth information or lifespan description>
sex: <sex or gender label>
biography: <paragraph biography>
personality: <trait description string or list>

Field definitions:

type: Ontological category (e.g., Human, SAI, hybrid, etc.)

age: Birth date, lifespan span, or descriptive age information

sex: Sex or gender identifier (free text)

biography: Paragraph-length background summary

personality: Either a descriptive string or a flow-style list of traits

locations.yaml

Purpose: Stores geographic, political, or astronomical locations.

Structure:

<location name>:
region: <parent region or N/A>
description: <short descriptive text>

Field definitions:

region: Broader geographic or political grouping (string or N/A)

description: 1–3 sentence description of the location

Conventions

Entity names are unique within each file.

Cross-references use exact string matches to other entity keys.

No additional top-level wrapper keys (e.g., do not wrap in events:).

Keep entries compact and human-readable.

Avoid unnecessary quoting unless required by YAML syntax.

Angle-bracket placeholders indicate schema, not literal values.