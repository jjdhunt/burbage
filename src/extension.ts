import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFile = promisify(execFileCb);
type CommandResult = { stdout: string; stderr: string };
const DEFAULT_SYNC_PROMPT =
  "Synchronize the project entities with the Manuscript. Go ahead and apply needed file updates directly.";

export function activate(context: vscode.ExtensionContext): void {
  const sidebarProvider = new BurbageSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BurbageSidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("burbage.setup", async () => {
      await runSetupProject(context);
    }),
    vscode.commands.registerCommand("burbage.sync", async () => {
      await sidebarProvider.requestSync();
    }),
    vscode.commands.registerCommand("burbage.openChat", async () => {
      await sidebarProvider.reveal();
    }),
    vscode.commands.registerCommand("burbage.loginCodex", async () => {
      await openCodexLoginTerminal();
    }),
    vscode.commands.registerCommand("burbage.openRelationshipDashboard", async () => {
      await openRelationshipDashboard(context);
    }),
    vscode.commands.registerCommand("burbage.openTimelineDashboard", async () => {
      await openTimelineDashboard(context);
    })
  );
}

export function deactivate(): void {
  // No background resources yet.
}

type CharacterGraphNode = {
  id: string;
  name: string;
  type: string;
  bio: string;
  mentions: string[];
};

type CharacterGraphLink = {
  id: string;
  source: string;
  target: string;
  relationshipName: string;
  relationshipType: string;
  formation: string;
  status: string;
  description: string;
  mentions: string[];
};

type RelationshipGraphData = {
  nodes: CharacterGraphNode[];
  links: CharacterGraphLink[];
  sourceLabel: string;
};

type RelationshipDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

type TimelineNodeKind = "event" | "character" | "location" | "document";

type TimelineGraphNode = {
  id: string;
  name: string;
  nodeKind: TimelineNodeKind;
  mentions: string[];
  connectedEventSpan: number;
  connectedEventCount: number;
  meanEventIndex: number;
  eventIndex?: number;
  characterType?: string;
  bio?: string;
  date?: string;
  summary?: string;
};

type TimelineGraphLink = {
  id: string;
  source: string;
  target: string;
  linkKind: "party" | "location" | "mention";
};

type TimelineGraphData = {
  nodes: TimelineGraphNode[];
  links: TimelineGraphLink[];
  sourceLabel: string;
};

type TimelineDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

let relationshipDashboardState: RelationshipDashboardState | undefined;
let timelineDashboardState: TimelineDashboardState | undefined;

async function openRelationshipDashboard(context: vscode.ExtensionContext): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the relationship dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (relationshipDashboardState && relationshipDashboardState.workspaceRoot === workspaceRoot) {
      relationshipDashboardState.panel.reveal(vscode.ViewColumn.One, true);
      await refreshRelationshipDashboard(relationshipDashboardState, true);
      return;
    }

    if (relationshipDashboardState) {
      disposeRelationshipDashboardState(relationshipDashboardState);
      relationshipDashboardState = undefined;
    }

    const graph = await loadRelationshipGraph(workspaceRoot);

    const panel = vscode.window.createWebviewPanel(
      "burbage.relationshipDashboard",
      "Burbage: Relationship Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state: RelationshipDashboardState = {
      panel,
      workspaceRoot,
      watchers: []
    };
    relationshipDashboardState = state;

    panel.webview.html = getRelationshipDashboardHtml(graph);

    for (const relativePath of ["Entities/characters.yaml", "Entities/relationships.yaml"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, relativePath));
      const schedule = () => scheduleRelationshipDashboardRefresh(state);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      state.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    panel.onDidDispose(() => {
      if (relationshipDashboardState === state) {
        relationshipDashboardState = undefined;
      }
      disposeRelationshipDashboardState(state);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open relationship dashboard: ${message}`);
  }
}

function scheduleRelationshipDashboardRefresh(state: RelationshipDashboardState): void {
  if (relationshipDashboardState !== state) {
    return;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshRelationshipDashboard(state, false);
  }, 180);
}

async function refreshRelationshipDashboard(
  state: RelationshipDashboardState,
  showErrorToUser: boolean
): Promise<void> {
  if (relationshipDashboardState !== state) {
    return;
  }
  try {
    const graph = await loadRelationshipGraph(state.workspaceRoot);
    state.panel.webview.html = getRelationshipDashboardHtml(graph);
  } catch (error) {
    if (!showErrorToUser) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not refresh relationship dashboard: ${message}`);
  }
}

function disposeRelationshipDashboardState(state: RelationshipDashboardState): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  for (const watcher of state.watchers) {
    watcher.dispose();
  }
  state.watchers = [];
}

async function loadRelationshipGraph(workspaceRoot: string): Promise<RelationshipGraphData> {
  const entities = await resolveEntitiesDirectory(workspaceRoot);
  const charactersPath = path.join(entities.dirPath, "characters.yaml");
  const relationshipsPath = path.join(entities.dirPath, "relationships.yaml");
  const [charactersRaw, relationshipsRaw] = await Promise.all([
    fs.readFile(charactersPath, "utf8"),
    fs.readFile(relationshipsPath, "utf8")
  ]);
  return buildRelationshipGraph(parseYaml(charactersRaw), parseYaml(relationshipsRaw), entities.sourceLabel);
}

async function resolveEntitiesDirectory(workspaceRoot: string): Promise<{ dirPath: string; sourceLabel: string }> {
  const entitiesDirPath = path.join(workspaceRoot, "Entities");
  const hasCharacters = await pathExists(path.join(entitiesDirPath, "characters.yaml"));
  const hasRelationships = await pathExists(path.join(entitiesDirPath, "relationships.yaml"));
  if (hasCharacters && hasRelationships) {
    return {
      dirPath: entitiesDirPath,
      sourceLabel: "Entities/"
    };
  }

  throw new Error("Missing characters.yaml/relationships.yaml in Entities/. Run Burbage setup if needed.");
}

function buildRelationshipGraph(
  charactersDocument: unknown,
  relationshipsDocument: unknown,
  sourceLabel: string
): RelationshipGraphData {
  const charactersRecord = asRecord(charactersDocument);
  const nodes: CharacterGraphNode[] = Object.entries(charactersRecord).map(([name, value]) => {
    const character = asRecord(value);
    return {
      id: name,
      name,
      type: asOptionalString(character["type"]) ?? "Unknown",
      bio: asOptionalString(character["biography"]) ?? "",
      mentions: Array.from(new Set(asStringArray(character["mentions"])))
    };
  });

  const knownNodes = new Set(nodes.map((node) => node.id));
  const relationshipsRecord = asRecord(relationshipsDocument);
  const links: CharacterGraphLink[] = [];

  for (const [relationshipName, value] of Object.entries(relationshipsRecord)) {
    const relationship = asRecord(value);
    const parties = Array.from(new Set(asStringArray(relationship["parties"])));
    if (parties.length < 2) {
      continue;
    }

    const relationshipType = asOptionalString(relationship["type"]) ?? "unspecified";
    const formation = asOptionalString(relationship["formation"]) ?? "unknown";
    const status = asOptionalString(relationship["status"]) ?? "unknown";
    const description = asOptionalString(relationship["description"]) ?? "";
    const mentions = Array.from(new Set(asStringArray(relationship["mentions"])));

    for (let i = 0; i < parties.length - 1; i += 1) {
      for (let j = i + 1; j < parties.length; j += 1) {
        const source = parties[i];
        const target = parties[j];
        if (!knownNodes.has(source) || !knownNodes.has(target)) {
          continue;
        }
        links.push({
          id: `${relationshipName}:${source}:${target}`,
          source,
          target,
          relationshipName,
          relationshipType,
          formation,
          status,
          description,
          mentions
        });
      }
    }
  }

  return { nodes, links, sourceLabel };
}

function getRelationshipDashboardHtml(graph: RelationshipGraphData): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const title = `Relationships (${graph.sourceLabel})`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
    }
    .root {
      display: grid;
      grid-template-rows: auto 1fr;
      width: 100%;
      height: 100%;
    }
    .header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    #graph {
      width: 100%;
      height: 100%;
      cursor: default;
    }
    .tooltip {
      position: fixed;
      z-index: 1000;
      max-width: 380px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      color: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
      pointer-events: none;
      white-space: pre-wrap;
      line-height: 1.35;
      display: none;
      font-size: 12px;
    }
    .legend {
      position: fixed;
      left: 14px;
      bottom: 14px;
      z-index: 100;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(40vw, 380px);
      max-height: 45vh;
      overflow: auto;
    }
    .legend-title {
      margin: 0 0 6px 0;
      color: var(--vscode-descriptionForeground);
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 3px 0;
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="root">
    <div class="header">${escapeHtml(title)} - hover nodes/links for details, drag nodes to reposition.</div>
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    let width = 0;
    let height = 0;
    let dragging = false;

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(300, rect.width);
      height = Math.max(300, rect.height - 42);
      svg.attr('viewBox', [0, 0, width, height]);
    }

    setSize();
    window.addEventListener('resize', () => {
      setSize();
      simulation.force('center', d3.forceCenter(width / 2, height / 2));
      simulation.force('x', d3.forceX(width / 2).strength(0.015));
      simulation.force('y', d3.forceY(height / 2).strength(0.015));
      simulation.alpha(0.35).restart();
    });

    const types = Array.from(new Set(graph.nodes.map((node) => node.type || 'Unknown'))).sort();
    const palette = [...d3.schemeTableau10, ...d3.schemeSet3];
    const color = d3.scaleOrdinal(types, palette);

    function hideTooltip() {
      tooltip.style.display = 'none';
      tooltip.textContent = '';
    }

    function positionTooltip(event) {
      const offset = 14;
      const maxX = window.innerWidth - tooltip.offsetWidth - 8;
      const maxY = window.innerHeight - tooltip.offsetHeight - 8;
      const x = Math.min(maxX, event.clientX + offset);
      const y = Math.min(maxY, event.clientY + offset);
      tooltip.style.left = Math.max(8, x) + 'px';
      tooltip.style.top = Math.max(8, y) + 'px';
    }

    function showTooltip(event, rows) {
      tooltip.textContent = rows.filter(Boolean).join('\\n');
      tooltip.style.display = 'block';
      positionTooltip(event);
    }

    function formatMentions(mentions) {
      if (!Array.isArray(mentions) || mentions.length === 0) {
        return '(none)';
      }
      return mentions.join(', ');
    }

    function renderLegend() {
      legend.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'legend-title';
      title.textContent = 'Character Type';
      legend.appendChild(title);

      for (const type of types) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = color(type);
        const label = document.createElement('span');
        label.textContent = type;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }
    }

    renderLegend();

    const container = svg.append('g');
    const linkLayer = container.append('g').attr('stroke', '#7a7a7a').attr('stroke-opacity', 0.7);
    const nodeLayer = container.append('g');
    const labelLayer = container.append('g');
    const defaultLinkOpacity = 0.7;
    const defaultLinkWidth = 1.8;
    const dimmedLinkOpacity = 0.14;
    const dimmedLinkWidth = 1.2;
    const highlightedLinkOpacity = 1;
    const highlightedLinkWidth = 2.9;

    const zoom = d3.zoom()
      .scaleExtent([0.2, 3.5])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
        hideTooltip();
        resetRelationshipLinkHighlight();
      });
    svg.call(zoom);

    function linkEndId(linkEnd) {
      return typeof linkEnd === 'string' ? linkEnd : linkEnd.id;
    }

    const link = linkLayer
      .selectAll('line')
      .data(graph.links, (d) => d.id)
      .join('line')
      .attr('stroke-width', defaultLinkWidth)
      .attr('stroke-opacity', defaultLinkOpacity)
      .on('mouseover', (event, d) => {
        if (dragging) return;
        showTooltip(event, [
          'Relationship: ' + d.relationshipType,
          'Formation: ' + d.formation,
          'Status: ' + d.status,
          'Description: ' + (d.description || '(none)'),
          'Mentions: ' + formatMentions(d.mentions)
        ]);
      })
      .on('mousemove', (event) => {
        if (dragging || tooltip.style.display !== 'block') return;
        positionTooltip(event);
      })
      .on('mouseout', hideTooltip);

    const node = nodeLayer
      .selectAll('circle')
      .data(graph.nodes, (d) => d.id)
      .join('circle')
      .attr('r', 8.5)
      .attr('fill', (d) => color(d.type || 'Unknown'))
      .attr('stroke', 'rgba(0,0,0,0.45)')
      .attr('stroke-width', 1)
      .on('mouseover', (event, d) => {
        if (dragging) return;
        showTooltip(event, [
          d.name,
          d.type ? 'Type: ' + d.type : '',
          d.bio ? 'Bio: ' + d.bio : 'Bio: (none)',
          'Mentions: ' + formatMentions(d.mentions)
        ]);
      })
      .on('mousemove', (event) => {
        if (dragging || tooltip.style.display !== 'block') return;
        positionTooltip(event);
      })
      .on('mouseout', hideTooltip);

    function resetRelationshipLinkHighlight() {
      link
        .attr('stroke-opacity', defaultLinkOpacity)
        .attr('stroke-width', defaultLinkWidth);
    }

    function highlightRelationshipLinksForNode(nodeId) {
      link
        .attr('stroke-opacity', (d) => {
          const sourceId = linkEndId(d.source);
          const targetId = linkEndId(d.target);
          return sourceId === nodeId || targetId === nodeId ? highlightedLinkOpacity : dimmedLinkOpacity;
        })
        .attr('stroke-width', (d) => {
          const sourceId = linkEndId(d.source);
          const targetId = linkEndId(d.target);
          return sourceId === nodeId || targetId === nodeId ? highlightedLinkWidth : dimmedLinkWidth;
        });
    }

    const nodeLabel = labelLayer
      .selectAll('text')
      .data(graph.nodes, (d) => d.id)
      .join('text')
      .attr('font-size', 11)
      .attr('fill', 'var(--vscode-editor-foreground)')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const simulation = d3.forceSimulation(graph.nodes)
      .force('link', d3.forceLink(graph.links).id((d) => d.id).distance(82).strength(0.35))
      .force('charge', d3.forceManyBody().strength(-130))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.015))
      .force('y', d3.forceY(height / 2).strength(0.015))
      .force('collision', d3.forceCollide(16))
      .on('tick', () => {
        link
          .attr('x1', (d) => d.source.x)
          .attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x)
          .attr('y2', (d) => d.target.y);

        node
          .attr('cx', (d) => d.x)
          .attr('cy', (d) => d.y);

        nodeLabel
          .attr('x', (d) => d.x + 10)
          .attr('y', (d) => d.y);
      });

    const drag = d3.drag()
      .on('start', (event, d) => {
        dragging = true;
        hideTooltip();
        highlightRelationshipLinksForNode(d.id);
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        hideTooltip();
        highlightRelationshipLinksForNode(d.id);
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        dragging = false;
        hideTooltip();
        resetRelationshipLinkHighlight();
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag);
  </script>
</body>
</html>`;
}

async function openTimelineDashboard(context: vscode.ExtensionContext): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the timeline dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (timelineDashboardState && timelineDashboardState.workspaceRoot === workspaceRoot) {
      timelineDashboardState.panel.reveal(vscode.ViewColumn.One, true);
      await refreshTimelineDashboard(timelineDashboardState, true);
      return;
    }

    if (timelineDashboardState) {
      disposeTimelineDashboardState(timelineDashboardState);
      timelineDashboardState = undefined;
    }

    const graph = await loadTimelineGraph(workspaceRoot);

    const panel = vscode.window.createWebviewPanel(
      "burbage.timelineDashboard",
      "Burbage: Timeline Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state: TimelineDashboardState = {
      panel,
      workspaceRoot,
      watchers: []
    };
    timelineDashboardState = state;

    panel.webview.html = getTimelineDashboardHtml(graph);

    for (const relativePath of ["Entities/characters.yaml", "Entities/locations.yaml", "Entities/events.yaml", "Manuscript/**"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, relativePath));
      const schedule = () => scheduleTimelineDashboardRefresh(state);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      state.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    panel.onDidDispose(() => {
      if (timelineDashboardState === state) {
        timelineDashboardState = undefined;
      }
      disposeTimelineDashboardState(state);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open timeline dashboard: ${message}`);
  }
}

function scheduleTimelineDashboardRefresh(state: TimelineDashboardState): void {
  if (timelineDashboardState !== state) {
    return;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshTimelineDashboard(state, false);
  }, 180);
}

async function refreshTimelineDashboard(state: TimelineDashboardState, showErrorToUser: boolean): Promise<void> {
  if (timelineDashboardState !== state) {
    return;
  }
  try {
    const graph = await loadTimelineGraph(state.workspaceRoot);
    state.panel.webview.html = getTimelineDashboardHtml(graph);
  } catch (error) {
    if (!showErrorToUser) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not refresh timeline dashboard: ${message}`);
  }
}

function disposeTimelineDashboardState(state: TimelineDashboardState): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  for (const watcher of state.watchers) {
    watcher.dispose();
  }
  state.watchers = [];
}

async function loadTimelineGraph(workspaceRoot: string): Promise<TimelineGraphData> {
  const sources = await resolveTimelineDataSources(workspaceRoot);
  const eventsPath = path.join(sources.entitiesDirPath, "events.yaml");
  const charactersPath = path.join(sources.entitiesDirPath, "characters.yaml");
  const locationsPath = path.join(sources.entitiesDirPath, "locations.yaml");
  const [eventsRaw, charactersRaw, locationsRaw, manuscriptDocuments] = await Promise.all([
    fs.readFile(eventsPath, "utf8"),
    fs.readFile(charactersPath, "utf8"),
    pathExists(locationsPath).then((exists) => (exists ? fs.readFile(locationsPath, "utf8") : "{}\n")),
    listManuscriptDocuments(sources.manuscriptDirPath)
  ]);

  return buildTimelineGraph(
    parseYaml(eventsRaw),
    parseYaml(charactersRaw),
    parseYaml(locationsRaw),
    manuscriptDocuments,
    sources.sourceLabel
  );
}

async function resolveTimelineDataSources(workspaceRoot: string): Promise<{
  entitiesDirPath: string;
  manuscriptDirPath: string;
  sourceLabel: string;
}> {
  const entitiesDirPath = path.join(workspaceRoot, "Entities");
  const manuscriptDirPath = path.join(workspaceRoot, "Manuscript");
  const hasCharacters = await pathExists(path.join(entitiesDirPath, "characters.yaml"));
  const hasEvents = await pathExists(path.join(entitiesDirPath, "events.yaml"));
  const hasManuscriptDir = await pathExists(manuscriptDirPath);
  if (hasCharacters && hasEvents && hasManuscriptDir) {
    return {
      entitiesDirPath,
      manuscriptDirPath,
      sourceLabel: "Entities/ + Manuscript/"
    };
  }

  throw new Error("Missing characters.yaml/events.yaml in Entities/ or missing Manuscript/ directory.");
}

function buildTimelineGraph(
  eventsDocument: unknown,
  charactersDocument: unknown,
  locationsDocument: unknown,
  manuscriptDocuments: string[],
  sourceLabel: string
): TimelineGraphData {
  const eventsRecord = asRecord(eventsDocument);
  const charactersRecord = asRecord(charactersDocument);
  const locationsRecord = asRecord(locationsDocument);
  const eventEntries = Object.entries(eventsRecord);
  const knownCharacters = new Set(Object.keys(charactersRecord));
  const knownLocations = new Set(Object.keys(locationsRecord));

  const documentOrder: string[] = [];
  const knownDocuments = new Set<string>();
  for (const manuscriptDocument of manuscriptDocuments) {
    const normalized = normalizeDocumentReference(manuscriptDocument);
    if (!normalized || knownDocuments.has(normalized)) {
      continue;
    }
    knownDocuments.add(normalized);
    documentOrder.push(normalized);
  }
  const documentsByLower = new Map<string, string>();
  const documentsByBasenameLower = new Map<string, string[]>();
  const documentsByStemLower = new Map<string, string[]>();
  for (const documentName of documentOrder) {
    documentsByLower.set(documentName.toLowerCase(), documentName);

    const basenameLower = path.posix.basename(documentName).toLowerCase();
    const basenameMatches = documentsByBasenameLower.get(basenameLower) ?? [];
    basenameMatches.push(documentName);
    documentsByBasenameLower.set(basenameLower, basenameMatches);

    const stemLower = basenameLower.replace(/\.[^.]+$/, "");
    const stemMatches = documentsByStemLower.get(stemLower) ?? [];
    stemMatches.push(documentName);
    documentsByStemLower.set(stemLower, stemMatches);
  }

  const resolveEventMentionDocument = (mentionReference: string): string | undefined => {
    const normalizedMention = normalizeDocumentReference(mentionReference);
    if (!normalizedMention) {
      return undefined;
    }

    const exact = documentsByLower.get(normalizedMention.toLowerCase());
    if (exact) {
      return exact;
    }

    const basenameLower = path.posix.basename(normalizedMention).toLowerCase();
    const basenameMatches = documentsByBasenameLower.get(basenameLower) ?? [];
    if (basenameMatches.length === 1) {
      return basenameMatches[0];
    }

    const stemLower = basenameLower.replace(/\.[^.]+$/, "");
    const stemMatches = documentsByStemLower.get(stemLower) ?? [];
    if (stemMatches.length === 1) {
      return stemMatches[0];
    }

    return undefined;
  };

  const characterEventMap = new Map<string, Set<number>>();
  const locationEventMap = new Map<string, Set<number>>();
  const documentEventMap = new Map<string, Set<number>>();
  const nodes: TimelineGraphNode[] = [];
  const links: TimelineGraphLink[] = [];

  for (let eventIndex = 0; eventIndex < eventEntries.length; eventIndex += 1) {
    const [eventName, eventValue] = eventEntries[eventIndex];
    const event = asRecord(eventValue);
    const eventMentions = toUniqueStrings(
      asStringArray(event["mentions"])
        .map((mention) => resolveEventMentionDocument(mention))
        .filter((mention): mention is string => typeof mention === "string")
    );
    const eventParties = toUniqueStrings(asStringArray(event["parties"]));
    const eventLocations = toUniqueStrings(asStringArray(event["locations"]));
    const eventId = `event:${eventName}`;

    nodes.push({
      id: eventId,
      name: eventName,
      nodeKind: "event",
      mentions: eventMentions,
      connectedEventSpan: 0,
      connectedEventCount: 1,
      meanEventIndex: eventIndex,
      eventIndex,
      date: asOptionalString(event["date"]) ?? "",
      summary: asOptionalString(event["summary"]) ?? ""
    });

    for (const partyName of eventParties) {
      if (!knownCharacters.has(partyName)) {
        continue;
      }

      const characterId = `character:${partyName}`;
      links.push({
        id: `party:${eventName}:${partyName}`,
        source: characterId,
        target: eventId,
        linkKind: "party"
      });

      const eventIndices = characterEventMap.get(partyName) ?? new Set<number>();
      eventIndices.add(eventIndex);
      characterEventMap.set(partyName, eventIndices);
    }

    for (const locationName of eventLocations) {
      if (!knownLocations.has(locationName)) {
        continue;
      }

      const locationId = `location:${locationName}`;
      links.push({
        id: `location:${eventName}:${locationName}`,
        source: locationId,
        target: eventId,
        linkKind: "location"
      });

      const eventIndices = locationEventMap.get(locationName) ?? new Set<number>();
      eventIndices.add(eventIndex);
      locationEventMap.set(locationName, eventIndices);
    }

    for (const mention of eventMentions) {
      if (!knownDocuments.has(mention)) {
        continue;
      }
      const documentId = `document:${mention}`;
      links.push({
        id: `mention:${eventName}:${mention}`,
        source: documentId,
        target: eventId,
        linkKind: "mention"
      });

      const eventIndices = documentEventMap.get(mention) ?? new Set<number>();
      eventIndices.add(eventIndex);
      documentEventMap.set(mention, eventIndices);
    }
  }

  for (const [characterName, characterValue] of Object.entries(charactersRecord)) {
    const character = asRecord(characterValue);
    const connected = getConnectedEventStats(characterEventMap.get(characterName), eventEntries.length);
    nodes.push({
      id: `character:${characterName}`,
      name: characterName,
      nodeKind: "character",
      mentions: toUniqueStrings(asStringArray(character["mentions"])),
      connectedEventSpan: connected.span,
      connectedEventCount: connected.count,
      meanEventIndex: connected.meanIndex,
      characterType: asOptionalString(character["type"]) ?? "Unknown",
      bio: asOptionalString(character["biography"]) ?? ""
    });
  }

  for (const [locationName, locationValue] of Object.entries(locationsRecord)) {
    const location = asRecord(locationValue);
    const connected = getConnectedEventStats(locationEventMap.get(locationName), eventEntries.length);
    nodes.push({
      id: `location:${locationName}`,
      name: locationName,
      nodeKind: "location",
      mentions: toUniqueStrings(asStringArray(location["mentions"])),
      connectedEventSpan: connected.span,
      connectedEventCount: connected.count,
      meanEventIndex: connected.meanIndex,
      bio: asOptionalString(location["description"]) ?? ""
    });
  }

  for (const documentName of documentOrder) {
    const connected = getConnectedEventStats(documentEventMap.get(documentName), eventEntries.length);
    nodes.push({
      id: `document:${documentName}`,
      name: documentName,
      nodeKind: "document",
      mentions: [documentName],
      connectedEventSpan: connected.span,
      connectedEventCount: connected.count,
      meanEventIndex: connected.meanIndex
    });
  }

  return {
    nodes,
    links,
    sourceLabel
  };
}

function getTimelineDashboardHtml(graph: TimelineGraphData): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const title = `Timeline (${graph.sourceLabel})`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
    }
    .root {
      display: grid;
      grid-template-rows: auto 1fr;
      width: 100%;
      height: 100%;
    }
    .header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    #graph {
      width: 100%;
      height: 100%;
      cursor: default;
    }
    .tooltip {
      position: fixed;
      z-index: 1000;
      max-width: 420px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      color: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
      pointer-events: none;
      white-space: pre-wrap;
      line-height: 1.35;
      display: none;
      font-size: 12px;
    }
    .legend {
      position: fixed;
      left: 14px;
      bottom: 14px;
      z-index: 100;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(40vw, 420px);
      max-height: 45vh;
      overflow: auto;
    }
    .legend-title {
      margin: 8px 0 6px 0;
      color: var(--vscode-descriptionForeground);
    }
    .legend-title:first-child {
      margin-top: 0;
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 3px 0;
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="root">
    <div class="header">${escapeHtml(title)} - drag nodes to inspect local structure; the event backbone auto-snaps into timeline order.</div>
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const aspect = 0.5;
    let width = 0;
    let height = 0;
    let dragging = false;
    let backboneY = 0;
    let backboneDx = 150;
    let backboneStartX = 0;
    const backboneDxScale = 1.5;
    const eventAnchorStrength = 5.0;
    const anchorById = new Map();

    const eventNodes = graph.nodes
      .filter((node) => node.nodeKind === 'event')
      .sort((a, b) => (a.eventIndex || 0) - (b.eventIndex || 0));
    const eventBackboneLinks = eventNodes.slice(0, -1).map((sourceNode, index) => ({
      id: 'backbone:' + index,
      source: sourceNode,
      target: eventNodes[index + 1]
    }));
    const characterNodes = graph.nodes.filter((node) => node.nodeKind === 'character');
    const characterLikeNodes = graph.nodes.filter((node) => node.nodeKind === 'character' || node.nodeKind === 'location');
    const documentNodes = graph.nodes.filter((node) => node.nodeKind === 'document');
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

    const types = Array.from(new Set(characterNodes.map((node) => node.characterType || 'Unknown'))).sort();
    if (types.length === 0) {
      types.push('Unknown');
    }
    const palette = [...d3.schemeTableau10, ...d3.schemeSet3];
    const characterColor = d3.scaleOrdinal(types, palette);

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function isCharacterLikeNode(node) {
      return node.nodeKind === 'character' || node.nodeKind === 'location';
    }

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(420, rect.width);
      height = Math.max(320, rect.height - 42);
      svg.attr('viewBox', [0, 0, width, height]);
    }

    function updateTargets() {
      backboneY = height / 2;
      const eventCount = eventNodes.length;
      if (eventCount <= 1) {
        backboneDx = Math.max(64, Math.min(140, width * 0.35)) * backboneDxScale;
        backboneStartX = width / 2;
      } else {
        const margin = clamp(width * 0.12, 72, 180);
        backboneStartX = margin;
        backboneDx = ((width - margin * 2) / (eventCount - 1)) * backboneDxScale;
      }

      anchorById.clear();
      for (const eventNode of eventNodes) {
        const index = Number.isFinite(eventNode.eventIndex) ? eventNode.eventIndex : 0;
        const x = eventCount <= 1 ? width / 2 : backboneStartX + index * backboneDx;
        anchorById.set(eventNode.id, { x, y: backboneY });
      }

      const centerIndex = eventCount <= 1 ? 0 : (eventCount - 1) / 2;
      for (const node of graph.nodes) {
        if (node.nodeKind === 'event') {
          const anchor = anchorById.get(node.id) || { x: width / 2, y: backboneY };
          node.targetX = anchor.x;
          node.targetY = anchor.y;
          node.fy = backboneY;
        } else {
          const isDisconnected = !Number.isFinite(node.connectedEventCount) || node.connectedEventCount <= 0;
          if (isDisconnected) {
            const firstBackboneNode = eventNodes.length > 0 ? eventNodes[0] : undefined;
            const firstAnchor = firstBackboneNode ? anchorById.get(firstBackboneNode.id) : undefined;
            node.targetX = (firstAnchor ? firstAnchor.x : width / 2) - 2 * backboneDx;
            if (isCharacterLikeNode(node)) {
              const yOffset = 2 * backboneDx * aspect;
              node.targetY = backboneY - yOffset;
            } else {
              const span = Number.isFinite(node.connectedEventSpan) ? Math.max(0, node.connectedEventSpan) : 0;
              const spanOffset = (span + 1) * backboneDx * aspect;
              node.targetY = backboneY + 2 * backboneDx + spanOffset;
            }
          } else {
            const meanIndex = Number.isFinite(node.meanEventIndex) ? node.meanEventIndex : centerIndex;
            node.targetX = eventCount <= 1 ? width / 2 : backboneStartX + meanIndex * backboneDx;
            const span = Number.isFinite(node.connectedEventSpan) ? Math.max(0, node.connectedEventSpan) : 0;
            const yOffset = (span + 1) * backboneDx * aspect;
            node.targetY = isCharacterLikeNode(node) ? backboneY - yOffset : backboneY + 4 * backboneDx + yOffset;
          }
        }

        if (!Number.isFinite(node.x)) {
          node.x = node.targetX;
        }
        if (!Number.isFinite(node.y)) {
          node.y = node.targetY;
        }
      }
    }

    function nodeFill(node) {
      if (node.nodeKind === 'event') {
        return '#d7a12f';
      }
      if (node.nodeKind === 'character') {
        return characterColor(node.characterType || 'Unknown');
      }
      if (node.nodeKind === 'location') {
        return '#029155';
      }
      return '#5d92c9';
    }

    function nodeRadius(node) {
      if (node.nodeKind === 'event') {
        return 8.8;
      }
      if (node.nodeKind === 'character') {
        return 8.2;
      }
      if (node.nodeKind === 'location') {
        return 8.2;
      }
      return 7.6;
    }

    function hideTooltip() {
      tooltip.style.display = 'none';
      tooltip.textContent = '';
    }

    function positionTooltip(event) {
      const offset = 14;
      const maxX = window.innerWidth - tooltip.offsetWidth - 8;
      const maxY = window.innerHeight - tooltip.offsetHeight - 8;
      const x = Math.min(maxX, event.clientX + offset);
      const y = Math.min(maxY, event.clientY + offset);
      tooltip.style.left = Math.max(8, x) + 'px';
      tooltip.style.top = Math.max(8, y) + 'px';
    }

    function showTooltip(event, rows) {
      tooltip.textContent = rows.filter(Boolean).join('\\n');
      tooltip.style.display = 'block';
      positionTooltip(event);
    }

    function formatMentions(mentions) {
      if (!Array.isArray(mentions) || mentions.length === 0) {
        return '(none)';
      }
      return mentions.join(', ');
    }

    function renderLegend() {
      legend.innerHTML = '';

      const nodeKindsTitle = document.createElement('div');
      nodeKindsTitle.className = 'legend-title';
      nodeKindsTitle.textContent = 'Node Kind';
      legend.appendChild(nodeKindsTitle);

      const nodeKindRows = [
        { label: 'Event', color: '#d7a12f' },
        { label: 'Location', color: '#10b981' },
        { label: 'Document', color: '#5d92c9' }
      ];
      for (const item of nodeKindRows) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = item.color;
        const label = document.createElement('span');
        label.textContent = item.label;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }

      const typeTitle = document.createElement('div');
      typeTitle.className = 'legend-title';
      typeTitle.textContent = 'Character Type';
      legend.appendChild(typeTitle);

      for (const type of types) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = characterColor(type);
        const label = document.createElement('span');
        label.textContent = type;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }
    }

    setSize();
    updateTargets();
    renderLegend();

    const backboneMarkerId = 'timeline-backbone-arrow';
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', backboneMarkerId)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 9.5)
      .attr('refY', 0)
      .attr('markerWidth', 7)
      .attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#7b7b7b');

    const container = svg.append('g');
    const backboneEdgeLayer = container.append('g');
    const linkLayer = container.append('g').attr('fill', 'none');
    const nodeLayer = container.append('g');
    const labelLayer = container.append('g');
    const defaultTimelineLinkOpacity = 0.68;
    const defaultTimelineLinkWidth = 1.4;
    const dimmedTimelineLinkOpacity = 0.12;
    const dimmedTimelineLinkWidth = 1.0;
    const highlightedTimelineLinkOpacity = 1;
    const highlightedTimelineLinkWidth = 2.6;
    const defaultBackboneOpacity = 0.85;
    const defaultBackboneWidth = 1.6;
    const dimmedBackboneOpacity = 0.2;
    const highlightedBackboneOpacity = 1;
    const highlightedBackboneWidth = 2.4;

    const backboneEdge = backboneEdgeLayer
      .selectAll('line')
      .data(eventBackboneLinks, (d) => d.id)
      .join('line')
      .attr('stroke', '#7b7b7b')
      .attr('stroke-opacity', defaultBackboneOpacity)
      .attr('stroke-width', defaultBackboneWidth)
      .attr('stroke-linecap', 'round')
      .attr('marker-end', 'url(#' + backboneMarkerId + ')')
      .attr('pointer-events', 'none');

    const zoom = d3.zoom()
      .scaleExtent([0.2, 3.5])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
        hideTooltip();
        resetTimelineConnectionHighlight();
      });
    svg.call(zoom);

    function linkEndId(linkEnd) {
      return typeof linkEnd === 'string' ? linkEnd : linkEnd.id;
    }

    function timelineLinkPath(linkDatum) {
      const sourceNode = typeof linkDatum.source === 'string' ? nodeById.get(linkDatum.source) : linkDatum.source;
      const targetNode = typeof linkDatum.target === 'string' ? nodeById.get(linkDatum.target) : linkDatum.target;
      if (!sourceNode || !targetNode) {
        return '';
      }

      const sourceIsEvent = sourceNode.nodeKind === 'event';
      const targetIsEvent = targetNode.nodeKind === 'event';
      if (sourceIsEvent === targetIsEvent) {
        return 'M' + sourceNode.x + ',' + sourceNode.y + 'L' + targetNode.x + ',' + targetNode.y;
      }

      const eventNode = sourceIsEvent ? sourceNode : targetNode;
      const entityNode = sourceIsEvent ? targetNode : sourceNode;
      const direction = entityNode.y < eventNode.y ? -1 : 1;
      const eventRadius = nodeRadius(eventNode);
      const startX = eventNode.x;
      const startY = eventNode.y + direction * (eventRadius + 1);
      const endX = entityNode.x;
      const endY = entityNode.y;
      const deltaY = Math.max(24, Math.abs(endY - startY));
      const controlDelta = Math.max(16, Math.min(170, deltaY * 0.44));
      const control1X = startX;
      const control1Y = startY + direction * controlDelta;
      const control2X = endX;
      const control2Y = endY - direction * Math.min(140, Math.max(14, deltaY * 0.36));
      return (
        'M' + startX + ',' + startY +
        'C' + control1X + ',' + control1Y + ' ' + control2X + ',' + control2Y + ' ' + endX + ',' + endY
      );
    }

    const link = linkLayer
      .selectAll('path')
      .data(graph.links, (d) => d.id)
      .join('path')
      .attr('stroke', (d) => (d.linkKind === 'mention' ? '#6f85a1' : '#7a7a7a'))
      .attr('stroke-opacity', defaultTimelineLinkOpacity)
      .attr('stroke-width', defaultTimelineLinkWidth)
      .on('mouseover', (event, d) => {
        if (dragging) return;
        const sourceId = linkEndId(d.source);
        const targetId = linkEndId(d.target);
        const sourceName = nodeById.get(sourceId)?.name || sourceId;
        const targetName = nodeById.get(targetId)?.name || targetId;
        showTooltip(event, [
          d.linkKind === 'mention'
            ? 'Document Mention'
            : d.linkKind === 'location'
              ? 'Location Involvement'
              : 'Character Participation',
          sourceName + ' -> ' + targetName
        ]);
      })
      .on('mousemove', (event) => {
        if (dragging || tooltip.style.display !== 'block') return;
        positionTooltip(event);
      })
      .on('mouseout', hideTooltip);

    const node = nodeLayer
      .selectAll('circle')
      .data(graph.nodes, (d) => d.id)
      .join('circle')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => nodeFill(d))
      .attr('stroke', 'rgba(0,0,0,0.45)')
      .attr('stroke-width', 1)
      .on('mouseover', (event, d) => {
        if (dragging) return;
        if (d.nodeKind === 'event') {
          showTooltip(event, [
            d.name,
            d.date ? 'Date: ' + d.date : 'Date: (unknown)',
            d.summary ? 'Summary: ' + d.summary : 'Summary: (none)',
            'Mentions: ' + formatMentions(d.mentions)
          ]);
          return;
        }

        if (d.nodeKind === 'character') {
          showTooltip(event, [
            d.name,
            d.characterType ? 'Type: ' + d.characterType : 'Type: Unknown',
            'Connected event span: ' + (d.connectedEventSpan + 1),
            d.bio ? 'Bio: ' + d.bio : 'Bio: (none)',
            'Mentions: ' + formatMentions(d.mentions)
          ]);
          return;
        }

        if (d.nodeKind === 'location') {
          showTooltip(event, [
            d.name,
            'Type: Location',
            'Connected event span: ' + (d.connectedEventSpan + 1),
            d.bio ? 'Description: ' + d.bio : 'Description: (none)',
            'Mentions: ' + formatMentions(d.mentions)
          ]);
          return;
        }

        showTooltip(event, [
          d.name,
          'Connected event span: ' + (d.connectedEventSpan + 1),
          'Linked events: ' + d.connectedEventCount
        ]);
      })
      .on('mousemove', (event) => {
        if (dragging || tooltip.style.display !== 'block') return;
        positionTooltip(event);
      })
      .on('mouseout', hideTooltip);

    function resetTimelineConnectionHighlight() {
      link
        .attr('stroke-opacity', defaultTimelineLinkOpacity)
        .attr('stroke-width', defaultTimelineLinkWidth);
      backboneEdge
        .attr('stroke-opacity', defaultBackboneOpacity)
        .attr('stroke-width', defaultBackboneWidth);
    }

    function highlightTimelineConnectionsForNode(nodeId) {
      link
        .attr('stroke-opacity', (d) => {
          const sourceId = linkEndId(d.source);
          const targetId = linkEndId(d.target);
          return sourceId === nodeId || targetId === nodeId ? highlightedTimelineLinkOpacity : dimmedTimelineLinkOpacity;
        })
        .attr('stroke-width', (d) => {
          const sourceId = linkEndId(d.source);
          const targetId = linkEndId(d.target);
          return sourceId === nodeId || targetId === nodeId ? highlightedTimelineLinkWidth : dimmedTimelineLinkWidth;
        });

      backboneEdge
        .attr('stroke-opacity', (d) => (d.source.id === nodeId || d.target.id === nodeId ? highlightedBackboneOpacity : dimmedBackboneOpacity))
        .attr('stroke-width', (d) => (d.source.id === nodeId || d.target.id === nodeId ? highlightedBackboneWidth : defaultBackboneWidth));
    }

    const characterLabels = labelLayer
      .selectAll('text.character')
      .data(characterLikeNodes, (d) => d.id)
      .join('text')
      .attr('class', 'character')
      .attr('font-size', 11)
      .attr('fill', 'var(--vscode-editor-foreground)')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const documentLabels = labelLayer
      .selectAll('text.document')
      .data(documentNodes, (d) => d.id)
      .join('text')
      .attr('class', 'document')
      .attr('font-size', 11)
      .attr('fill', 'var(--vscode-editor-foreground)')
      .attr('dominant-baseline', 'hanging')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const eventLabels = labelLayer
      .selectAll('text.event')
      .data(eventNodes, (d) => d.id)
      .join('text')
      .attr('class', 'event')
      .attr('font-size', 11)
      .attr('fill', 'var(--vscode-editor-foreground)')
      .attr('dominant-baseline', 'hanging')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const linkForce = d3.forceLink(graph.links)
      .id((d) => d.id)
      .distance((d) => (d.linkKind === 'mention' ? Math.max(24, backboneDx * 0.8) : Math.max(28, backboneDx * 0.9)))
      .strength(0.08);

    const simulation = d3.forceSimulation(graph.nodes)
      .velocityDecay(0.45)
      .force('link', linkForce)
      .force(
        'x',
        d3.forceX((d) => d.targetX).strength((d) => (d.nodeKind === 'event' ? eventAnchorStrength : 0.24))
      )
      .force(
        'y',
        d3.forceY((d) => d.targetY).strength((d) => (d.nodeKind === 'event' ? eventAnchorStrength : 0.24))
      )
      .force(
        'characterRepel',
        d3.forceManyBody().strength((d) => (d.nodeKind === 'character' || d.nodeKind === 'location' ? -20 : 0)).distanceMax(260)
      )
      .force(
        'documentRepel',
        d3.forceManyBody().strength((d) => (d.nodeKind === 'document' ? -20 : 0)).distanceMax(260)
      )
      .force('collision', d3.forceCollide((d) => nodeRadius(d) + 3).strength(0.85))
      .on('tick', () => {
        backboneEdge
          .attr('x1', (d) => d.source.x)
          .attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x)
          .attr('y2', (d) => d.target.y);

        link
          .attr('d', (d) => timelineLinkPath(d));

        node
          .attr('cx', (d) => d.x)
          .attr('cy', (d) => d.y);

        characterLabels
          .attr('x', (d) => d.x + 10)
          .attr('y', (d) => d.y);

        documentLabels.attr('transform', (d) => {
          const labelY = Math.max(backboneY + 8, d.y + 6);
          return 'translate(' + (d.x + 8) + ',' + labelY + ') rotate(45)';
        });

        eventLabels.attr('transform', (d) => {
          const labelY = Math.max(backboneY + 8, d.y + 6);
          return 'translate(' + (d.x + 8) + ',' + labelY + ') rotate(45)';
        });
      });

    window.addEventListener('resize', () => {
      setSize();
      updateTargets();
      linkForce.distance((d) => (d.linkKind === 'mention' ? Math.max(24, backboneDx * 0.8) : Math.max(28, backboneDx * 0.9)));
      simulation.alpha(0.7).restart();
      hideTooltip();
      resetTimelineConnectionHighlight();
    });

    const drag = d3.drag()
      .on('start', (event, d) => {
        dragging = true;
        hideTooltip();
        highlightTimelineConnectionsForNode(d.id);
        if (!event.active) simulation.alphaTarget(0.32).restart();
        d.fx = d.x;
        d.fy = d.nodeKind === 'event' ? backboneY : d.y;
      })
      .on('drag', (event, d) => {
        hideTooltip();
        highlightTimelineConnectionsForNode(d.id);
        d.fx = event.x;
        d.fy = d.nodeKind === 'event' ? backboneY : event.y;
      })
      .on('end', (event, d) => {
        dragging = false;
        hideTooltip();
        resetTimelineConnectionHighlight();
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = d.nodeKind === 'event' ? backboneY : null;
      });

    node.call(drag);
  </script>
</body>
</html>`;
}

async function runSetupProject(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a folder/workspace before running Burbage setup.");
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const summary: string[] = [];

  await ensureDirectory(path.join(workspaceRoot, "Manuscript"), summary, workspaceRoot);
  await ensureDirectory(path.join(workspaceRoot, "Entities"), summary, workspaceRoot);
  await ensureDirectory(path.join(workspaceRoot, ".vscode"), summary, workspaceRoot);

  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "characters.yaml"), "{}\n", summary, workspaceRoot);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "locations.yaml"), "{}\n", summary, workspaceRoot);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "events.yaml"), "{}\n", summary, workspaceRoot);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "relationships.yaml"), "{}\n", summary, workspaceRoot);

  await ensureGitRepo(workspaceRoot, summary);

  await copyTemplateWithPolicy({
    templatePath: path.join(context.extensionPath, "AGENTS_burbage.md"),
    destinationPath: path.join(workspaceRoot, "AGENTS.md"),
    summary,
    existingPolicy: "replace",
    workspaceRoot
  });

  await copyTemplateWithPolicy({
    templatePath: path.join(context.extensionPath, "settings_burbage.json"),
    destinationPath: path.join(workspaceRoot, ".vscode", "settings.json"),
    summary,
    existingPolicy: "skip",
    workspaceRoot
  });

  await ensureLocalCodexRuntime(workspaceRoot, summary);
  await ensureGitignoreEntry(workspaceRoot, ".burbage/runtime/", summary);
  await ensureGitignoreEntry(workspaceRoot, "AGENTS.md", summary);
  await ensureCodexLogin(workspaceRoot, summary);

  await vscode.window.showInformationMessage(
    "Burbage setup complete:\n" + summary.map((item) => `- ${item}`).join("\n")
  );
}

class BurbageSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "burbage.sidebar";
  private view?: vscode.WebviewView;
  private threadId?: string;
  private busy = false;
  private queuedPrompts: Array<{ prompt: string; addUserBubble: boolean }> = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getSidebarHtml();

    const disposable = webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isSendPromptMessage(message)) {
        await this.handlePrompt(message.text, false);
        return;
      }
      if (isSyncMessage(message)) {
        await this.handlePrompt(DEFAULT_SYNC_PROMPT, true);
      }
    });

    webviewView.onDidDispose(() => {
      disposable.dispose();
      this.view = undefined;
      this.threadId = undefined;
      this.busy = false;
      this.queuedPrompts = [];
    });

    this.context.subscriptions.push(disposable);
    await this.flushQueue();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.burbage");
    this.view?.show?.(true);
  }

  async requestSync(): Promise<void> {
    await this.reveal();
    await this.handlePrompt(DEFAULT_SYNC_PROMPT, true);
  }

  private async handlePrompt(prompt: string, addUserBubble: boolean): Promise<void> {
    const normalized = prompt.trim();
    if (!normalized) {
      return;
    }

    if (!this.view) {
      this.queuedPrompts.push({ prompt: normalized, addUserBubble });
      return;
    }

    if (this.busy) {
      this.queuedPrompts.push({ prompt: normalized, addUserBubble });
      if (addUserBubble) {
        void this.view.webview.postMessage({ type: "user", text: normalized });
      }
      return;
    }

    const workspaceRoot = getWorkspaceRootOrThrow();
    this.busy = true;
    if (addUserBubble) {
      void this.view.webview.postMessage({ type: "user", text: normalized });
    }

    let lastStatusText = "";
    let lastStatusAt = 0;
    const renderWorkingStatus = (thinkingLines: string[], force: boolean): void => {
      if (!this.view) {
        return;
      }
      const nextText = buildWorkingStatusText(thinkingLines);
      const now = Date.now();
      if (!force && (nextText === lastStatusText || now - lastStatusAt < 220)) {
        return;
      }
      lastStatusText = nextText;
      lastStatusAt = now;
      void this.view.webview.postMessage({ type: "status", text: nextText });
    };
    renderWorkingStatus([], true);

    try {
      const result = await runCodexPrompt(normalized, workspaceRoot, this.threadId, (thinkingLines) => {
        renderWorkingStatus(thinkingLines, false);
      });
      this.threadId = result.threadId ?? this.threadId;
      void this.view.webview.postMessage({ type: "assistant", text: result.reply });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      void this.view.webview.postMessage({ type: "error", text: messageText });
    } finally {
      this.busy = false;
      void this.view.webview.postMessage({ type: "status", text: "" });
      await this.flushQueue();
    }
  }

  private async flushQueue(): Promise<void> {
    if (!this.view || this.busy || this.queuedPrompts.length === 0) {
      return;
    }
    const next = this.queuedPrompts.shift();
    if (!next) {
      return;
    }
    await this.handlePrompt(next.prompt, next.addUserBubble);
  }
}

type SendPromptMessage = { type: "sendPrompt"; text: string };
type SyncMessage = { type: "sync" };

function isSendPromptMessage(value: unknown): value is SendPromptMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value as { type?: unknown; text?: unknown };
  return maybe.type === "sendPrompt" && typeof maybe.text === "string";
}

function isSyncMessage(value: unknown): value is SyncMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (value as { type?: unknown }).type === "sync";
}

function getWorkspaceRootOrThrow(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("Open a folder/workspace before using Burbage chat.");
  }
  return workspaceFolder.uri.fsPath;
}

function buildWorkingStatusText(thinkingLines: string[]): string {
  const lines = thinkingLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  if (lines.length === 0) {
    return "Burbage is working...";
  }
  return ["Burbage is working...", ...lines.map((line) => `- ${line}`)].join("\n");
}

function getSidebarHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); margin: 0; padding: 0; }
    .root { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
    .actions { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; }
    .transcript { padding: 12px; overflow-y: auto; }
    .message { white-space: pre-wrap; margin: 0 0 10px 0; padding: 10px; border-radius: 6px; }
    .message.user { background: var(--vscode-editor-inactiveSelectionBackground); }
    .message.assistant { background: var(--vscode-sideBar-background); }
    .message.error { background: var(--vscode-inputValidation-errorBackground); }
    .composer { display: block; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
    textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 60px; max-height: 200px; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 4px; }
    button { font: inherit; padding: 0 14px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .message.working { color: var(--vscode-descriptionForeground); white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="root">
    <div class="actions">
      <button id="sync">Sync</button>
    </div>
    <div id="transcript" class="transcript"></div>
    <div class="composer">
      <textarea id="prompt" placeholder="Ask Burbage..."></textarea>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const transcript = document.getElementById("transcript");
    const promptEl = document.getElementById("prompt");
    const syncBtn = document.getElementById("sync");
    let workingEl = null;

    function addMessage(kind, text) {
      const el = document.createElement("div");
      el.className = "message " + kind;
      el.textContent = text;
      transcript.appendChild(el);
      transcript.scrollTop = transcript.scrollHeight;
    }

    function send() {
      const text = promptEl.value.trim();
      if (!text) return;
      addMessage("user", text);
      promptEl.value = "";
      vscode.postMessage({ type: "sendPrompt", text });
    }

    function setWorkingStatus(text) {
      const next = (text || "").trim();
      if (!next) {
        if (workingEl && workingEl.parentElement) {
          workingEl.remove();
        }
        workingEl = null;
        return;
      }

      if (!workingEl || !workingEl.parentElement) {
        workingEl = document.createElement("div");
        workingEl.className = "message assistant working";
        transcript.appendChild(workingEl);
      }
      workingEl.textContent = next;
      transcript.scrollTop = transcript.scrollHeight;
    }

    function addAssistantReply(text) {
      if (workingEl && workingEl.parentElement) {
        workingEl.className = "message assistant";
        workingEl.textContent = text;
        workingEl = null;
        transcript.scrollTop = transcript.scrollHeight;
        return;
      }
      addMessage("assistant", text);
    }

    syncBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "sync" });
    });
    promptEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "user") addMessage("user", msg.text || "");
      if (msg.type === "assistant") addAssistantReply(msg.text || "");
      if (msg.type === "error") addMessage("error", msg.text || "Unknown error");
      if (msg.type === "status") setWorkingStatus(msg.text || "");
    });
  </script>
</body>
</html>`;
}

async function runCodexPrompt(
  prompt: string,
  workspaceRoot: string,
  threadId?: string,
  onProgress?: (thinkingLines: string[]) => void
): Promise<{ reply: string; threadId?: string }> {
  const codexCommand = await resolveCodexCommand(workspaceRoot);
  if (!(await isCodexLoggedIn(codexCommand, workspaceRoot))) {
    throw new Error("Codex is not logged in. Run 'Burbage: Login to Codex' first.");
  }

  const args = threadId
    ? [
        "exec",
        "resume",
        threadId,
        prompt,
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox"
      ]
    : [
        "exec",
        prompt,
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        workspaceRoot
      ];

  const progressLines: string[] = [];
  let streamThreadId: string | undefined;
  let streamLastAssistantMessage: string | undefined;

  const addProgress = (rawLine: string): void => {
    const normalized = normalizeProgressLine(rawLine);
    if (!normalized) {
      return;
    }
    if (progressLines[progressLines.length - 1] === normalized) {
      return;
    }
    progressLines.push(normalized);
    if (progressLines.length > 3) {
      progressLines.splice(0, progressLines.length - 3);
    }
    onProgress?.([...progressLines]);
  };

  let result: CommandResult;
  try {
    result = await runCommandStreaming(
      codexCommand,
      args,
      workspaceRoot,
      (line) => {
        const event = tryParseCodexJsonEvent(line);
        if (!event) {
          return;
        }
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          streamThreadId = event.thread_id;
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          typeof event.item.text === "string"
        ) {
          streamLastAssistantMessage = event.item.text;
        }
        const progressLine = extractProgressLineFromCodexEvent(event);
        if (progressLine) {
          addProgress(progressLine);
        }
      },
      (line) => {
        const normalized = normalizeProgressLine(line);
        if (!normalized || isToolishProgressLine(normalized)) {
          return;
        }
        addProgress(normalized);
      }
    );
  } catch (error) {
    throw new Error(formatExecError("Codex command failed.", error));
  }

  const parsed = parseCodexJsonEvents(result.stdout);
  const lastMessage = (streamLastAssistantMessage ?? parsed.lastAssistantMessage)?.trim() ?? "";
  const returnedThreadId = streamThreadId ?? parsed.threadId;

  if (lastMessage) {
    return { reply: lastMessage, threadId: returnedThreadId };
  }
  if (result.stdout.trim()) {
    return { reply: result.stdout.trim(), threadId: returnedThreadId };
  }
  if (result.stderr.trim()) {
    return { reply: result.stderr.trim(), threadId: returnedThreadId };
  }
  return { reply: "Codex returned no response text.", threadId: returnedThreadId };
}

type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  message?: string;
  summary?: string;
  error?: unknown;
};

function tryParseCodexJsonEvent(line: string): CodexJsonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as CodexJsonEvent;
  } catch {
    return undefined;
  }
}

function extractProgressLineFromCodexEvent(event: CodexJsonEvent): string | undefined {
  if (
    event.type === "item.completed" &&
    event.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    return undefined;
  }

  const directMessage = asOptionalString(event.message) ?? asOptionalString(event.summary);
  if (directMessage && !isToolishProgressLine(directMessage)) {
    return directMessage;
  }

  if (
    event.item?.type &&
    typeof event.item.text === "string" &&
    event.item.text.trim() &&
    !isToolishItemType(event.item.type)
  ) {
    if (event.item.type === "agent_message") {
      return undefined;
    }
    return `${event.item.type}: ${event.item.text}`;
  }

  if (event.type === "item.started" && event.item?.type && !isToolishItemType(event.item.type)) {
    return `${event.item.type}...`;
  }
  if (
    event.type === "item.completed" &&
    event.item?.type &&
    event.item.type !== "agent_message" &&
    !isToolishItemType(event.item.type)
  ) {
    return `${event.item.type} complete`;
  }
  if (event.type && event.type.includes("error")) {
    const errorText = asOptionalString(event.error) ?? "Codex reported an error event";
    return `${event.type}: ${errorText}`;
  }

  return undefined;
}

function normalizeProgressLine(rawLine: string): string | undefined {
  const cleaned = rawLine.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.length <= 140) {
    return cleaned;
  }
  return `${cleaned.slice(0, 137)}...`;
}

function isToolishItemType(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("tool") ||
    lower.includes("command") ||
    lower.includes("exec") ||
    lower.includes("patch") ||
    lower.includes("shell")
  );
}

function isToolishProgressLine(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("tool call") ||
    lower.includes("tool_call") ||
    lower.includes("function call") ||
    lower.includes("apply_patch") ||
    lower.includes("shell_command")
  );
}

function parseCodexJsonEvents(stdout: string): { threadId?: string; lastAssistantMessage?: string } {
  let threadId: string | undefined;
  let lastAssistantMessage: string | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== "{") {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        lastAssistantMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  return { threadId, lastAssistantMessage };
}

async function resolveCodexCommand(workspaceRoot: string): Promise<string> {
  const workspaceUri = vscode.Uri.file(workspaceRoot);
  const settings = vscode.workspace.getConfiguration(undefined, workspaceUri);
  const configuredPath = settings.get<string>("burbage.codexCliPath");

  const candidates: string[] = [];
  if (configuredPath) {
    candidates.push(path.isAbsolute(configuredPath) ? configuredPath : path.join(workspaceRoot, configuredPath));
  }
  candidates.push(getLocalCodexCliPath(path.join(workspaceRoot, ".burbage", "runtime")));
  candidates.push(process.platform === "win32" ? "codex.cmd" : "codex");

  for (const candidate of Array.from(new Set(candidates))) {
    if (await isUsableCodexCli(candidate, workspaceRoot)) {
      return candidate;
    }
  }

  throw new Error(
    "Codex CLI not found. Run 'Burbage: Setup Project' to install local Codex, then sign in using 'codex login'."
  );
}

async function ensureCodexLogin(workspaceRoot: string, summary: string[]): Promise<void> {
  try {
    const codexCommand = await resolveCodexCommand(workspaceRoot);
    const loggedIn = await isCodexLoggedIn(codexCommand, workspaceRoot);
    if (loggedIn) {
      summary.push("Codex login verified");
      return;
    }
    summary.push("Codex login required (run Burbage: Login to Codex)");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.push(`Could not verify Codex login (${message})`);
  }
}

async function isCodexLoggedIn(codexCommand: string, cwd: string): Promise<boolean> {
  try {
    const result = await execCommandCapture(codexCommand, ["login", "status"], cwd);
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return combined.includes("logged in");
  } catch {
    return false;
  }
}

async function openCodexLoginTerminal(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a folder/workspace before starting Codex login.");
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  try {
    const codexCommand = await resolveCodexCommand(workspaceRoot);
    const terminal = vscode.window.createTerminal({
      name: "Burbage Codex Login",
      cwd: workspaceRoot
    });
    terminal.show(true);
    terminal.sendText(buildTerminalCommand(codexCommand, ["login"]), true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
  }
}

function formatExecError(prefix: string, error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return `${prefix} ${String(error)}`;
  }

  const maybe = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const parts = [prefix];
  if (typeof maybe.message === "string" && maybe.message.trim()) {
    parts.push(maybe.message.trim());
  }
  if (typeof maybe.stderr === "string" && maybe.stderr.trim()) {
    parts.push(`stderr: ${maybe.stderr.trim()}`);
  }
  if (typeof maybe.stdout === "string" && maybe.stdout.trim()) {
    parts.push(`stdout: ${maybe.stdout.trim()}`);
  }
  return parts.join(" ");
}

async function ensureDirectory(dirPath: string, summary: string[], workspaceRoot: string): Promise<void> {
  if (await pathExists(dirPath)) {
    summary.push(`${relativeToWorkspace(dirPath, workspaceRoot)} already exists`);
    return;
  }

  await fs.mkdir(dirPath, { recursive: true });
  summary.push(`Created ${relativeToWorkspace(dirPath, workspaceRoot)}`);
}

async function ensureFileIfMissing(
  filePath: string,
  contents: string,
  summary: string[],
  workspaceRoot: string
): Promise<void> {
  if (await pathExists(filePath)) {
    summary.push(`${relativeToWorkspace(filePath, workspaceRoot)} already exists`);
    return;
  }

  await fs.writeFile(filePath, contents, "utf8");
  summary.push(`Created ${relativeToWorkspace(filePath, workspaceRoot)}`);
}

async function ensureGitRepo(workspaceRoot: string, summary: string[]): Promise<void> {
  const gitDir = path.join(workspaceRoot, ".git");
  if (await pathExists(gitDir)) {
    summary.push(".git already exists");
    return;
  }

  try {
    await execFile("git", ["init"], { cwd: workspaceRoot });
    summary.push("Initialized git repository");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.push(`Could not initialize git repository (${message})`);
  }
}

async function ensureGitignoreEntry(workspaceRoot: string, entry: string, summary: string[]): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const normalizedEntry = entry.trim();

  if (!(await pathExists(gitignorePath))) {
    await fs.writeFile(gitignorePath, `${normalizedEntry}\n`, "utf8");
    summary.push(`Created .gitignore with ${normalizedEntry}`);
    return;
  }

  const existing = await fs.readFile(gitignorePath, "utf8");
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(normalizedEntry)) {
    summary.push(`.gitignore already contains ${normalizedEntry}`);
    return;
  }

  const next = `${existing.trimEnd()}\n${normalizedEntry}\n`;
  await fs.writeFile(gitignorePath, next, "utf8");
  summary.push(`Added ${normalizedEntry} to .gitignore`);
}

async function ensureLocalCodexRuntime(workspaceRoot: string, summary: string[]): Promise<void> {
  const runtimeDir = path.join(workspaceRoot, ".burbage", "runtime");
  const localCodexPath = getLocalCodexCliPath(runtimeDir);

  if (await isUsableCodexCli(localCodexPath, workspaceRoot)) {
    summary.push("Local Codex CLI already installed");
    await setCodexSettings(workspaceRoot, runtimeDir, summary);
    return;
  }

  try {
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtimePackageJsonPath = path.join(runtimeDir, "package.json");
    if (!(await pathExists(runtimePackageJsonPath))) {
      const runtimePackageJson = {
        name: "burbage-runtime",
        private: true
      };
      await fs.writeFile(runtimePackageJsonPath, `${JSON.stringify(runtimePackageJson, null, 2)}\n`, "utf8");
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Burbage setup: installing local Codex CLI",
        cancellable: false
      },
      async () => {
        await runNpm(["install", "--prefix", runtimeDir, "--no-save", "@openai/codex"], workspaceRoot);
      }
    );

    if (!(await isUsableCodexCli(localCodexPath, workspaceRoot))) {
      summary.push("Failed to verify local Codex CLI after install");
      return;
    }

    summary.push("Installed Codex CLI locally at .burbage/runtime");
    await setCodexSettings(workspaceRoot, runtimeDir, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.push(`Could not install local Codex CLI (${message})`);
  }
}

async function runNpm(args: string[], cwd: string): Promise<void> {
  const candidates = getNpmCandidates();
  let lastError: unknown;

  for (const command of candidates) {
    try {
      await execCommand(command, args, cwd);
      return;
    } catch (error) {
      lastError = error;
      if (isCommandNotFoundError(error)) {
        continue;
      }
      throw error;
    }
  }

  if (process.platform !== "win32") {
    try {
      await runNpmViaLoginShell(args, cwd);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const candidateList = candidates.join(", ");
  const original = lastError instanceof Error ? ` Original error: ${lastError.message}` : "";
  throw new Error(
    `npm executable not found. Checked: ${candidateList}. Ensure Node.js/npm is installed and restart VS Code.${original}`
  );
}

async function runNpmViaLoginShell(args: string[], cwd: string): Promise<void> {
  const shellCandidates = ["/bin/zsh", "/bin/bash", "/bin/sh"];
  const command = ["npm", ...args].map(quoteForPosixShell).join(" ");
  let lastError: unknown;

  for (const shellPath of shellCandidates) {
    if (!(await pathExists(shellPath))) {
      continue;
    }
    try {
      await execFile(shellPath, ["-lc", command], { cwd });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("No usable POSIX shell found to resolve npm.");
}

async function runCommandStreaming(
  command: string,
  args: string[],
  cwd: string,
  onStdoutLine: (line: string) => void,
  onStderrLine: (line: string) => void
): Promise<CommandResult> {
  let spawnCommand = command;
  let spawnArgs = args;
  if (process.platform === "win32" && isCmdScript(command)) {
    const powershell = await resolvePowerShellExecutable();
    spawnCommand = powershell;
    spawnArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildPowerShellInvocation(command, args)];
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(spawnCommand, spawnArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const flushLines = (buffer: string, onLine: (line: string) => void): string => {
      let pending = buffer;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        onLine(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
      return pending;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = asText(chunk);
      stdout += text;
      stdoutBuffer += text;
      stdoutBuffer = flushLines(stdoutBuffer, onStdoutLine);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = asText(chunk);
      stderr += text;
      stderrBuffer += text;
      stderrBuffer = flushLines(stderrBuffer, onStderrLine);
    });

    child.on("error", (error) => {
      const wrapped = error as Error & { stdout?: string; stderr?: string };
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      reject(wrapped);
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        onStdoutLine(stdoutBuffer.replace(/\r$/, ""));
      }
      if (stderrBuffer.trim()) {
        onStderrLine(stderrBuffer.replace(/\r$/, ""));
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Process exited with code ${code ?? "unknown"}`) as Error & {
        stdout?: string;
        stderr?: string;
      };
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function execCommand(command: string, args: string[], cwd: string): Promise<void> {
  await execCommandCapture(command, args, cwd);
}

async function execCommandCapture(command: string, args: string[], cwd: string): Promise<CommandResult> {
  if (process.platform === "win32" && isCmdScript(command)) {
    const powershell = await resolvePowerShellExecutable();
    const script = buildPowerShellInvocation(command, args);
    const result = await execFile(
      powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { cwd }
    );
    return {
      stdout: asText(result.stdout),
      stderr: asText(result.stderr)
    };
  }

  const result = await execFile(command, args, { cwd });
  return {
    stdout: asText(result.stdout),
    stderr: asText(result.stderr)
  };
}

async function resolvePowerShellExecutable(): Promise<string> {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = [
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe"
  ];

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith(".exe")) {
      if (await pathExists(candidate)) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }

  return "powershell.exe";
}

function isCmdScript(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function buildPowerShellInvocation(command: string, args: string[]): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const joinedArgs = args.map((arg) => quote(arg)).join(" ");
  return `& ${quote(command)} ${joinedArgs}`.trim();
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildTerminalCommand(command: string, args: string[]): string {
  if (process.platform === "win32") {
    if (command.includes("\\") || command.includes("/") || command.includes(" ")) {
      const escaped = command.replace(/'/g, "''");
      return `& '${escaped}' ${args.join(" ")}`.trim();
    }
    return [command, ...args].join(" ");
  }

  const quoted = command.includes("/") || command.includes(" ")
    ? quoteForPosixShell(command)
    : command;
  return [quoted, ...args.map((arg) => quoteForPosixShell(arg))].join(" ");
}

function asText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function getNpmCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push("npm.cmd", "npm");

    candidates.push(
      "C:\\Program Files\\nodejs\\npm.cmd",
      "C:\\Program Files (x86)\\nodejs\\npm.cmd"
    );

    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      candidates.push(path.join(programFiles, "nodejs", "npm.cmd"));
    }

    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      candidates.push(path.join(programFilesX86, "nodejs", "npm.cmd"));
    }

    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(path.join(appData, "npm", "npm.cmd"));
    }
  } else {
    candidates.push("npm", "/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm");
  }

  return Array.from(new Set(candidates));
}

function isCommandNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  const msg = typeof message === "string" ? message.toLowerCase() : "";
  return (
    code === "ENOENT" ||
    msg.includes("not recognized as an internal or external command") ||
    msg.includes("command not found")
  );
}

function getLocalCodexCliPath(runtimeDir: string): string {
  const exeName = process.platform === "win32" ? "codex.cmd" : "codex";
  return path.join(runtimeDir, "node_modules", ".bin", exeName);
}

async function isUsableCodexCli(commandPath: string, cwd: string): Promise<boolean> {
  const isExplicitPath = commandPath.includes(path.sep) || path.isAbsolute(commandPath);
  try {
    if (isExplicitPath) {
      await fs.access(commandPath);
    }
    await execCommand(commandPath, ["--version"], cwd);
    return true;
  } catch {
    if (!isExplicitPath) {
      return false;
    }
    // Fallback: if the wrapper command fails, check package presence to avoid false negatives.
    const runtimeDir = path.dirname(path.dirname(path.dirname(commandPath)));
    const packagePath = path.join(runtimeDir, "node_modules", "@openai", "codex", "package.json");
    return pathExists(packagePath);
  }
}

async function setCodexSettings(workspaceRoot: string, runtimeDir: string, summary: string[]): Promise<void> {
  const settingsPath = path.join(workspaceRoot, ".vscode", "settings.json");
  if (!(await pathExists(settingsPath))) {
    summary.push("Could not set Codex settings (.vscode/settings.json missing)");
    return;
  }

  const localCodexPath = getLocalCodexCliPath(runtimeDir);
  const codexPathRelative = path
    .relative(workspaceRoot, localCodexPath)
    .split(path.sep)
    .join("/");

  const raw = await fs.readFile(settingsPath, "utf8");
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    summary.push("Could not set Codex settings (invalid JSON in .vscode/settings.json)");
    return;
  }

  let changed = false;
  if (settings["burbage.codexCliPath"] !== codexPathRelative) {
    settings["burbage.codexCliPath"] = codexPathRelative;
    changed = true;
  }
  if (settings["burbage.codexCliMode"] !== "local") {
    settings["burbage.codexCliMode"] = "local";
    changed = true;
  }

  if (!changed) {
    summary.push("Codex runtime settings already configured");
    return;
  }

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  summary.push("Configured workspace to use local Codex CLI");
}

async function copyTemplateWithPolicy(options: {
  templatePath: string;
  destinationPath: string;
  summary: string[];
  existingPolicy: "skip" | "replace";
  workspaceRoot: string;
}): Promise<void> {
  const { templatePath, destinationPath, summary, existingPolicy, workspaceRoot } = options;

  if (!(await pathExists(templatePath))) {
    summary.push(`Template missing: ${path.basename(templatePath)}`);
    return;
  }

  const templateContent = await fs.readFile(templatePath, "utf8");

  if (!(await pathExists(destinationPath))) {
    await fs.writeFile(destinationPath, templateContent, "utf8");
    summary.push(`Created ${relativeToWorkspace(destinationPath, workspaceRoot)} from template`);
    return;
  }

  if (existingPolicy === "skip") {
    summary.push(`Skipped existing ${relativeToWorkspace(destinationPath, workspaceRoot)}`);
    return;
  }

  await fs.writeFile(destinationPath, templateContent, "utf8");
  summary.push(`Replaced ${relativeToWorkspace(destinationPath, workspaceRoot)} from template`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asOptionalString(item))
    .filter((item): item is string => typeof item === "string");
}

function normalizeDocumentReference(reference: string): string | undefined {
  const normalized = reference
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .replace(/^Manuscript\//i, "");
  return normalized || undefined;
}

async function listManuscriptDocuments(manuscriptDirPath: string): Promise<string[]> {
  if (!(await pathExists(manuscriptDirPath))) {
    return [];
  }

  const documents: string[] = [];
  await collectManuscriptDocumentsRecursively(manuscriptDirPath, manuscriptDirPath, documents);
  documents.sort((a, b) => a.localeCompare(b));
  return documents;
}

async function collectManuscriptDocumentsRecursively(
  currentDirPath: string,
  rootDirPath: string,
  output: string[]
): Promise<void> {
  const entries = await fs.readdir(currentDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDirPath, entry.name);
    if (entry.isDirectory()) {
      await collectManuscriptDocumentsRecursively(entryPath, rootDirPath, output);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const relativePath = path.relative(rootDirPath, entryPath).split(path.sep).join("/");
    const normalized = normalizeDocumentReference(relativePath);
    if (normalized) {
      output.push(normalized);
    }
  }
}

function toUniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function getConnectedEventStats(
  connectedEventIndices: ReadonlySet<number> | undefined,
  eventCount: number
): { span: number; count: number; meanIndex: number } {
  if (!connectedEventIndices || connectedEventIndices.size === 0) {
    return {
      span: 0,
      count: 0,
      meanIndex: eventCount > 1 ? (eventCount - 1) / 2 : 0
    };
  }

  const sorted = Array.from(connectedEventIndices).sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const meanIndex = sorted.reduce((sum, item) => sum + item, 0) / sorted.length;

  return {
    span: Math.max(0, last - first),
    count: sorted.length,
    meanIndex
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function relativeToWorkspace(targetPath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, targetPath);
  if (!relative) {
    return ".";
  }
  if (relative.startsWith("..")) {
    return path.basename(targetPath);
  }
  return relative;
}
