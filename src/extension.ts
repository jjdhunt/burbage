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
const DASHBOARD_COLOR_SCHEME = {
  categoricalPalette: [
    "#4e79a7",
    "#f28e2b",
    "#e15759",
    "#76b7b2",
    "#59a14f",
    "#edc948",
    "#b07aa1",
    "#ff9da7",
    "#9c755f",
    "#bab0ab",
    "#8dd3c7",
    "#ffffb3",
    "#bebada",
    "#fb8072",
    "#80b1d3",
    "#fdb462",
    "#b3de69",
    "#fccde5",
    "#d9d9d9",
    "#bc80bd",
    "#ccebc5",
    "#ffed6f"
  ],
  relationship: {
    link: "#7a7a7a"
  },
  timeline: {
    eventNode: "#d7a12f",
    locationNode: "#10b981",
    documentNode: "#5d92c9",
    backbone: "#7b7b7b",
    partyLink: "#7a7a7a",
    mentionLink: "#6f85a1"
  },
  location: {
    regionLink: "#9b8c57",
    adjacentLink: "#6f85a1"
  },
  causal: {
    fallbackChain: "#86a5c5"
  }
} as const;

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
    }),
    vscode.commands.registerCommand("burbage.openLocationsHierarchyDashboard", async () => {
      await openLocationsHierarchyDashboard(context);
    }),
    vscode.commands.registerCommand("burbage.openGeographyDashboard", async () => {
      await openGeographyDashboard(context);
    }),
    vscode.commands.registerCommand("burbage.openCausalDiagramDashboard", async () => {
      await openCausalDiagramDashboard(context);
    }),
    vscode.commands.registerCommand("burbage.openVonnegutDashboard", async () => {
      await openVonnegutDashboard(context);
    }),
    vscode.commands.registerCommand("burbage.openPacingDashboard", async () => {
      await openPacingDashboard(context);
    }),
    vscode.commands.registerCommand("burbage.openPlotGridDashboard", async () => {
      await openPlotGridDashboard(context);
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
  graph: RelationshipGraphData;
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
  documentIndex?: number;
  characterType?: string;
  bio?: string;
  date?: string;
  summary?: string;
  causes?: string[];
  explaination?: string;
};

type TimelineGraphLink = {
  id: string;
  source: string;
  target: string;
  linkKind: "party" | "location" | "mention" | "documentParty" | "documentLocation";
};

type TimelineGraphData = {
  nodes: TimelineGraphNode[];
  links: TimelineGraphLink[];
  sourceLabel: string;
};

type LocationGraphNode = {
  id: string;
  name: string;
  region?: string;
  regionGroup: string;
  adjacent: string[];
  mentions: string[];
  description: string;
};

type LocationGraphLink = {
  id: string;
  source: string;
  target: string;
  linkKind: "region" | "adjacent";
};

type LocationGraphData = {
  nodes: LocationGraphNode[];
  links: LocationGraphLink[];
  sourceLabel: string;
};

type CausalEventNode = {
  id: string;
  name: string;
  mentions: string[];
  date: string;
  summary: string;
  explaination: string;
  valence?: number;
  causes: string[];
};

type CausalEventLink = {
  id: string;
  source: string;
  target: string;
};

type CausalGraphData = {
  nodes: CausalEventNode[];
  links: CausalEventLink[];
  sourceLabel: string;
};

type LocationDashboardMode = "hierarchy" | "geography";
type TimelineDashboardMode = "event" | "document";
type VonnegutDashboardMode = "event" | "document";

type TimelineDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  graph: TimelineGraphData;
  mode: TimelineDashboardMode;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

type LocationDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  graph: LocationGraphData;
  mode: LocationDashboardMode;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

type CausalDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  graph: CausalGraphData;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

type VonnegutEventPoint = {
  id: string;
  name: string;
  orderIndex: number;
  valence?: number;
  date: string;
  summary: string;
  mentions: string[];
};

type VonnegutDocumentPoint = {
  id: string;
  name: string;
  orderIndex: number;
  documentIndex?: number;
  valence?: number;
  eventCount: number;
  summary: string;
};

type VonnegutGraphData = {
  events: VonnegutEventPoint[];
  documents: VonnegutDocumentPoint[];
  smoothingWindow: number;
  sourceLabel: string;
};

type VonnegutDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  graph: VonnegutGraphData;
  mode: VonnegutDashboardMode;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

type PacingDocumentPoint = {
  id: string;
  name: string;
  orderIndex: number;
  documentIndex?: number;
  eventCount: number;
  summary: string;
};

type PacingGraphData = {
  documents: PacingDocumentPoint[];
  smoothingWindow: number;
  sourceLabel: string;
};

type PacingDashboardState = {
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  graph: PacingGraphData;
  watchers: vscode.FileSystemWatcher[];
  refreshTimer?: NodeJS.Timeout;
};

type DashboardHtmlOptions = {
  includeSaveButton?: boolean;
  standaloneDarkMode?: boolean;
};

let relationshipDashboardState: RelationshipDashboardState | undefined;
let causalDashboardState: CausalDashboardState | undefined;
let timelineDashboardState: TimelineDashboardState | undefined;
let vonnegutDashboardState: VonnegutDashboardState | undefined;
let pacingDashboardState: PacingDashboardState | undefined;
const locationDashboardStates: Record<LocationDashboardMode, LocationDashboardState | undefined> = {
  hierarchy: undefined,
  geography: undefined
};

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
      graph,
      watchers: []
    };
    relationshipDashboardState = state;

    panel.webview.html = getRelationshipDashboardHtml(graph);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSaveDashboardMessage(message)) {
        return;
      }
      await saveRelationshipDashboardSnapshot(state);
    });
    context.subscriptions.push(messageDisposable);

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
    state.graph = graph;
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

function getRelationshipDashboardHtml(graph: RelationshipGraphData, options: DashboardHtmlOptions = {}): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const dashboardColorsJson = JSON.stringify(DASHBOARD_COLOR_SCHEME).replace(/</g, "\\u003c");
  const includeSaveButton = options.includeSaveButton ?? true;
  const standaloneDarkMode = options.standaloneDarkMode ?? false;
  const rootCssVars = standaloneDarkMode
    ? `color-scheme: dark;
      --dashboard-bg: #0f1318;
      --dashboard-fg: #e7edf3;
      --dashboard-border: #2a3340;
      --dashboard-widget-bg: #181f28;
      --dashboard-description: #9aa7b8;
      --dashboard-tooltip-bg: rgba(21, 28, 36, 0.95);
      --dashboard-tooltip-fg: #f3f6fb;
      --dashboard-font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;`
    : `color-scheme: light dark;
      --dashboard-bg: var(--vscode-editor-background);
      --dashboard-fg: var(--vscode-editor-foreground);
      --dashboard-border: var(--vscode-panel-border);
      --dashboard-widget-bg: var(--vscode-editorWidget-background);
      --dashboard-description: var(--vscode-descriptionForeground);
      --dashboard-tooltip-bg: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      --dashboard-tooltip-fg: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      --dashboard-font-family: var(--vscode-font-family, "Segoe UI", "Noto Sans", Arial, sans-serif);`;
  const saveButtonHtml = includeSaveButton ? '<button id="save-dashboard" class="save-button" type="button">Save</button>' : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      ${rootCssVars}
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--dashboard-bg);
      color: var(--dashboard-fg);
      font-family: var(--dashboard-font-family);
      overflow: hidden;
    }
    .root {
      width: 100%;
      height: 100%;
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-tooltip-bg);
      color: var(--dashboard-tooltip-fg);
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(40vw, 380px);
      max-height: 45vh;
      overflow: auto;
    }
    .legend-title {
      margin: 0 0 6px 0;
      color: var(--dashboard-description);
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
    .save-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 120;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
  </style>
</head>
<body>
  ${saveButtonHtml}
  <div class="root">
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const dashboardColors = ${dashboardColorsJson};
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const saveButton = document.getElementById('save-dashboard');
    if (saveButton && vscodeApi) {
      saveButton.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveDashboard' });
      });
    }
    if (saveButton && !vscodeApi) {
      saveButton.style.display = 'none';
    }
    let width = 0;
    let height = 0;
    let dragging = false;

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(300, rect.width);
      height = Math.max(300, rect.height);
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
    const palette = dashboardColors.categoricalPalette;
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

    function formatCauses(causes) {
      if (!Array.isArray(causes) || causes.length === 0) {
        return '(none)';
      }
      return causes.join(', ');
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
    const linkLayer = container.append('g').attr('stroke', dashboardColors.relationship.link).attr('stroke-opacity', 0.7);
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
      .attr('fill', 'var(--dashboard-fg)')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const simulation = d3.forceSimulation(graph.nodes)
      .alphaDecay(0.0023)
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

function getTimelineDashboardMeta(mode: TimelineDashboardMode): {
  modeTitle: string;
  saveFileName: string;
} {
  if (mode === "document") {
    return {
      modeTitle: "Document Timeline",
      saveFileName: "document-timeline-dashboard.html"
    };
  }
  return {
    modeTitle: "Event Timeline",
    saveFileName: "event-timeline-dashboard.html"
  };
}

async function openTimelineDashboard(context: vscode.ExtensionContext): Promise<void> {
  await openTimelineDashboardByMode(context, "document");
}

async function openTimelineDashboardByMode(
  context: vscode.ExtensionContext,
  mode: TimelineDashboardMode
): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the timeline dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (timelineDashboardState && timelineDashboardState.workspaceRoot === workspaceRoot) {
      timelineDashboardState.panel.reveal(vscode.ViewColumn.One, true);
      if (timelineDashboardState.mode !== mode) {
        timelineDashboardState.mode = mode;
        await timelineDashboardState.panel.webview.postMessage({ type: "setTimelineMode", mode });
      }
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
      graph,
      mode,
      watchers: []
    };
    timelineDashboardState = state;

    panel.webview.html = getTimelineDashboardHtml(graph, mode);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isSaveDashboardMessage(message)) {
        await saveTimelineDashboardSnapshot(state);
        return;
      }
      if (isTimelineModeChangedMessage(message)) {
        state.mode = message.mode;
      }
    });
    context.subscriptions.push(messageDisposable);

    for (const relativePath of [
      "Entities/characters.yaml",
      "Entities/locations.yaml",
      "Entities/events.yaml",
      "Entities/documents.yaml",
      "Manuscript/**"
    ]) {
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
    state.graph = graph;
    state.panel.webview.html = getTimelineDashboardHtml(graph, state.mode);
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

function getVonnegutDashboardMeta(mode: VonnegutDashboardMode): {
  modeTitle: string;
  saveFileName: string;
} {
  if (mode === "document") {
    return {
      modeTitle: "Document Vonnegut Diagram",
      saveFileName: "vonnegut-document-diagram.html"
    };
  }
  return {
    modeTitle: "Event Vonnegut Diagram",
    saveFileName: "vonnegut-event-diagram.html"
  };
}

async function openVonnegutDashboard(context: vscode.ExtensionContext): Promise<void> {
  await openVonnegutDashboardByMode(context, "document");
}

async function openVonnegutDashboardByMode(
  context: vscode.ExtensionContext,
  mode: VonnegutDashboardMode
): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the Vonnegut diagram dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (vonnegutDashboardState && vonnegutDashboardState.workspaceRoot === workspaceRoot) {
      vonnegutDashboardState.panel.reveal(vscode.ViewColumn.One, true);
      if (vonnegutDashboardState.mode !== mode) {
        vonnegutDashboardState.mode = mode;
        await vonnegutDashboardState.panel.webview.postMessage({ type: "setVonnegutMode", mode });
      }
      return;
    }

    if (vonnegutDashboardState) {
      disposeVonnegutDashboardState(vonnegutDashboardState);
      vonnegutDashboardState = undefined;
    }

    const graph = await loadVonnegutGraph(workspaceRoot);

    const panel = vscode.window.createWebviewPanel(
      "burbage.vonnegutDashboard",
      "Burbage: Vonnegut Diagram",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state: VonnegutDashboardState = {
      panel,
      workspaceRoot,
      graph,
      mode,
      watchers: []
    };
    vonnegutDashboardState = state;

    panel.webview.html = getVonnegutDashboardHtml(graph, mode);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isSaveDashboardMessage(message)) {
        await saveVonnegutDashboardSnapshot(state);
        return;
      }
      if (isVonnegutModeChangedMessage(message)) {
        state.mode = message.mode;
      }
    });
    context.subscriptions.push(messageDisposable);

    for (const relativePath of ["Entities/events.yaml", "Entities/documents.yaml", "Manuscript/**"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, relativePath));
      const schedule = () => scheduleVonnegutDashboardRefresh(state);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      state.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    panel.onDidDispose(() => {
      if (vonnegutDashboardState === state) {
        vonnegutDashboardState = undefined;
      }
      disposeVonnegutDashboardState(state);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open Vonnegut diagram dashboard: ${message}`);
  }
}

function scheduleVonnegutDashboardRefresh(state: VonnegutDashboardState): void {
  if (vonnegutDashboardState !== state) {
    return;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshVonnegutDashboard(state, false);
  }, 180);
}

async function refreshVonnegutDashboard(state: VonnegutDashboardState, showErrorToUser: boolean): Promise<void> {
  if (vonnegutDashboardState !== state) {
    return;
  }
  try {
    const graph = await loadVonnegutGraph(state.workspaceRoot);
    state.graph = graph;
    state.panel.webview.html = getVonnegutDashboardHtml(graph, state.mode);
  } catch (error) {
    if (!showErrorToUser) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not refresh Vonnegut diagram dashboard: ${message}`);
  }
}

function disposeVonnegutDashboardState(state: VonnegutDashboardState): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  for (const watcher of state.watchers) {
    watcher.dispose();
  }
  state.watchers = [];
}

async function openPacingDashboard(context: vscode.ExtensionContext): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the pacing dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (pacingDashboardState && pacingDashboardState.workspaceRoot === workspaceRoot) {
      pacingDashboardState.panel.reveal(vscode.ViewColumn.One, true);
      await refreshPacingDashboard(pacingDashboardState, true);
      return;
    }

    if (pacingDashboardState) {
      disposePacingDashboardState(pacingDashboardState);
      pacingDashboardState = undefined;
    }

    const graph = await loadPacingGraph(workspaceRoot);
    const panel = vscode.window.createWebviewPanel(
      "burbage.pacingDashboard",
      "Burbage: Pacing Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state: PacingDashboardState = {
      panel,
      workspaceRoot,
      graph,
      watchers: []
    };
    pacingDashboardState = state;

    panel.webview.html = getPacingDashboardHtml(graph);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSaveDashboardMessage(message)) {
        return;
      }
      await savePacingDashboardSnapshot(state);
    });
    context.subscriptions.push(messageDisposable);

    for (const relativePath of ["Entities/events.yaml", "Entities/documents.yaml", "Manuscript/**"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, relativePath));
      const schedule = () => schedulePacingDashboardRefresh(state);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      state.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    panel.onDidDispose(() => {
      if (pacingDashboardState === state) {
        pacingDashboardState = undefined;
      }
      disposePacingDashboardState(state);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open pacing dashboard: ${message}`);
  }
}

function schedulePacingDashboardRefresh(state: PacingDashboardState): void {
  if (pacingDashboardState !== state) {
    return;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshPacingDashboard(state, false);
  }, 180);
}

async function refreshPacingDashboard(state: PacingDashboardState, showErrorToUser: boolean): Promise<void> {
  if (pacingDashboardState !== state) {
    return;
  }
  try {
    const graph = await loadPacingGraph(state.workspaceRoot);
    state.graph = graph;
    state.panel.webview.html = getPacingDashboardHtml(graph);
  } catch (error) {
    if (!showErrorToUser) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not refresh pacing dashboard: ${message}`);
  }
}

function disposePacingDashboardState(state: PacingDashboardState): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  for (const watcher of state.watchers) {
    watcher.dispose();
  }
  state.watchers = [];
}

async function openPlotGridDashboard(_context: vscode.ExtensionContext): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the plot grid dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const output = await generatePlotGridCsvs(workspaceRoot);
    const eventPathLabel = relativeToWorkspace(output.eventCsvPath, workspaceRoot);
    const documentPathLabel = relativeToWorkspace(output.documentCsvPath, workspaceRoot);
    vscode.window.showInformationMessage(`Saved plot grid CSVs: ${eventPathLabel}, ${documentPathLabel}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not generate plot grid dashboard CSVs: ${message}`);
  }
}

async function openCausalDiagramDashboard(context: vscode.ExtensionContext): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("Open a folder/workspace before opening the causal diagram dashboard.");
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (causalDashboardState && causalDashboardState.workspaceRoot === workspaceRoot) {
      causalDashboardState.panel.reveal(vscode.ViewColumn.One, true);
      await refreshCausalDashboard(causalDashboardState, true);
      return;
    }

    if (causalDashboardState) {
      disposeCausalDashboardState(causalDashboardState);
      causalDashboardState = undefined;
    }

    const graph = await loadCausalGraph(workspaceRoot);

    const panel = vscode.window.createWebviewPanel(
      "burbage.causalDiagramDashboard",
      "Burbage: Causal Diagram Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state: CausalDashboardState = {
      panel,
      workspaceRoot,
      graph,
      watchers: []
    };
    causalDashboardState = state;

    panel.webview.html = getCausalDashboardHtml(graph);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSaveDashboardMessage(message)) {
        return;
      }
      await saveCausalDashboardSnapshot(state);
    });
    context.subscriptions.push(messageDisposable);

    for (const relativePath of ["Entities/events.yaml"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, relativePath));
      const schedule = () => scheduleCausalDashboardRefresh(state);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      state.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    panel.onDidDispose(() => {
      if (causalDashboardState === state) {
        causalDashboardState = undefined;
      }
      disposeCausalDashboardState(state);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open causal diagram dashboard: ${message}`);
  }
}

function scheduleCausalDashboardRefresh(state: CausalDashboardState): void {
  if (causalDashboardState !== state) {
    return;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshCausalDashboard(state, false);
  }, 180);
}

async function refreshCausalDashboard(state: CausalDashboardState, showErrorToUser: boolean): Promise<void> {
  if (causalDashboardState !== state) {
    return;
  }
  try {
    const graph = await loadCausalGraph(state.workspaceRoot);
    state.graph = graph;
    state.panel.webview.html = getCausalDashboardHtml(graph);
  } catch (error) {
    if (!showErrorToUser) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not refresh causal diagram dashboard: ${message}`);
  }
}

function disposeCausalDashboardState(state: CausalDashboardState): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  for (const watcher of state.watchers) {
    watcher.dispose();
  }
  state.watchers = [];
}

async function openLocationsHierarchyDashboard(context: vscode.ExtensionContext): Promise<void> {
  await openLocationsDashboard(context, "hierarchy");
}

async function openGeographyDashboard(context: vscode.ExtensionContext): Promise<void> {
  await openLocationsDashboard(context, "geography");
}

function getLocationDashboardMeta(mode: LocationDashboardMode): {
  panelId: string;
  panelTitle: string;
  saveFileName: string;
  modeTitle: string;
} {
  if (mode === "hierarchy") {
    return {
      panelId: "burbage.locationsHierarchyDashboard",
      panelTitle: "Burbage: Locations Hierarchy Dashboard",
      saveFileName: "locations-hierarchy-dashboard.html",
      modeTitle: "Locations Hierarchy"
    };
  }
  return {
    panelId: "burbage.geographyDashboard",
    panelTitle: "Burbage: Geography Dashboard",
    saveFileName: "geography-dashboard.html",
    modeTitle: "Geography Dashboard"
  };
}

async function openLocationsDashboard(context: vscode.ExtensionContext, mode: LocationDashboardMode): Promise<void> {
  const dashboardMeta = getLocationDashboardMeta(mode);
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(`Open a folder/workspace before opening ${dashboardMeta.modeTitle.toLowerCase()}.`);
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const currentState = locationDashboardStates[mode];

    if (currentState && currentState.workspaceRoot === workspaceRoot) {
      currentState.panel.reveal(vscode.ViewColumn.One, true);
      await refreshLocationsDashboard(currentState, true);
      return;
    }

    if (currentState) {
      disposeLocationsDashboardState(currentState);
      locationDashboardStates[mode] = undefined;
    }

    const graph = await loadLocationGraph(workspaceRoot, mode);

    const panel = vscode.window.createWebviewPanel(dashboardMeta.panelId, dashboardMeta.panelTitle, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true
    });

    const state: LocationDashboardState = {
      panel,
      workspaceRoot,
      graph,
      mode,
      watchers: []
    };
    locationDashboardStates[mode] = state;

    panel.webview.html = getLocationsDashboardHtml(graph, mode);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSaveDashboardMessage(message)) {
        return;
      }
      await saveLocationsDashboardSnapshot(state);
    });
    context.subscriptions.push(messageDisposable);

    const relativePaths = mode === "hierarchy"
      ? ["Entities/locations.yaml"]
      : ["Entities/locations.yaml", "Entities/geography.yaml"];
    for (const relativePath of relativePaths) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, relativePath));
      const schedule = () => scheduleLocationsDashboardRefresh(state);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      state.watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    panel.onDidDispose(() => {
      if (locationDashboardStates[mode] === state) {
        locationDashboardStates[mode] = undefined;
      }
      disposeLocationsDashboardState(state);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open ${dashboardMeta.modeTitle.toLowerCase()}: ${message}`);
  }
}

function scheduleLocationsDashboardRefresh(state: LocationDashboardState): void {
  if (locationDashboardStates[state.mode] !== state) {
    return;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshLocationsDashboard(state, false);
  }, 180);
}

async function refreshLocationsDashboard(state: LocationDashboardState, showErrorToUser: boolean): Promise<void> {
  if (locationDashboardStates[state.mode] !== state) {
    return;
  }
  try {
    const graph = await loadLocationGraph(state.workspaceRoot, state.mode);
    state.graph = graph;
    state.panel.webview.html = getLocationsDashboardHtml(graph, state.mode);
  } catch (error) {
    if (!showErrorToUser) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const dashboardMeta = getLocationDashboardMeta(state.mode);
    vscode.window.showErrorMessage(`Could not refresh ${dashboardMeta.modeTitle.toLowerCase()}: ${message}`);
  }
}

function disposeLocationsDashboardState(state: LocationDashboardState): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  for (const watcher of state.watchers) {
    watcher.dispose();
  }
  state.watchers = [];
}

async function saveRelationshipDashboardSnapshot(state: RelationshipDashboardState): Promise<void> {
  try {
    const html = getRelationshipDashboardHtml(state.graph, {
      includeSaveButton: false,
      standaloneDarkMode: true
    });
    const outputPath = await writeDashboardSnapshotFile(state.workspaceRoot, "relationship-dashboard.html", html);
    vscode.window.showInformationMessage(`Saved relationship dashboard to ${relativeToWorkspace(outputPath, state.workspaceRoot)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not save relationship dashboard: ${message}`);
  }
}

async function saveTimelineDashboardSnapshot(state: TimelineDashboardState): Promise<void> {
  try {
    const dashboardMeta = getTimelineDashboardMeta(state.mode);
    const html = getTimelineDashboardHtml(state.graph, state.mode, {
      includeSaveButton: false,
      standaloneDarkMode: true
    });
    const outputPath = await writeDashboardSnapshotFile(state.workspaceRoot, dashboardMeta.saveFileName, html);
    vscode.window.showInformationMessage(`Saved ${dashboardMeta.modeTitle.toLowerCase()} to ${relativeToWorkspace(outputPath, state.workspaceRoot)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dashboardMeta = getTimelineDashboardMeta(state.mode);
    vscode.window.showErrorMessage(`Could not save ${dashboardMeta.modeTitle.toLowerCase()}: ${message}`);
  }
}

async function saveCausalDashboardSnapshot(state: CausalDashboardState): Promise<void> {
  try {
    const html = getCausalDashboardHtml(state.graph, {
      includeSaveButton: false,
      standaloneDarkMode: true
    });
    const outputPath = await writeDashboardSnapshotFile(state.workspaceRoot, "causal-diagram-dashboard.html", html);
    vscode.window.showInformationMessage(`Saved causal diagram dashboard to ${relativeToWorkspace(outputPath, state.workspaceRoot)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not save causal diagram dashboard: ${message}`);
  }
}

async function saveLocationsDashboardSnapshot(state: LocationDashboardState): Promise<void> {
  try {
    const dashboardMeta = getLocationDashboardMeta(state.mode);
    const html = getLocationsDashboardHtml(state.graph, state.mode, {
      includeSaveButton: false,
      standaloneDarkMode: true
    });
    const outputPath = await writeDashboardSnapshotFile(state.workspaceRoot, dashboardMeta.saveFileName, html);
    vscode.window.showInformationMessage(`Saved ${dashboardMeta.modeTitle.toLowerCase()} to ${relativeToWorkspace(outputPath, state.workspaceRoot)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dashboardMeta = getLocationDashboardMeta(state.mode);
    vscode.window.showErrorMessage(`Could not save ${dashboardMeta.modeTitle.toLowerCase()}: ${message}`);
  }
}

async function saveVonnegutDashboardSnapshot(state: VonnegutDashboardState): Promise<void> {
  try {
    const dashboardMeta = getVonnegutDashboardMeta(state.mode);
    const html = getVonnegutDashboardHtml(state.graph, state.mode, {
      includeSaveButton: false,
      standaloneDarkMode: true
    });
    const outputPath = await writeDashboardSnapshotFile(state.workspaceRoot, dashboardMeta.saveFileName, html);
    vscode.window.showInformationMessage(`Saved ${dashboardMeta.modeTitle.toLowerCase()} to ${relativeToWorkspace(outputPath, state.workspaceRoot)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dashboardMeta = getVonnegutDashboardMeta(state.mode);
    vscode.window.showErrorMessage(`Could not save ${dashboardMeta.modeTitle.toLowerCase()}: ${message}`);
  }
}

async function savePacingDashboardSnapshot(state: PacingDashboardState): Promise<void> {
  try {
    const html = getPacingDashboardHtml(state.graph, {
      includeSaveButton: false,
      standaloneDarkMode: true
    });
    const outputPath = await writeDashboardSnapshotFile(state.workspaceRoot, "pacing-dashboard.html", html);
    vscode.window.showInformationMessage(`Saved pacing dashboard to ${relativeToWorkspace(outputPath, state.workspaceRoot)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not save pacing dashboard: ${message}`);
  }
}

async function writeDashboardSnapshotFile(workspaceRoot: string, fileName: string, html: string): Promise<string> {
  const dashboardsDirPath = path.join(workspaceRoot, "dashboards");
  await fs.mkdir(dashboardsDirPath, { recursive: true });

  const outputPath = path.join(dashboardsDirPath, fileName);
  await fs.writeFile(outputPath, html, "utf8");
  return outputPath;
}

async function loadCausalGraph(workspaceRoot: string): Promise<CausalGraphData> {
  const entitiesDirPath = path.join(workspaceRoot, "Entities");
  const eventsPath = path.join(entitiesDirPath, "events.yaml");
  if (!(await pathExists(eventsPath))) {
    throw new Error("Missing events.yaml in Entities/. Run Burbage setup if needed.");
  }

  const eventsRaw = await fs.readFile(eventsPath, "utf8");
  return buildCausalGraph(parseYaml(eventsRaw), "Entities/");
}

async function loadVonnegutGraph(workspaceRoot: string): Promise<VonnegutGraphData> {
  const sources = await resolveVonnegutDataSources(workspaceRoot);
  const eventsPath = path.join(sources.entitiesDirPath, "events.yaml");
  const documentsPath = path.join(sources.entitiesDirPath, "documents.yaml");
  const [eventsRaw, documentsRaw, manuscriptDocuments] = await Promise.all([
    fs.readFile(eventsPath, "utf8"),
    pathExists(documentsPath).then((exists) => (exists ? fs.readFile(documentsPath, "utf8") : "{}\n")),
    listManuscriptDocuments(sources.manuscriptDirPath)
  ]);
  return buildVonnegutGraph(
    parseYaml(eventsRaw),
    parseYaml(documentsRaw),
    manuscriptDocuments,
    sources.sourceLabel
  );
}

async function loadPacingGraph(workspaceRoot: string): Promise<PacingGraphData> {
  const sources = await resolveVonnegutDataSources(workspaceRoot);
  const eventsPath = path.join(sources.entitiesDirPath, "events.yaml");
  const documentsPath = path.join(sources.entitiesDirPath, "documents.yaml");
  const [eventsRaw, documentsRaw, manuscriptDocuments] = await Promise.all([
    fs.readFile(eventsPath, "utf8"),
    pathExists(documentsPath).then((exists) => (exists ? fs.readFile(documentsPath, "utf8") : "{}\n")),
    listManuscriptDocuments(sources.manuscriptDirPath)
  ]);
  return buildPacingGraph(
    parseYaml(eventsRaw),
    parseYaml(documentsRaw),
    manuscriptDocuments,
    sources.sourceLabel
  );
}

async function generatePlotGridCsvs(workspaceRoot: string): Promise<{ eventCsvPath: string; documentCsvPath: string }> {
  const sources = await resolveTimelineDataSources(workspaceRoot);
  const eventsPath = path.join(sources.entitiesDirPath, "events.yaml");
  const charactersPath = path.join(sources.entitiesDirPath, "characters.yaml");
  const documentsPath = path.join(sources.entitiesDirPath, "documents.yaml");
  const [eventsRaw, charactersRaw, documentsRaw, manuscriptDocuments] = await Promise.all([
    fs.readFile(eventsPath, "utf8"),
    fs.readFile(charactersPath, "utf8"),
    pathExists(documentsPath).then((exists) => (exists ? fs.readFile(documentsPath, "utf8") : "{}\n")),
    listManuscriptDocuments(sources.manuscriptDirPath)
  ]);

  const csvOutputs = buildPlotGridCsvOutputs(
    parseYaml(eventsRaw),
    parseYaml(charactersRaw),
    parseYaml(documentsRaw),
    manuscriptDocuments
  );

  const eventCsvPath = await writeDashboardSnapshotFile(workspaceRoot, "plot-grid-events.csv", csvOutputs.eventCsv);
  const documentCsvPath = await writeDashboardSnapshotFile(workspaceRoot, "plot-grid-documents.csv", csvOutputs.documentCsv);
  return { eventCsvPath, documentCsvPath };
}

async function loadLocationGraph(workspaceRoot: string, mode: LocationDashboardMode): Promise<LocationGraphData> {
  const entitiesDirPath = path.join(workspaceRoot, "Entities");
  const locationsPath = path.join(entitiesDirPath, "locations.yaml");
  const geographyPath = path.join(entitiesDirPath, "geography.yaml");
  if (!(await pathExists(locationsPath))) {
    throw new Error("Missing locations.yaml in Entities/. Run Burbage setup if needed.");
  }
  if (mode === "geography" && !(await pathExists(geographyPath))) {
    throw new Error("Missing geography.yaml in Entities/. Run Burbage setup if needed.");
  }

  const [locationsRaw, geographyRaw] = await Promise.all([
    fs.readFile(locationsPath, "utf8"),
    pathExists(geographyPath).then((exists) => (exists ? fs.readFile(geographyPath, "utf8") : "{}\n"))
  ]);
  return buildLocationGraph(parseYaml(locationsRaw), parseYaml(geographyRaw), "Entities/", mode);
}

async function loadTimelineGraph(workspaceRoot: string): Promise<TimelineGraphData> {
  const sources = await resolveTimelineDataSources(workspaceRoot);
  const eventsPath = path.join(sources.entitiesDirPath, "events.yaml");
  const charactersPath = path.join(sources.entitiesDirPath, "characters.yaml");
  const locationsPath = path.join(sources.entitiesDirPath, "locations.yaml");
  const documentsPath = path.join(sources.entitiesDirPath, "documents.yaml");
  const [eventsRaw, charactersRaw, locationsRaw, documentsRaw, manuscriptDocuments] = await Promise.all([
    fs.readFile(eventsPath, "utf8"),
    fs.readFile(charactersPath, "utf8"),
    pathExists(locationsPath).then((exists) => (exists ? fs.readFile(locationsPath, "utf8") : "{}\n")),
    pathExists(documentsPath).then((exists) => (exists ? fs.readFile(documentsPath, "utf8") : "{}\n")),
    listManuscriptDocuments(sources.manuscriptDirPath)
  ]);

  return buildTimelineGraph(
    parseYaml(eventsRaw),
    parseYaml(charactersRaw),
    parseYaml(locationsRaw),
    parseYaml(documentsRaw),
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

async function resolveVonnegutDataSources(workspaceRoot: string): Promise<{
  entitiesDirPath: string;
  manuscriptDirPath: string;
  sourceLabel: string;
}> {
  const entitiesDirPath = path.join(workspaceRoot, "Entities");
  const manuscriptDirPath = path.join(workspaceRoot, "Manuscript");
  const hasEvents = await pathExists(path.join(entitiesDirPath, "events.yaml"));
  const hasManuscriptDir = await pathExists(manuscriptDirPath);
  if (hasEvents && hasManuscriptDir) {
    return {
      entitiesDirPath,
      manuscriptDirPath,
      sourceLabel: "Entities/ + Manuscript/"
    };
  }
  throw new Error("Missing events.yaml in Entities/ or missing Manuscript/ directory.");
}

function buildTimelineGraph(
  eventsDocument: unknown,
  charactersDocument: unknown,
  locationsDocument: unknown,
  documentsDocument: unknown,
  manuscriptDocuments: string[],
  sourceLabel: string
): TimelineGraphData {
  const eventsRecord = asRecord(eventsDocument);
  const charactersRecord = asRecord(charactersDocument);
  const locationsRecord = asRecord(locationsDocument);
  const documentsRecord = asRecord(documentsDocument);
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
  const resolveDocumentRecordName = (documentReference: string): string | undefined => {
    const normalizedDocumentReference = normalizeDocumentReference(documentReference);
    if (!normalizedDocumentReference) {
      return undefined;
    }

    const exact = documentsByLower.get(normalizedDocumentReference.toLowerCase());
    if (exact) {
      return exact;
    }

    const basenameLower = path.posix.basename(normalizedDocumentReference).toLowerCase();
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
  const documentSummaryByName = new Map<string, string>();
  const documentIndexByName = new Map<string, number>();
  const parseOptionalIndex = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };
  for (const [documentRecordName, documentRecordValue] of Object.entries(documentsRecord)) {
    const resolvedDocumentName = resolveDocumentRecordName(documentRecordName);
    if (!resolvedDocumentName) {
      continue;
    }
    const documentRecord = asRecord(documentRecordValue);
    documentSummaryByName.set(resolvedDocumentName, asOptionalString(documentRecord["summary"]) ?? "");
    const parsedIndex = parseOptionalIndex(documentRecord["index"]);
    if (typeof parsedIndex === "number") {
      documentIndexByName.set(resolvedDocumentName, parsedIndex);
    }
  }

  const characterEventMap = new Map<string, Set<number>>();
  const locationEventMap = new Map<string, Set<number>>();
  const documentEventMap = new Map<string, Set<number>>();
  const documentPartiesByName = new Map<string, Set<string>>();
  const documentLocationsByName = new Map<string, Set<string>>();
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
    const eventParties = parseEventPartyNames(event["parties"]);
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
      summary: asOptionalString(event["summary"]) ?? "",
      causes: toUniqueStrings([
        ...asStringArray(event["causes"]),
        ...(asOptionalString(event["cause"]) ? [asOptionalString(event["cause"]) as string] : [])
      ]),
      explaination: asOptionalString(event["explaination"]) ?? asOptionalString(event["explanation"]) ?? ""
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

      const documentParties = documentPartiesByName.get(mention) ?? new Set<string>();
      for (const partyName of eventParties) {
        if (!knownCharacters.has(partyName)) {
          continue;
        }
        documentParties.add(partyName);
      }
      documentPartiesByName.set(mention, documentParties);

      const documentLocations = documentLocationsByName.get(mention) ?? new Set<string>();
      for (const locationName of eventLocations) {
        if (!knownLocations.has(locationName)) {
          continue;
        }
        documentLocations.add(locationName);
      }
      documentLocationsByName.set(mention, documentLocations);
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
    const documentParties = Array.from(documentPartiesByName.get(documentName) ?? []);
    for (const partyName of documentParties) {
      if (!knownCharacters.has(partyName)) {
        continue;
      }
      links.push({
        id: `documentParty:${documentName}:${partyName}`,
        source: `character:${partyName}`,
        target: `document:${documentName}`,
        linkKind: "documentParty"
      });
    }

    const documentLocations = Array.from(documentLocationsByName.get(documentName) ?? []);
    for (const locationName of documentLocations) {
      links.push({
        id: `documentLocation:${documentName}:${locationName}`,
        source: `location:${locationName}`,
        target: `document:${documentName}`,
        linkKind: "documentLocation"
      });
    }
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
      meanEventIndex: connected.meanIndex,
      documentIndex: documentIndexByName.get(documentName),
      summary: documentSummaryByName.get(documentName) ?? ""
    });
  }

  return {
    nodes,
    links,
    sourceLabel
  };
}

function buildVonnegutGraph(
  eventsDocument: unknown,
  documentsDocument: unknown,
  manuscriptDocuments: string[],
  sourceLabel: string
): VonnegutGraphData {
  const eventsRecord = asRecord(eventsDocument);
  const documentsRecord = asRecord(documentsDocument);
  const eventEntries = Object.entries(eventsRecord);
  const smoothingWindow = 3;

  const parseOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

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

  const resolveDocumentName = (documentReference: string): string | undefined => {
    const normalizedReference = normalizeDocumentReference(documentReference);
    if (!normalizedReference) {
      return undefined;
    }
    const exact = documentsByLower.get(normalizedReference.toLowerCase());
    if (exact) {
      return exact;
    }

    const basenameLower = path.posix.basename(normalizedReference).toLowerCase();
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

  const documentSummaryByName = new Map<string, string>();
  const documentIndexByName = new Map<string, number>();
  for (const [documentRecordName, documentRecordValue] of Object.entries(documentsRecord)) {
    const resolvedDocumentName = resolveDocumentName(documentRecordName);
    if (!resolvedDocumentName) {
      continue;
    }
    const documentRecord = asRecord(documentRecordValue);
    documentSummaryByName.set(resolvedDocumentName, asOptionalString(documentRecord["summary"]) ?? "");
    const parsedIndex = parseOptionalNumber(documentRecord["index"]);
    if (typeof parsedIndex === "number") {
      documentIndexByName.set(resolvedDocumentName, parsedIndex);
    }
  }

  const eventPoints: VonnegutEventPoint[] = [];
  const documentValencesByName = new Map<string, number[]>();
  for (let eventIndex = 0; eventIndex < eventEntries.length; eventIndex += 1) {
    const [eventName, eventValue] = eventEntries[eventIndex];
    const event = asRecord(eventValue);
    const valence = parseOptionalNumber(event["valence"]);
    const mentions = toUniqueStrings(
      asStringArray(event["mentions"])
        .map((mention) => resolveDocumentName(mention))
        .filter((mention): mention is string => typeof mention === "string")
    );

    eventPoints.push({
      id: `event:${eventName}`,
      name: eventName,
      orderIndex: eventIndex,
      valence,
      date: asOptionalString(event["date"]) ?? "",
      summary: asOptionalString(event["summary"]) ?? "",
      mentions
    });

    if (!Number.isFinite(valence)) {
      continue;
    }
    const eventValence = valence as number;
    for (const mention of mentions) {
      if (!knownDocuments.has(mention)) {
        continue;
      }
      const values = documentValencesByName.get(mention) ?? [];
      values.push(eventValence);
      documentValencesByName.set(mention, values);
    }
  }

  const sortedDocumentNames = documentOrder.slice().sort((a, b) => {
    const indexA = documentIndexByName.get(a);
    const indexB = documentIndexByName.get(b);
    const hasA = Number.isFinite(indexA);
    const hasB = Number.isFinite(indexB);
    if (hasA && hasB && indexA !== indexB) {
      return (indexA as number) - (indexB as number);
    }
    if (hasA && !hasB) {
      return -1;
    }
    if (!hasA && hasB) {
      return 1;
    }
    return a.localeCompare(b);
  });

  const documentPoints: VonnegutDocumentPoint[] = sortedDocumentNames.map((documentName, orderIndex) => {
    const valenceSamples = documentValencesByName.get(documentName) ?? [];
    const valence = valenceSamples.length > 0
      ? valenceSamples.reduce((sum, sample) => sum + sample, 0) / valenceSamples.length
      : undefined;
    return {
      id: `document:${documentName}`,
      name: documentName,
      orderIndex,
      documentIndex: documentIndexByName.get(documentName),
      valence,
      eventCount: valenceSamples.length,
      summary: documentSummaryByName.get(documentName) ?? ""
    };
  });

  return {
    events: eventPoints,
    documents: documentPoints,
    smoothingWindow,
    sourceLabel
  };
}

function buildPacingGraph(
  eventsDocument: unknown,
  documentsDocument: unknown,
  manuscriptDocuments: string[],
  sourceLabel: string
): PacingGraphData {
  const eventsRecord = asRecord(eventsDocument);
  const documentsRecord = asRecord(documentsDocument);
  const eventEntries = Object.entries(eventsRecord);
  const smoothingWindow = 3;

  const parseOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

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

  const resolveDocumentName = (documentReference: string): string | undefined => {
    const normalizedReference = normalizeDocumentReference(documentReference);
    if (!normalizedReference) {
      return undefined;
    }
    const exact = documentsByLower.get(normalizedReference.toLowerCase());
    if (exact) {
      return exact;
    }
    const basenameLower = path.posix.basename(normalizedReference).toLowerCase();
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

  const documentSummaryByName = new Map<string, string>();
  const documentIndexByName = new Map<string, number>();
  for (const [documentRecordName, documentRecordValue] of Object.entries(documentsRecord)) {
    const resolvedDocumentName = resolveDocumentName(documentRecordName);
    if (!resolvedDocumentName) {
      continue;
    }
    const documentRecord = asRecord(documentRecordValue);
    documentSummaryByName.set(resolvedDocumentName, asOptionalString(documentRecord["summary"]) ?? "");
    const parsedIndex = parseOptionalNumber(documentRecord["index"]);
    if (typeof parsedIndex === "number") {
      documentIndexByName.set(resolvedDocumentName, parsedIndex);
    }
  }

  const documentEventCountByName = new Map<string, number>();
  for (const [, eventValue] of eventEntries) {
    const event = asRecord(eventValue);
    const mentions = toUniqueStrings(
      asStringArray(event["mentions"])
        .map((mention) => resolveDocumentName(mention))
        .filter((mention): mention is string => typeof mention === "string")
    );
    for (const mention of mentions) {
      if (!knownDocuments.has(mention)) {
        continue;
      }
      documentEventCountByName.set(mention, (documentEventCountByName.get(mention) ?? 0) + 1);
    }
  }

  const sortedDocumentNames = documentOrder.slice().sort((a, b) => {
    const indexA = documentIndexByName.get(a);
    const indexB = documentIndexByName.get(b);
    const hasA = Number.isFinite(indexA);
    const hasB = Number.isFinite(indexB);
    if (hasA && hasB && indexA !== indexB) {
      return (indexA as number) - (indexB as number);
    }
    if (hasA && !hasB) {
      return -1;
    }
    if (!hasA && hasB) {
      return 1;
    }
    return a.localeCompare(b);
  });

  const documents: PacingDocumentPoint[] = sortedDocumentNames.map((documentName, orderIndex) => ({
    id: `document:${documentName}`,
    name: documentName,
    orderIndex,
    documentIndex: documentIndexByName.get(documentName),
    eventCount: documentEventCountByName.get(documentName) ?? 0,
    summary: documentSummaryByName.get(documentName) ?? ""
  }));

  return {
    documents,
    smoothingWindow,
    sourceLabel
  };
}

function buildPlotGridCsvOutputs(
  eventsDocument: unknown,
  charactersDocument: unknown,
  documentsDocument: unknown,
  manuscriptDocuments: string[]
): { eventCsv: string; documentCsv: string } {
  const eventsRecord = asRecord(eventsDocument);
  const charactersRecord = asRecord(charactersDocument);
  const documentsRecord = asRecord(documentsDocument);
  const eventEntries = Object.entries(eventsRecord);
  const characterNames = Object.keys(charactersRecord).sort((a, b) => a.localeCompare(b));

  const parseOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

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

  const resolveDocumentName = (documentReference: string): string | undefined => {
    const normalizedReference = normalizeDocumentReference(documentReference);
    if (!normalizedReference) {
      return undefined;
    }
    const exact = documentsByLower.get(normalizedReference.toLowerCase());
    if (exact) {
      return exact;
    }
    const basenameLower = path.posix.basename(normalizedReference).toLowerCase();
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

  const documentSummaryByName = new Map<string, string>();
  const documentIndexByName = new Map<string, number>();
  for (const [documentRecordName, documentRecordValue] of Object.entries(documentsRecord)) {
    const resolvedDocumentName = resolveDocumentName(documentRecordName);
    if (!resolvedDocumentName) {
      continue;
    }
    const documentRecord = asRecord(documentRecordValue);
    documentSummaryByName.set(resolvedDocumentName, asOptionalString(documentRecord["summary"]) ?? "");
    const parsedIndex = parseOptionalNumber(documentRecord["index"]);
    if (typeof parsedIndex === "number") {
      documentIndexByName.set(resolvedDocumentName, parsedIndex);
    }
  }

  const sortedDocumentNames = documentOrder.slice().sort((a, b) => {
    const indexA = documentIndexByName.get(a);
    const indexB = documentIndexByName.get(b);
    const hasA = Number.isFinite(indexA);
    const hasB = Number.isFinite(indexB);
    if (hasA && hasB && indexA !== indexB) {
      return (indexA as number) - (indexB as number);
    }
    if (hasA && !hasB) {
      return -1;
    }
    if (!hasA && hasB) {
      return 1;
    }
    return a.localeCompare(b);
  });

  const eventColumns: Array<{
    name: string;
    summary: string;
    mentions: string[];
    roleByCharacter: Map<string, string>;
  }> = [];

  for (const [eventName, eventValue] of eventEntries) {
    const event = asRecord(eventValue);
    const mentions = toUniqueStrings(
      asStringArray(event["mentions"])
        .map((mention) => resolveDocumentName(mention))
        .filter((mention): mention is string => typeof mention === "string")
    );
    const roleByCharacter = new Map<string, string>();
    for (const party of parseEventParties(event["parties"])) {
      const existing = roleByCharacter.get(party.name);
      if (!existing) {
        roleByCharacter.set(party.name, party.role);
        continue;
      }
      const roleParts = existing.split(" | ");
      if (!roleParts.includes(party.role)) {
        roleByCharacter.set(party.name, `${existing} | ${party.role}`);
      }
    }
    eventColumns.push({
      name: eventName,
      summary: asOptionalString(event["summary"]) ?? "",
      mentions,
      roleByCharacter
    });
  }

  const eventsByDocument = new Map<string, typeof eventColumns>();
  for (const documentName of sortedDocumentNames) {
    eventsByDocument.set(documentName, []);
  }
  for (const eventColumn of eventColumns) {
    for (const mention of eventColumn.mentions) {
      const current = eventsByDocument.get(mention);
      if (current) {
        current.push(eventColumn);
      }
    }
  }

  const eventRows: string[][] = [
    ["Character", ...eventColumns.map((column) => column.name)],
    ["Description", ...eventColumns.map((column) => column.summary)]
  ];
  for (const characterName of characterNames) {
    eventRows.push([
      characterName,
      ...eventColumns.map((column) => column.roleByCharacter.get(characterName) ?? "")
    ]);
  }

  const documentRows: string[][] = [
    ["Character", ...sortedDocumentNames],
    ["Description", ...sortedDocumentNames.map((documentName) => documentSummaryByName.get(documentName) ?? "")]
  ];
  for (const characterName of characterNames) {
    const row = [characterName];
    for (const documentName of sortedDocumentNames) {
      const events = eventsByDocument.get(documentName) ?? [];
      const lines: string[] = [];
      for (const eventColumn of events) {
        const role = eventColumn.roleByCharacter.get(characterName);
        if (!role) {
          continue;
        }
        lines.push(`${eventColumn.name}: ${role}`);
      }
      row.push(lines.join("\n"));
    }
    documentRows.push(row);
  }

  return {
    eventCsv: toCsv(eventRows),
    documentCsv: toCsv(documentRows)
  };
}

function getTimelineDashboardHtml(
  graph: TimelineGraphData,
  mode: TimelineDashboardMode,
  options: DashboardHtmlOptions = {}
): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const timelineModeJson = JSON.stringify(mode).replace(/</g, "\\u003c");
  const dashboardColorsJson = JSON.stringify(DASHBOARD_COLOR_SCHEME).replace(/</g, "\\u003c");
  const includeSaveButton = options.includeSaveButton ?? true;
  const standaloneDarkMode = options.standaloneDarkMode ?? false;
  const rootCssVars = standaloneDarkMode
    ? `color-scheme: dark;
      --dashboard-bg: #0f1318;
      --dashboard-fg: #e7edf3;
      --dashboard-border: #2a3340;
      --dashboard-widget-bg: #181f28;
      --dashboard-description: #9aa7b8;
      --dashboard-tooltip-bg: rgba(21, 28, 36, 0.95);
      --dashboard-tooltip-fg: #f3f6fb;
      --dashboard-font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;`
    : `color-scheme: light dark;
      --dashboard-bg: var(--vscode-editor-background);
      --dashboard-fg: var(--vscode-editor-foreground);
      --dashboard-border: var(--vscode-panel-border);
      --dashboard-widget-bg: var(--vscode-editorWidget-background);
      --dashboard-description: var(--vscode-descriptionForeground);
      --dashboard-tooltip-bg: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      --dashboard-tooltip-fg: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      --dashboard-font-family: var(--vscode-font-family, "Segoe UI", "Noto Sans", Arial, sans-serif);`;
  const saveButtonHtml = includeSaveButton ? '<button id="save-dashboard" class="save-button" type="button">Save</button>' : "";
  const modeToggleHtml = `<div class="mode-toggle" role="group" aria-label="Timeline mode">
    <button id="mode-event" class="mode-button" type="button">Event Timeline</button>
    <button id="mode-document" class="mode-button" type="button">Document Timeline</button>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      ${rootCssVars}
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--dashboard-bg);
      color: var(--dashboard-fg);
      font-family: var(--dashboard-font-family);
      overflow: hidden;
    }
    .root {
      width: 100%;
      height: 100%;
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-tooltip-bg);
      color: var(--dashboard-tooltip-fg);
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(40vw, 420px);
      max-height: 45vh;
      overflow: auto;
    }
    .legend-title {
      margin: 8px 0 6px 0;
      color: var(--dashboard-description);
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
    .save-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 120;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
    .mode-toggle {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 120;
      display: inline-flex;
      gap: 6px;
      padding: 6px;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 8px;
    }
    .mode-button {
      border: 1px solid var(--dashboard-border);
      background: transparent;
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 8px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .mode-button.active {
      background: rgba(120, 170, 220, 0.25);
      border-color: rgba(120, 170, 220, 0.75);
    }
  </style>
</head>
<body>
  ${saveButtonHtml}
  ${modeToggleHtml}
  <div class="root">
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const initialTimelineMode = ${timelineModeJson};
    const dashboardColors = ${dashboardColorsJson};
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const saveButton = document.getElementById('save-dashboard');
    const modeEventButton = document.getElementById('mode-event');
    const modeDocumentButton = document.getElementById('mode-document');
    let currentTimelineMode = initialTimelineMode;

    function isDocumentTimelineMode() {
      return currentTimelineMode === 'document';
    }

    function isTimelineMode(value) {
      return value === 'event' || value === 'document';
    }

    function updateModeButtons() {
      if (modeEventButton) {
        modeEventButton.classList.toggle('active', currentTimelineMode === 'event');
      }
      if (modeDocumentButton) {
        modeDocumentButton.classList.toggle('active', currentTimelineMode === 'document');
      }
    }

    if (saveButton && vscodeApi) {
      saveButton.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveDashboard' });
      });
    }
    if (saveButton && !vscodeApi) {
      saveButton.style.display = 'none';
    }
    if (modeEventButton) {
      modeEventButton.addEventListener('click', () => {
        switchTimelineMode('event');
      });
    }
    if (modeDocumentButton) {
      modeDocumentButton.addEventListener('click', () => {
        switchTimelineMode('document');
      });
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'setTimelineMode' || !isTimelineMode(message.mode)) {
        return;
      }
      switchTimelineMode(message.mode, true);
    });
    const aspect = 0.5;
    let width = 0;
    let height = 0;
    let dragging = false;
    let backboneY = 0;
    let backboneStartX = 0;
    const backboneDx = 50;
    const eventAnchorStrength = 5.0;
    const anchorById = new Map();

    const eventNodes = graph.nodes
      .filter((node) => node.nodeKind === 'event')
      .sort((a, b) => (a.eventIndex || 0) - (b.eventIndex || 0));
    const eventCount = eventNodes.length;
    const documentNodes = graph.nodes.filter((node) => node.nodeKind === 'document');
    const orderedDocumentNodes = documentNodes.slice().sort((a, b) => {
      const indexA = Number.isFinite(a.documentIndex) ? a.documentIndex : Number.POSITIVE_INFINITY;
      const indexB = Number.isFinite(b.documentIndex) ? b.documentIndex : Number.POSITIVE_INFINITY;
      if (indexA !== indexB) {
        return indexA - indexB;
      }
      return a.name.localeCompare(b.name);
    });
    let backboneNodes = [];
    let backboneCount = 0;
    let backboneLinks = [];
    let documentBackboneIndexByName = new Map();
    let visibleLinks = [];
    const eventCenterIndex = eventCount <= 1 ? 0 : (eventCount - 1) / 2;
    let backboneCenterIndex = 0;
    const characterNodes = graph.nodes.filter((node) => node.nodeKind === 'character');
    const characterLikeNodes = graph.nodes.filter((node) => node.nodeKind === 'character' || node.nodeKind === 'location');
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

    function recomputeModeState() {
      const useDocumentTimeline = isDocumentTimelineMode();
      backboneNodes = useDocumentTimeline ? orderedDocumentNodes : eventNodes;
      backboneCount = backboneNodes.length;
      backboneLinks = backboneNodes.slice(0, -1).map((sourceNode, index) => ({
        id: 'backbone:' + index,
        source: sourceNode,
        target: backboneNodes[index + 1]
      }));
      documentBackboneIndexByName = new Map(backboneNodes.map((node, index) => [node.name, index]));
      backboneCenterIndex = backboneCount <= 1 ? 0 : (backboneCount - 1) / 2;
      visibleLinks = useDocumentTimeline
        ? graph.links.filter((link) => link.linkKind !== 'party' && link.linkKind !== 'location')
        : graph.links.filter((link) => link.linkKind !== 'documentParty' && link.linkKind !== 'documentLocation');
    }

    function isBackboneNode(node) {
      return isDocumentTimelineMode() ? node.nodeKind === 'document' : node.nodeKind === 'event';
    }

    function mapEventIndexToBackboneIndex(eventIndex) {
      if (!Number.isFinite(eventIndex) || eventCount <= 1 || backboneCount <= 1) {
        return backboneCenterIndex;
      }
      return clamp((eventIndex / (eventCount - 1)) * (backboneCount - 1), 0, backboneCount - 1);
    }

    function getNodeBackboneMetrics(node) {
      if (isDocumentTimelineMode() && node.nodeKind === 'character') {
        const partyDocumentIndices = visibleLinks
          .filter((link) => link.linkKind === 'documentParty' && link.source === node.id)
          .map((link) => {
            const targetNode = nodeById.get(link.target);
            return targetNode ? documentBackboneIndexByName.get(targetNode.name) : undefined;
          })
          .filter((index) => Number.isFinite(index));
        if (partyDocumentIndices.length > 0) {
          const sortedPartyIndices = partyDocumentIndices.slice().sort((a, b) => a - b);
          const first = sortedPartyIndices[0];
          const last = sortedPartyIndices[sortedPartyIndices.length - 1];
          const meanIndex = sortedPartyIndices.reduce((sum, index) => sum + index, 0) / sortedPartyIndices.length;
          return {
            connected: true,
            meanIndex,
            span: Math.max(0, last - first)
          };
        }
      }

      if (isDocumentTimelineMode() && node.nodeKind === 'location') {
        const locationDocumentIndices = visibleLinks
          .filter((link) => link.linkKind === 'documentLocation' && link.source === node.id)
          .map((link) => {
            const targetNode = nodeById.get(link.target);
            return targetNode ? documentBackboneIndexByName.get(targetNode.name) : undefined;
          })
          .filter((index) => Number.isFinite(index));
        if (locationDocumentIndices.length > 0) {
          const sortedLocationIndices = locationDocumentIndices.slice().sort((a, b) => a - b);
          const first = sortedLocationIndices[0];
          const last = sortedLocationIndices[sortedLocationIndices.length - 1];
          const meanIndex = sortedLocationIndices.reduce((sum, index) => sum + index, 0) / locationDocumentIndices.length;
          return {
            connected: true,
            meanIndex,
            span: Math.max(0, last - first)
          };
        }
      }

      if (isDocumentTimelineMode() && node.nodeKind === 'event') {
        const mentionDocumentIndices = (Array.isArray(node.mentions) ? node.mentions : [])
          .map((mention) => documentBackboneIndexByName.get(mention))
          .filter((index) => Number.isFinite(index));
        if (mentionDocumentIndices.length > 0) {
          const sortedMentionIndices = mentionDocumentIndices.slice().sort((a, b) => a - b);
          const first = sortedMentionIndices[0];
          const last = sortedMentionIndices[sortedMentionIndices.length - 1];
          const meanIndex = sortedMentionIndices.reduce((sum, index) => sum + index, 0) / sortedMentionIndices.length;
          return {
            connected: true,
            meanIndex,
            span: Math.max(0, last - first)
          };
        }
      }

      const connected = Number.isFinite(node.connectedEventCount) && node.connectedEventCount > 0;
      const rawMeanIndex = Number.isFinite(node.meanEventIndex) ? node.meanEventIndex : eventCenterIndex;
      const meanIndex = isDocumentTimelineMode() ? mapEventIndexToBackboneIndex(rawMeanIndex) : rawMeanIndex;
      return {
        connected,
        meanIndex,
        span: Number.isFinite(node.connectedEventSpan) ? Math.max(0, node.connectedEventSpan) : 0
      };
    }

    const types = Array.from(new Set(characterNodes.map((node) => node.characterType || 'Unknown'))).sort();
    if (types.length === 0) {
      types.push('Unknown');
    }
    const palette = dashboardColors.categoricalPalette;
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
      height = Math.max(320, rect.height);
      svg.attr('viewBox', [0, 0, width, height]);
    }

    function updateTargets() {
      backboneY = height / 2;
      backboneStartX = backboneCount <= 1 ? width / 2 : width / 2 - ((backboneCount - 1) * backboneDx) / 2;

      anchorById.clear();
      for (let index = 0; index < backboneNodes.length; index += 1) {
        const backboneNode = backboneNodes[index];
        const x = backboneCount <= 1 ? width / 2 : backboneStartX + index * backboneDx;
        anchorById.set(backboneNode.id, { x, y: backboneY });
      }

      for (const node of graph.nodes) {
        if (isBackboneNode(node)) {
          const anchor = anchorById.get(node.id) || { x: width / 2, y: backboneY };
          node.targetX = anchor.x;
          node.targetY = anchor.y;
        } else {
          const metrics = getNodeBackboneMetrics(node);
          if (!metrics.connected) {
            const firstBackboneNode = backboneNodes.length > 0 ? backboneNodes[0] : undefined;
            const firstAnchor = firstBackboneNode ? anchorById.get(firstBackboneNode.id) : undefined;
            node.targetX = (firstAnchor ? firstAnchor.x : width / 2) - 2 * backboneDx;
            if (isCharacterLikeNode(node)) {
              const yOffset = 2 * backboneDx * aspect;
              node.targetY = backboneY - yOffset;
            } else {
              const spanOffset = (metrics.span + 1) * backboneDx * aspect;
              node.targetY = backboneY + 2 * backboneDx + spanOffset;
            }
          } else {
            node.targetX = backboneCount <= 1 ? width / 2 : backboneStartX + metrics.meanIndex * backboneDx;
            const yOffset = (metrics.span + 1) * backboneDx * aspect;
            node.targetY = isCharacterLikeNode(node) ? backboneY - 1 * backboneDx - yOffset : backboneY + 5 * backboneDx + yOffset;
          }
        }

        if (!Number.isFinite(node.x)) {
          node.x = node.targetX;
        }
        if (!Number.isFinite(node.y)) {
          node.y = node.targetY;
        }
      }

      syncBackbonePinning();
    }

    function syncBackbonePinning() {
      for (const node of graph.nodes) {
        if (isBackboneNode(node)) {
          node.fy = backboneY;
        } else {
          node.fy = null;
        }
      }
    }

    function nodeFill(node) {
      if (node.nodeKind === 'event') {
        return dashboardColors.timeline.eventNode;
      }
      if (node.nodeKind === 'character') {
        return characterColor(node.characterType || 'Unknown');
      }
      if (node.nodeKind === 'location') {
        return dashboardColors.timeline.locationNode;
      }
      return dashboardColors.timeline.documentNode;
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
        { label: 'Event', color: dashboardColors.timeline.eventNode },
        { label: 'Location', color: dashboardColors.timeline.locationNode },
        { label: 'Document', color: dashboardColors.timeline.documentNode }
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

    recomputeModeState();
    updateModeButtons();
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
      .attr('fill', dashboardColors.timeline.backbone);

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

    let backboneEdge = backboneEdgeLayer.selectAll('line');
    function refreshBackboneEdges() {
      backboneEdge = backboneEdgeLayer
        .selectAll('line')
        .data(backboneLinks, (d) => d.id)
        .join('line')
        .attr('stroke', dashboardColors.timeline.backbone)
        .attr('stroke-opacity', defaultBackboneOpacity)
        .attr('stroke-width', defaultBackboneWidth)
        .attr('stroke-linecap', 'round')
        .attr('marker-end', 'url(#' + backboneMarkerId + ')')
        .attr('pointer-events', 'none');
    }
    refreshBackboneEdges();

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

    function trimmedBackboneEdge(edgeDatum) {
      const sourceNode = edgeDatum.source;
      const targetNode = edgeDatum.target;
      const sourceX = sourceNode.x || 0;
      const sourceY = sourceNode.y || 0;
      const targetX = targetNode.x || 0;
      const targetY = targetNode.y || 0;
      const dx = targetX - sourceX;
      const dy = targetY - sourceY;
      const length = Math.hypot(dx, dy);

      if (!Number.isFinite(length) || length < 0.001) {
        return {
          x1: sourceX,
          y1: sourceY,
          x2: targetX,
          y2: targetY
        };
      }

      const ux = dx / length;
      const uy = dy / length;
      const sourceInset = nodeRadius(sourceNode) + 1;
      const targetInset = nodeRadius(targetNode) + 2;
      const usableLength = Math.max(1, length - sourceInset - targetInset);
      const sourceOffset = Math.min(sourceInset, Math.max(0, (length - 1) * 0.5));
      const targetOffset = Math.min(targetInset, Math.max(0, length - sourceOffset - usableLength));

      return {
        x1: sourceX + ux * sourceOffset,
        y1: sourceY + uy * sourceOffset,
        x2: targetX - ux * targetOffset,
        y2: targetY - uy * targetOffset
      };
    }

    function timelineLinkPath(linkDatum) {
      const sourceNode = typeof linkDatum.source === 'string' ? nodeById.get(linkDatum.source) : linkDatum.source;
      const targetNode = typeof linkDatum.target === 'string' ? nodeById.get(linkDatum.target) : linkDatum.target;
      if (!sourceNode || !targetNode) {
        return '';
      }

      const sourceIsBackbone = isBackboneNode(sourceNode);
      const targetIsBackbone = isBackboneNode(targetNode);
      if (sourceIsBackbone === targetIsBackbone) {
        return 'M' + sourceNode.x + ',' + sourceNode.y + 'L' + targetNode.x + ',' + targetNode.y;
      }

      const backboneNode = sourceIsBackbone ? sourceNode : targetNode;
      const nonBackboneNode = sourceIsBackbone ? targetNode : sourceNode;
      const direction = nonBackboneNode.y < backboneNode.y ? -1 : 1;
      const backboneRadius = nodeRadius(backboneNode);
      const startX = backboneNode.x;
      const startY = backboneNode.y + direction * (backboneRadius + 1);
      const endX = nonBackboneNode.x;
      const endY = nonBackboneNode.y;
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
      .attr('stroke', (d) => (d.linkKind === 'mention' ? dashboardColors.timeline.mentionLink : dashboardColors.timeline.partyLink))
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
            : d.linkKind === 'documentParty'
              ? 'Document Party'
            : d.linkKind === 'documentLocation'
              ? 'Document Location'
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

    function refreshVisibleLinkStyles() {
      const visibleLinkIds = new Set(visibleLinks.map((item) => item.id));
      link.attr('display', (d) => (visibleLinkIds.has(d.id) ? null : 'none'));
    }
    refreshVisibleLinkStyles();

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
            'Causes: ' + formatCauses(d.causes),
            d.explaination ? 'Explaination: ' + d.explaination : 'Explaination: (none)',
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
          'Linked events: ' + d.connectedEventCount,
          d.summary ? 'Summary: ' + d.summary : 'Summary: (none)'
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
      .attr('fill', 'var(--dashboard-fg)')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const documentLabels = labelLayer
      .selectAll('text.document')
      .data(documentNodes, (d) => d.id)
      .join('text')
      .attr('class', 'document')
      .attr('font-size', 11)
      .attr('fill', 'var(--dashboard-fg)')
      .attr('dominant-baseline', 'hanging')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const eventLabels = labelLayer
      .selectAll('text.event')
      .data(eventNodes, (d) => d.id)
      .join('text')
      .attr('class', 'event')
      .attr('font-size', 11)
      .attr('fill', 'var(--dashboard-fg)')
      .attr('dominant-baseline', 'hanging')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    const linkForce = d3.forceLink(visibleLinks)
      .id((d) => d.id)
      .distance((d) => (d.linkKind === 'mention' ? Math.max(24, backboneDx * 0.8) : Math.max(28, backboneDx * 0.9)))
      .strength(0.08);

    const xForce = d3.forceX((d) => d.targetX)
      .strength((d) => (isBackboneNode(d) ? eventAnchorStrength : 0.24));
    const yForce = d3.forceY((d) => d.targetY)
      .strength((d) => (isBackboneNode(d) ? eventAnchorStrength : 0.24));

    const simulation = d3.forceSimulation(graph.nodes)
      .alphaDecay(0.0023)
      .velocityDecay(0.45)
      .force('link', linkForce)
      .force('x', xForce)
      .force('y', yForce)
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
          .attr('x1', (d) => trimmedBackboneEdge(d).x1)
          .attr('y1', (d) => trimmedBackboneEdge(d).y1)
          .attr('x2', (d) => trimmedBackboneEdge(d).x2)
          .attr('y2', (d) => trimmedBackboneEdge(d).y2);

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

    function switchTimelineMode(nextMode, animate = true) {
      if (!isTimelineMode(nextMode) || nextMode === currentTimelineMode) {
        return;
      }
      currentTimelineMode = nextMode;
      // Clear prior fixed positions before recomputing the new backbone mode.
      for (const node of graph.nodes) {
        node.fx = null;
        node.fy = null;
      }
      recomputeModeState();
      updateModeButtons();
      updateTargets();
      syncBackbonePinning();
      xForce.x((d) => d.targetX).strength((d) => (isBackboneNode(d) ? eventAnchorStrength : 0.24));
      yForce.y((d) => d.targetY).strength((d) => (isBackboneNode(d) ? eventAnchorStrength : 0.24));
      refreshBackboneEdges();
      refreshVisibleLinkStyles();
      linkForce.links(visibleLinks);
      simulation.alpha(animate ? 0.9 : 0.5).restart();
      hideTooltip();
      resetTimelineConnectionHighlight();
      if (vscodeApi) {
        vscodeApi.postMessage({ type: 'timelineModeChanged', mode: currentTimelineMode });
      }
    }

    window.addEventListener('resize', () => {
      setSize();
      updateTargets();
      xForce.x((d) => d.targetX);
      yForce.y((d) => d.targetY);
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
        d.fy = isBackboneNode(d) ? backboneY : d.y;
      })
      .on('drag', (event, d) => {
        hideTooltip();
        highlightTimelineConnectionsForNode(d.id);
        d.fx = event.x;
        d.fy = isBackboneNode(d) ? backboneY : event.y;
      })
      .on('end', (event, d) => {
        dragging = false;
        hideTooltip();
        resetTimelineConnectionHighlight();
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = isBackboneNode(d) ? backboneY : null;
      });

    node.call(drag);
  </script>
</body>
</html>`;
}

function getVonnegutDashboardHtml(
  graph: VonnegutGraphData,
  mode: VonnegutDashboardMode,
  options: DashboardHtmlOptions = {}
): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const modeJson = JSON.stringify(mode).replace(/</g, "\\u003c");
  const dashboardColorsJson = JSON.stringify(DASHBOARD_COLOR_SCHEME).replace(/</g, "\\u003c");
  const includeSaveButton = options.includeSaveButton ?? true;
  const standaloneDarkMode = options.standaloneDarkMode ?? false;
  const rootCssVars = standaloneDarkMode
    ? `color-scheme: dark;
      --dashboard-bg: #0f1318;
      --dashboard-fg: #e7edf3;
      --dashboard-border: #2a3340;
      --dashboard-widget-bg: #181f28;
      --dashboard-description: #9aa7b8;
      --dashboard-tooltip-bg: rgba(21, 28, 36, 0.95);
      --dashboard-tooltip-fg: #f3f6fb;
      --dashboard-font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;`
    : `color-scheme: light dark;
      --dashboard-bg: var(--vscode-editor-background);
      --dashboard-fg: var(--vscode-editor-foreground);
      --dashboard-border: var(--vscode-panel-border);
      --dashboard-widget-bg: var(--vscode-editorWidget-background);
      --dashboard-description: var(--vscode-descriptionForeground);
      --dashboard-tooltip-bg: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      --dashboard-tooltip-fg: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      --dashboard-font-family: var(--vscode-font-family, "Segoe UI", "Noto Sans", Arial, sans-serif);`;
  const saveButtonHtml = includeSaveButton ? '<button id="save-dashboard" class="save-button" type="button">Save</button>' : "";
  const modeToggleHtml = `<div class="mode-toggle" role="group" aria-label="Vonnegut mode">
    <button id="mode-event" class="mode-button" type="button">Event View</button>
    <button id="mode-document" class="mode-button" type="button">Document View</button>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      ${rootCssVars}
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--dashboard-bg);
      color: var(--dashboard-fg);
      font-family: var(--dashboard-font-family);
      overflow: hidden;
    }
    .root {
      width: 100%;
      height: 100%;
    }
    #graph {
      width: 100%;
      height: 100%;
    }
    .tooltip {
      position: fixed;
      z-index: 1000;
      max-width: 460px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-tooltip-bg);
      color: var(--dashboard-tooltip-fg);
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(42vw, 480px);
    }
    .legend-title {
      margin: 0 0 6px 0;
      color: var(--dashboard-description);
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 3px 0;
    }
    .swatch {
      width: 12px;
      height: 2px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .save-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 120;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
    .mode-toggle {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 120;
      display: inline-flex;
      gap: 6px;
      padding: 6px;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 8px;
    }
    .mode-button {
      border: 1px solid var(--dashboard-border);
      background: transparent;
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 8px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .mode-button.active {
      background: rgba(120, 170, 220, 0.25);
      border-color: rgba(120, 170, 220, 0.75);
    }
  </style>
</head>
<body>
  ${saveButtonHtml}
  ${modeToggleHtml}
  <div class="root">
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const initialMode = ${modeJson};
    const dashboardColors = ${dashboardColorsJson};
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const saveButton = document.getElementById('save-dashboard');
    const modeEventButton = document.getElementById('mode-event');
    const modeDocumentButton = document.getElementById('mode-document');
    const margin = { top: 34, right: 44, bottom: 132, left: 58 };
    let currentMode = initialMode;
    let width = 0;
    let height = 0;

    function isValidMode(value) {
      return value === 'event' || value === 'document';
    }

    function modeColor() {
      return currentMode === 'document' ? dashboardColors.timeline.documentNode : dashboardColors.timeline.eventNode;
    }

    function currentPoints() {
      return currentMode === 'document' ? graph.documents : graph.events;
    }

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(440, rect.width);
      height = Math.max(340, rect.height);
      svg.attr('viewBox', [0, 0, width, height]);
    }

    function updateModeButtons() {
      if (modeEventButton) {
        modeEventButton.classList.toggle('active', currentMode === 'event');
      }
      if (modeDocumentButton) {
        modeDocumentButton.classList.toggle('active', currentMode === 'document');
      }
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

    function formatValence(value) {
      if (!Number.isFinite(value)) {
        return '(unknown)';
      }
      return Number(value).toFixed(2);
    }

    function buildMovingAverageSeries(points, windowSize) {
      const series = [];
      if (!Array.isArray(points) || points.length === 0 || windowSize <= 0) {
        return series;
      }
      for (let index = 0; index <= points.length - windowSize; index += 1) {
        const windowPoints = points.slice(index, index + windowSize);
        const valid = windowPoints.filter((point) => Number.isFinite(point.valence));
        if (valid.length === 0) {
          continue;
        }
        const average = valid.reduce((sum, point) => sum + point.valence, 0) / valid.length;
        series.push({
          xIndex: index + (windowSize - 1) / 2,
          valence: average
        });
      }
      return series;
    }

    function renderLegend() {
      legend.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'legend-title';
      title.textContent = 'Series';
      legend.appendChild(title);

      const rows = [
        { label: currentMode === 'document' ? 'Document valence' : 'Event valence', color: modeColor() },
        { label: graph.smoothingWindow + '-point moving average', color: modeColor() }
      ];
      for (const rowData of rows) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = rowData.color;
        const label = document.createElement('span');
        label.textContent = rowData.label;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }
    }

    function render() {
      setSize();
      hideTooltip();
      svg.selectAll('*').remove();
      renderLegend();

      const points = currentPoints();
      const plotLeft = margin.left;
      const plotRight = width - margin.right;
      const plotTop = margin.top;
      const plotBottom = height - margin.bottom;
      const domainMax = Math.max(1, points.length - 1);

      const allValences = [...graph.events, ...graph.documents]
        .map((point) => point.valence)
        .filter((value) => Number.isFinite(value));
      const minValence = allValences.length > 0 ? Math.min(...allValences, 0) : -1;
      const maxValence = allValences.length > 0 ? Math.max(...allValences, 0) : 1;
      const pad = Math.max(0.6, (maxValence - minValence) * 0.12);

      const x = d3.scaleLinear().domain([0, domainMax]).range([plotLeft, plotRight]);
      const y = d3.scaleLinear().domain([minValence - pad, maxValence + pad]).nice().range([plotBottom, plotTop]);

      const layer = svg.append('g');
      layer.append('line')
        .attr('x1', plotLeft)
        .attr('x2', plotRight)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', 'var(--dashboard-border)')
        .attr('stroke-width', 1)
        .attr('stroke-opacity', 0.7);

      const xAxis = d3.axisBottom(x)
        .ticks(Math.max(2, Math.min(8, points.length)))
        .tickFormat((value) => String(Math.round(Number(value) + 1)));
      const yAxis = d3.axisLeft(y).ticks(8);

      layer.append('g')
        .attr('transform', 'translate(0,' + plotBottom + ')')
        .attr('color', 'var(--dashboard-description)')
        .call(xAxis);

      layer.append('g')
        .attr('transform', 'translate(' + plotLeft + ',0)')
        .attr('color', 'var(--dashboard-description)')
        .call(yAxis);

      layer.append('text')
        .attr('x', plotLeft)
        .attr('y', 16)
        .attr('fill', 'var(--dashboard-description)')
        .attr('font-size', 11)
        .text(currentMode === 'document' ? 'Document Sequence' : 'Event Sequence');

      layer.append('text')
        .attr('x', 12)
        .attr('y', plotTop - 8)
        .attr('fill', 'var(--dashboard-description)')
        .attr('font-size', 11)
        .text('Valence');

      const movingAverage = buildMovingAverageSeries(points, graph.smoothingWindow);
      const line = d3.line()
        .defined((point) => Number.isFinite(point.valence))
        .x((point) => x(point.xIndex))
        .y((point) => y(point.valence))
        .curve(d3.curveMonotoneX);

      layer.append('path')
        .datum(movingAverage)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', modeColor())
        .attr('stroke-width', 2.8)
        .attr('stroke-opacity', 0.92);

      const pointGroup = layer.append('g');
      pointGroup.selectAll('circle')
        .data(points, (d) => d.id)
        .join('circle')
        .attr('cx', (d) => x(d.orderIndex))
        .attr('cy', (d) => y(Number.isFinite(d.valence) ? d.valence : 0))
        .attr('r', 6.8)
        .attr('fill', (d) => (Number.isFinite(d.valence) ? modeColor() : 'transparent'))
        .attr('stroke', modeColor())
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', (d) => (Number.isFinite(d.valence) ? null : '4,3'))
        .on('mouseover', (event, d) => {
          if (currentMode === 'event') {
            showTooltip(event, [
              d.name,
              'Valence: ' + formatValence(d.valence),
              d.date ? 'Date: ' + d.date : 'Date: (unknown)',
              d.summary ? 'Summary: ' + d.summary : 'Summary: (none)',
              Array.isArray(d.mentions) && d.mentions.length > 0 ? 'Mentions: ' + d.mentions.join(', ') : 'Mentions: (none)'
            ]);
            return;
          }
          showTooltip(event, [
            d.name,
            'Valence: ' + formatValence(d.valence),
            'Contributing events: ' + (Number.isFinite(d.eventCount) ? d.eventCount : 0),
            d.summary ? 'Summary: ' + d.summary : 'Summary: (none)'
          ]);
        })
        .on('mousemove', (event) => {
          if (tooltip.style.display !== 'block') return;
          positionTooltip(event);
        })
        .on('mouseout', hideTooltip);

      layer.append('g')
        .selectAll('text')
        .data(points, (d) => d.id)
        .join('text')
        .attr('font-size', 11)
        .attr('fill', 'var(--dashboard-fg)')
        .attr('dominant-baseline', 'hanging')
        .attr('pointer-events', 'none')
        .attr('transform', (d) => {
          const labelY = y(Number.isFinite(d.valence) ? d.valence : 0) + 8;
          return 'translate(' + (x(d.orderIndex) + 7) + ',' + labelY + ') rotate(45)';
        })
        .text((d) => d.name);
    }

    function switchMode(nextMode, emit = true) {
      if (!isValidMode(nextMode) || nextMode === currentMode) {
        return;
      }
      currentMode = nextMode;
      updateModeButtons();
      render();
      if (emit && vscodeApi) {
        vscodeApi.postMessage({ type: 'vonnegutModeChanged', mode: currentMode });
      }
    }

    if (saveButton && vscodeApi) {
      saveButton.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveDashboard' });
      });
    }
    if (saveButton && !vscodeApi) {
      saveButton.style.display = 'none';
    }
    if (modeEventButton) {
      modeEventButton.addEventListener('click', () => {
        switchMode('event');
      });
    }
    if (modeDocumentButton) {
      modeDocumentButton.addEventListener('click', () => {
        switchMode('document');
      });
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'setVonnegutMode' || !isValidMode(message.mode)) {
        return;
      }
      switchMode(message.mode, false);
    });
    window.addEventListener('resize', () => {
      render();
    });

    updateModeButtons();
    render();
  </script>
</body>
</html>`;
}

function getPacingDashboardHtml(
  graph: PacingGraphData,
  options: DashboardHtmlOptions = {}
): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const dashboardColorsJson = JSON.stringify(DASHBOARD_COLOR_SCHEME).replace(/</g, "\\u003c");
  const includeSaveButton = options.includeSaveButton ?? true;
  const standaloneDarkMode = options.standaloneDarkMode ?? false;
  const rootCssVars = standaloneDarkMode
    ? `color-scheme: dark;
      --dashboard-bg: #0f1318;
      --dashboard-fg: #e7edf3;
      --dashboard-border: #2a3340;
      --dashboard-widget-bg: #181f28;
      --dashboard-description: #9aa7b8;
      --dashboard-tooltip-bg: rgba(21, 28, 36, 0.95);
      --dashboard-tooltip-fg: #f3f6fb;
      --dashboard-font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;`
    : `color-scheme: light dark;
      --dashboard-bg: var(--vscode-editor-background);
      --dashboard-fg: var(--vscode-editor-foreground);
      --dashboard-border: var(--vscode-panel-border);
      --dashboard-widget-bg: var(--vscode-editorWidget-background);
      --dashboard-description: var(--vscode-descriptionForeground);
      --dashboard-tooltip-bg: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      --dashboard-tooltip-fg: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      --dashboard-font-family: var(--vscode-font-family, "Segoe UI", "Noto Sans", Arial, sans-serif);`;
  const saveButtonHtml = includeSaveButton ? '<button id="save-dashboard" class="save-button" type="button">Save</button>' : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      ${rootCssVars}
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--dashboard-bg);
      color: var(--dashboard-fg);
      font-family: var(--dashboard-font-family);
      overflow: hidden;
    }
    .root {
      width: 100%;
      height: 100%;
    }
    #graph {
      width: 100%;
      height: 100%;
    }
    .tooltip {
      position: fixed;
      z-index: 1000;
      max-width: 460px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-tooltip-bg);
      color: var(--dashboard-tooltip-fg);
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(42vw, 480px);
    }
    .legend-title {
      margin: 0 0 6px 0;
      color: var(--dashboard-description);
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 3px 0;
    }
    .swatch {
      width: 12px;
      height: 2px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .save-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 120;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
  </style>
</head>
<body>
  ${saveButtonHtml}
  <div class="root">
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const dashboardColors = ${dashboardColorsJson};
    const nodeColor = dashboardColors.timeline.documentNode;
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const saveButton = document.getElementById('save-dashboard');
    const margin = { top: 34, right: 44, bottom: 132, left: 58 };
    let width = 0;
    let height = 0;

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(440, rect.width);
      height = Math.max(340, rect.height);
      svg.attr('viewBox', [0, 0, width, height]);
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

    function buildMovingAverageSeries(points, windowSize) {
      const series = [];
      if (!Array.isArray(points) || points.length === 0 || windowSize <= 0) {
        return series;
      }
      for (let index = 0; index <= points.length - windowSize; index += 1) {
        const windowPoints = points.slice(index, index + windowSize);
        const total = windowPoints.reduce((sum, point) => sum + (Number.isFinite(point.eventCount) ? point.eventCount : 0), 0);
        series.push({
          xIndex: index + (windowSize - 1) / 2,
          eventCount: total / windowPoints.length
        });
      }
      return series;
    }

    function renderLegend() {
      legend.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'legend-title';
      title.textContent = 'Series';
      legend.appendChild(title);

      const rows = [
        { label: 'Events per document', color: nodeColor },
        { label: graph.smoothingWindow + '-point moving average', color: nodeColor }
      ];
      for (const rowData of rows) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = rowData.color;
        const label = document.createElement('span');
        label.textContent = rowData.label;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }
    }

    function render() {
      setSize();
      hideTooltip();
      svg.selectAll('*').remove();
      renderLegend();

      const points = graph.documents;
      const plotLeft = margin.left;
      const plotRight = width - margin.right;
      const plotTop = margin.top;
      const plotBottom = height - margin.bottom;
      const domainMax = Math.max(1, points.length - 1);
      const maxCount = points.reduce((maxValue, point) => Math.max(maxValue, point.eventCount || 0), 0);
      const yMax = Math.max(1, maxCount);

      const x = d3.scaleLinear().domain([0, domainMax]).range([plotLeft, plotRight]);
      const y = d3.scaleLinear().domain([0, yMax]).nice().range([plotBottom, plotTop]);

      const layer = svg.append('g');
      const xAxis = d3.axisBottom(x)
        .ticks(Math.max(2, Math.min(8, points.length)))
        .tickFormat((value) => String(Math.round(Number(value) + 1)));
      const yAxis = d3.axisLeft(y).ticks(Math.max(3, Math.min(10, yMax + 1)));

      layer.append('g')
        .attr('transform', 'translate(0,' + plotBottom + ')')
        .attr('color', 'var(--dashboard-description)')
        .call(xAxis);

      layer.append('g')
        .attr('transform', 'translate(' + plotLeft + ',0)')
        .attr('color', 'var(--dashboard-description)')
        .call(yAxis);

      layer.append('text')
        .attr('x', plotLeft)
        .attr('y', 16)
        .attr('fill', 'var(--dashboard-description)')
        .attr('font-size', 11)
        .text('Document Sequence');

      layer.append('text')
        .attr('x', 12)
        .attr('y', plotTop - 8)
        .attr('fill', 'var(--dashboard-description)')
        .attr('font-size', 11)
        .text('Event Count');

      const movingAverage = buildMovingAverageSeries(points, graph.smoothingWindow);
      const line = d3.line()
        .x((point) => x(point.xIndex))
        .y((point) => y(point.eventCount))
        .curve(d3.curveMonotoneX);

      layer.append('path')
        .datum(movingAverage)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', nodeColor)
        .attr('stroke-width', 2.8)
        .attr('stroke-opacity', 0.92);

      const pointGroup = layer.append('g');
      pointGroup.selectAll('circle')
        .data(points, (d) => d.id)
        .join('circle')
        .attr('cx', (d) => x(d.orderIndex))
        .attr('cy', (d) => y(d.eventCount))
        .attr('r', 6.8)
        .attr('fill', nodeColor)
        .attr('stroke', nodeColor)
        .attr('stroke-width', 1.5)
        .on('mouseover', (event, d) => {
          showTooltip(event, [
            d.name,
            'Events in document: ' + d.eventCount,
            d.summary ? 'Summary: ' + d.summary : 'Summary: (none)'
          ]);
        })
        .on('mousemove', (event) => {
          if (tooltip.style.display !== 'block') return;
          positionTooltip(event);
        })
        .on('mouseout', hideTooltip);

      layer.append('g')
        .selectAll('text')
        .data(points, (d) => d.id)
        .join('text')
        .attr('font-size', 11)
        .attr('fill', 'var(--dashboard-fg)')
        .attr('dominant-baseline', 'hanging')
        .attr('pointer-events', 'none')
        .attr('transform', (d) => {
          const labelY = y(d.eventCount) + 8;
          return 'translate(' + (x(d.orderIndex) + 7) + ',' + labelY + ') rotate(45)';
        })
        .text((d) => d.name);
    }

    if (saveButton && vscodeApi) {
      saveButton.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveDashboard' });
      });
    }
    if (saveButton && !vscodeApi) {
      saveButton.style.display = 'none';
    }

    window.addEventListener('resize', () => {
      render();
    });

    render();
  </script>
</body>
</html>`;
}

function buildCausalGraph(eventsDocument: unknown, sourceLabel: string): CausalGraphData {
  const eventsRecord = asRecord(eventsDocument);
  const eventEntries = Object.entries(eventsRecord);
  const knownEvents = new Set(eventEntries.map(([eventName]) => eventName));
  const nodes: CausalEventNode[] = [];

  const parseValence = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

  for (const [eventName, eventValue] of eventEntries) {
    const event = asRecord(eventValue);
    const causes = toUniqueStrings([
      ...asStringArray(event["causes"]),
      ...(asOptionalString(event["cause"]) ? [asOptionalString(event["cause"]) as string] : [])
    ]);
    nodes.push({
      id: `event:${eventName}`,
      name: eventName,
      mentions: toUniqueStrings(asStringArray(event["mentions"])),
      date: asOptionalString(event["date"]) ?? "",
      summary: asOptionalString(event["summary"]) ?? "",
      explaination: asOptionalString(event["explaination"]) ?? asOptionalString(event["explanation"]) ?? "",
      valence: parseValence(event["valence"]),
      causes
    });
  }

  const links: CausalEventLink[] = [];
  const seenLinks = new Set<string>();
  for (const node of nodes) {
    for (const causeName of node.causes) {
      if (!knownEvents.has(causeName) || causeName === node.name) {
        continue;
      }
      const source = `event:${causeName}`;
      const target = node.id;
      const key = `${source}=>${target}`;
      if (seenLinks.has(key)) {
        continue;
      }
      seenLinks.add(key);
      links.push({
        id: `cause:${causeName}:${node.name}`,
        source,
        target
      });
    }
  }

  return { nodes, links, sourceLabel };
}

function getCausalDashboardHtml(graph: CausalGraphData, options: DashboardHtmlOptions = {}): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const dashboardColorsJson = JSON.stringify(DASHBOARD_COLOR_SCHEME).replace(/</g, "\\u003c");
  const includeSaveButton = options.includeSaveButton ?? true;
  const standaloneDarkMode = options.standaloneDarkMode ?? false;
  const rootCssVars = standaloneDarkMode
    ? `color-scheme: dark;
      --dashboard-bg: #0f1318;
      --dashboard-fg: #e7edf3;
      --dashboard-border: #2a3340;
      --dashboard-widget-bg: #181f28;
      --dashboard-description: #9aa7b8;
      --dashboard-tooltip-bg: rgba(21, 28, 36, 0.95);
      --dashboard-tooltip-fg: #f3f6fb;
      --dashboard-font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;`
    : `color-scheme: light dark;
      --dashboard-bg: var(--vscode-editor-background);
      --dashboard-fg: var(--vscode-editor-foreground);
      --dashboard-border: var(--vscode-panel-border);
      --dashboard-widget-bg: var(--vscode-editorWidget-background);
      --dashboard-description: var(--vscode-descriptionForeground);
      --dashboard-tooltip-bg: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      --dashboard-tooltip-fg: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      --dashboard-font-family: var(--vscode-font-family, "Segoe UI", "Noto Sans", Arial, sans-serif);`;
  const saveButtonHtml = includeSaveButton ? '<button id="save-dashboard" class="save-button" type="button">Save</button>' : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      ${rootCssVars}
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--dashboard-bg);
      color: var(--dashboard-fg);
      font-family: var(--dashboard-font-family);
      overflow: hidden;
    }
    .root {
      width: 100%;
      height: 100%;
    }
    #graph {
      width: 100%;
      height: 100%;
      cursor: default;
    }
    .tooltip {
      position: fixed;
      z-index: 1000;
      max-width: 460px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-tooltip-bg);
      color: var(--dashboard-tooltip-fg);
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(40vw, 400px);
      max-height: 45vh;
      overflow: auto;
    }
    .legend-title {
      margin: 0 0 6px 0;
      color: var(--dashboard-description);
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
    .save-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 120;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
  </style>
</head>
<body>
  ${saveButtonHtml}
  <div class="root">
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const dashboardColors = ${dashboardColorsJson};
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const saveButton = document.getElementById('save-dashboard');
    if (saveButton && vscodeApi) {
      saveButton.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveDashboard' });
      });
    }
    if (saveButton && !vscodeApi) {
      saveButton.style.display = 'none';
    }

    let width = 0;
    let height = 0;
    let dragging = false;
    const nodeRadius = 8.8;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const linkIdByNodeId = new Map(graph.nodes.map((node) => [node.id, { incoming: [], outgoing: [] }]));
    for (const linkDatum of graph.links) {
      const sourceId = linkEndId(linkDatum.source);
      const targetId = linkEndId(linkDatum.target);
      if (linkIdByNodeId.has(sourceId)) {
        linkIdByNodeId.get(sourceId).outgoing.push(linkDatum);
      }
      if (linkIdByNodeId.has(targetId)) {
        linkIdByNodeId.get(targetId).incoming.push(linkDatum);
      }
    }
    const defaultLinkOpacity = 0.7;
    const defaultLinkWidth = 1.6;
    const dimmedLinkOpacity = 0.14;
    const dimmedLinkWidth = 1.0;
    const highlightedLinkOpacity = 1;
    const highlightedLinkWidth = 2.8;
    let chainColorSeed = 0;
    const nodeChainColorById = new Map();
    const causalChainPalette = dashboardColors.categoricalPalette;

    function nextChainColor() {
      const color = causalChainPalette[chainColorSeed % causalChainPalette.length] || dashboardColors.causal.fallbackChain;
      chainColorSeed += 1;
      return color;
    }

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(360, rect.width);
      height = Math.max(300, rect.height);
      svg.attr('viewBox', [0, 0, width, height]);
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    function ensureNodeChainColor(nodeId, visiting = new Set()) {
      if (nodeChainColorById.has(nodeId)) {
        return nodeChainColorById.get(nodeId);
      }

      if (visiting.has(nodeId)) {
        const cycleColor = nextChainColor();
        nodeChainColorById.set(nodeId, cycleColor);
        return cycleColor;
      }

      visiting.add(nodeId);
      const nodeLinks = linkIdByNodeId.get(nodeId) || { incoming: [], outgoing: [] };
      const incoming = nodeLinks.incoming;

      let color;
      if (incoming.length !== 1) {
        color = nextChainColor();
      } else {
        const parentId = linkEndId(incoming[0].source);
        const parentColor = ensureNodeChainColor(parentId, visiting);
        const parentLinks = linkIdByNodeId.get(parentId) || { incoming: [], outgoing: [] };
        color = parentLinks.outgoing.length > 1 ? nextChainColor() : parentColor;
      }

      nodeChainColorById.set(nodeId, color);
      visiting.delete(nodeId);
      return color;
    }

    for (const nodeDatum of graph.nodes) {
      ensureNodeChainColor(nodeDatum.id);
    }

    function nodeFill(node) {
      return nodeChainColorById.get(node.id) || '#7d8590';
    }

    function isCauselessNode(node) {
      return !Array.isArray(node.causes) || node.causes.length === 0;
    }

    function nodeStroke(node) {
      if (isCauselessNode(node)) {
        return nodeFill(node);
      }
      return 'rgba(0,0,0,0.45)';
    }

    function nodeStrokeWidth(node) {
      return isCauselessNode(node) ? 2 : 1;
    }

    function linkStrokeColor(linkDatum) {
      const sourceId = linkEndId(linkDatum.source);
      const targetId = linkEndId(linkDatum.target);
      const targetLinks = linkIdByNodeId.get(targetId) || { incoming: [], outgoing: [] };
      const chainColor = targetLinks.incoming.length > 1
        ? (nodeChainColorById.get(sourceId) || dashboardColors.causal.fallbackChain)
        : (nodeChainColorById.get(targetId) || nodeChainColorById.get(sourceId) || dashboardColors.causal.fallbackChain);
      return chainColor;
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

    function formatCauses(causes) {
      if (!Array.isArray(causes) || causes.length === 0) {
        return '(none)';
      }
      return causes.join(', ');
    }

    function linkEndId(linkEnd) {
      return typeof linkEnd === 'string' ? linkEnd : linkEnd.id;
    }

    function trimDirectedLink(linkDatum) {
      const sourceNode = typeof linkDatum.source === 'string' ? nodeById.get(linkDatum.source) : linkDatum.source;
      const targetNode = typeof linkDatum.target === 'string' ? nodeById.get(linkDatum.target) : linkDatum.target;
      if (!sourceNode || !targetNode) {
        return { x1: 0, y1: 0, x2: 0, y2: 0 };
      }

      const dx = (targetNode.x || 0) - (sourceNode.x || 0);
      const dy = (targetNode.y || 0) - (sourceNode.y || 0);
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length < 0.001) {
        return {
          x1: sourceNode.x || 0,
          y1: sourceNode.y || 0,
          x2: targetNode.x || 0,
          y2: targetNode.y || 0
        };
      }
      const ux = dx / length;
      const uy = dy / length;
      const startInset = nodeRadius + 1;
      const endInset = nodeRadius + 2;
      return {
        x1: (sourceNode.x || 0) + ux * startInset,
        y1: (sourceNode.y || 0) + uy * startInset,
        x2: (targetNode.x || 0) - ux * endInset,
        y2: (targetNode.y || 0) - uy * endInset
      };
    }

    function renderLegend() {
      legend.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'legend-title';
      title.textContent = 'Causal Chain Coloring';
      legend.appendChild(title);

      const rows = [
        { label: 'Single-cause chain: color continues downstream', color: nextChainColor() },
        { label: 'Intersection (multiple causes): event gets a new color', color: nextChainColor() },
        { label: 'Branch (multiple effects): each effect starts a new color', color: nextChainColor() }
      ];
      for (const rowData of rows) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = rowData.color;
        const label = document.createElement('span');
        label.textContent = rowData.label;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }
    }

    setSize();
    renderLegend();

    const markerId = 'causal-link-arrow';
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', markerId)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 9.4)
      .attr('refY', 0)
      .attr('markerWidth', 7)
      .attr('markerHeight', 7)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', 'context-stroke');

    const container = svg.append('g');
    const linkLayer = container.append('g').attr('fill', 'none');
    const nodeLayer = container.append('g');
    const labelLayer = container.append('g');

    const zoom = d3.zoom()
      .scaleExtent([0.2, 3.5])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
        hideTooltip();
        resetCausalLinkHighlight();
      });
    svg.call(zoom);

    const link = linkLayer
      .selectAll('line')
      .data(graph.links, (d) => d.id)
      .join('line')
      .attr('stroke', (d) => linkStrokeColor(d))
      .attr('stroke-opacity', defaultLinkOpacity)
      .attr('stroke-width', defaultLinkWidth)
      .attr('marker-end', 'url(#' + markerId + ')')
      .on('mouseover', (event, d) => {
        if (dragging) return;
        const sourceName = nodeById.get(linkEndId(d.source))?.name || linkEndId(d.source);
        const targetName = nodeById.get(linkEndId(d.target))?.name || linkEndId(d.target);
        showTooltip(event, ['Causal Link', sourceName + ' -> ' + targetName]);
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
      .attr('r', nodeRadius)
      .attr('fill', (d) => (isCauselessNode(d) ? 'none' : nodeFill(d)))
      .attr('stroke', (d) => nodeStroke(d))
      .attr('stroke-width', (d) => nodeStrokeWidth(d))
      .on('mouseover', (event, d) => {
        if (dragging) return;
        showTooltip(event, [
          d.name,
          d.date ? 'Date: ' + d.date : 'Date: (unknown)',
          isFiniteNumber(d.valence) ? 'Valence: ' + d.valence : 'Valence: (unknown)',
          'Causes: ' + formatCauses(d.causes),
          d.explaination ? 'Explaination: ' + d.explaination : 'Explaination: (none)',
          d.summary ? 'Summary: ' + d.summary : 'Summary: (none)',
          'Mentions: ' + formatMentions(d.mentions)
        ]);
      })
      .on('mousemove', (event) => {
        if (dragging || tooltip.style.display !== 'block') return;
        positionTooltip(event);
      })
      .on('mouseout', hideTooltip);

    const nodeLabel = labelLayer
      .selectAll('text')
      .data(graph.nodes, (d) => d.id)
      .join('text')
      .attr('font-size', 11)
      .attr('fill', 'var(--dashboard-fg)')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    function resetCausalLinkHighlight() {
      link
        .attr('stroke-opacity', defaultLinkOpacity)
        .attr('stroke-width', defaultLinkWidth);
    }

    function highlightCausalLinksForNode(nodeId) {
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

    const simulation = d3.forceSimulation(graph.nodes)
      .alphaDecay(0.0023)
      .force('link', d3.forceLink(graph.links).id((d) => d.id).distance(96).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-185))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.018))
      .force('y', d3.forceY(height / 2).strength(0.018))
      .force('collision', d3.forceCollide(nodeRadius + 7))
      .on('tick', () => {
        link
          .attr('x1', (d) => trimDirectedLink(d).x1)
          .attr('y1', (d) => trimDirectedLink(d).y1)
          .attr('x2', (d) => trimDirectedLink(d).x2)
          .attr('y2', (d) => trimDirectedLink(d).y2);

        node
          .attr('cx', (d) => d.x)
          .attr('cy', (d) => d.y);

        nodeLabel
          .attr('x', (d) => d.x + 10)
          .attr('y', (d) => d.y);
      });

    window.addEventListener('resize', () => {
      setSize();
      simulation.force('center', d3.forceCenter(width / 2, height / 2));
      simulation.force('x', d3.forceX(width / 2).strength(0.018));
      simulation.force('y', d3.forceY(height / 2).strength(0.018));
      simulation.alpha(0.35).restart();
      hideTooltip();
      resetCausalLinkHighlight();
    });

    const drag = d3.drag()
      .on('start', (event, d) => {
        dragging = true;
        hideTooltip();
        highlightCausalLinksForNode(d.id);
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        hideTooltip();
        highlightCausalLinksForNode(d.id);
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        dragging = false;
        hideTooltip();
        resetCausalLinkHighlight();
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag);
  </script>
</body>
</html>`;
}

function buildLocationGraph(
  locationsDocument: unknown,
  geographyDocument: unknown,
  sourceLabel: string,
  mode: LocationDashboardMode
): LocationGraphData {
  const locationsRecord = asRecord(locationsDocument);
  const geographyRecord = asRecord(geographyDocument);
  const locationNames = Object.keys(locationsRecord);
  const knownLocations = new Set(locationNames);
  const nodes: LocationGraphNode[] = [];
  const nodeByName = new Map<string, LocationGraphNode>();

  for (const [locationName, locationValue] of Object.entries(locationsRecord)) {
    const location = asRecord(locationValue);
    const regionName = asOptionalString(location["region"]);
    const validRegionName = regionName && knownLocations.has(regionName) ? regionName : undefined;

    const node: LocationGraphNode = {
      id: `location:${locationName}`,
      name: locationName,
      region: regionName,
      regionGroup: validRegionName ?? locationName,
      adjacent: [],
      mentions: toUniqueStrings(asStringArray(location["mentions"])),
      description: asOptionalString(location["description"]) ?? ""
    };
    nodes.push(node);
    nodeByName.set(locationName, node);
  }

  const links: LocationGraphLink[] = [];
  const seenGeographyPairs = new Set<string>();
  const adjacencyByName = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacencyByName.set(node.name, new Set<string>());
  }

  for (const node of nodes) {
    const validRegionName = node.region && knownLocations.has(node.region) ? node.region : undefined;
    if (validRegionName && validRegionName !== node.name) {
      links.push({
        id: `region:${node.name}:${validRegionName}`,
        source: node.id,
        target: `location:${validRegionName}`,
        linkKind: "region"
      });
    }
  }

  for (const connectionValue of Object.values(geographyRecord)) {
    const connection = asRecord(connectionValue);
    const rawA = asOptionalString(connection["location_a"]);
    const rawB = asOptionalString(connection["location_b"]);
    if (!rawA || !rawB || rawA === rawB) {
      continue;
    }
    if (!knownLocations.has(rawA) || !knownLocations.has(rawB)) {
      continue;
    }

    const [a, b] = [rawA, rawB].sort((left, right) => left.localeCompare(right));
    const key = `${a}::${b}`;
    if (seenGeographyPairs.has(key)) {
      continue;
    }
    seenGeographyPairs.add(key);

    links.push({
      id: `adjacent:${a}:${b}`,
      source: `location:${a}`,
      target: `location:${b}`,
      linkKind: "adjacent"
    });

    adjacencyByName.get(a)?.add(b);
    adjacencyByName.get(b)?.add(a);
  }

  for (const [locationName, adjacentSet] of adjacencyByName.entries()) {
    const node = nodeByName.get(locationName);
    if (!node) {
      continue;
    }
    node.adjacent = Array.from(adjacentSet).sort((left, right) => left.localeCompare(right));
  }

  const filteredLinks = links.filter((link) => (mode === "hierarchy" ? link.linkKind === "region" : link.linkKind === "adjacent"));
  return { nodes, links: filteredLinks, sourceLabel };
}

function getLocationsDashboardHtml(
  graph: LocationGraphData,
  mode: LocationDashboardMode,
  options: DashboardHtmlOptions = {}
): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  const dashboardColorsJson = JSON.stringify(DASHBOARD_COLOR_SCHEME).replace(/</g, "\\u003c");
  const includeSaveButton = options.includeSaveButton ?? true;
  const standaloneDarkMode = options.standaloneDarkMode ?? false;
  const rootCssVars = standaloneDarkMode
    ? `color-scheme: dark;
      --dashboard-bg: #0f1318;
      --dashboard-fg: #e7edf3;
      --dashboard-border: #2a3340;
      --dashboard-widget-bg: #181f28;
      --dashboard-description: #9aa7b8;
      --dashboard-tooltip-bg: rgba(21, 28, 36, 0.95);
      --dashboard-tooltip-fg: #f3f6fb;
      --dashboard-font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;`
    : `color-scheme: light dark;
      --dashboard-bg: var(--vscode-editor-background);
      --dashboard-fg: var(--vscode-editor-foreground);
      --dashboard-border: var(--vscode-panel-border);
      --dashboard-widget-bg: var(--vscode-editorWidget-background);
      --dashboard-description: var(--vscode-descriptionForeground);
      --dashboard-tooltip-bg: var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.95));
      --dashboard-tooltip-fg: var(--vscode-editorHoverWidget-foreground, #f0f0f0);
      --dashboard-font-family: var(--vscode-font-family, "Segoe UI", "Noto Sans", Arial, sans-serif);`;
  const saveButtonHtml = includeSaveButton ? '<button id="save-dashboard" class="save-button" type="button">Save</button>' : "";
  const modeJson = JSON.stringify(mode);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      ${rootCssVars}
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--dashboard-bg);
      color: var(--dashboard-fg);
      font-family: var(--dashboard-font-family);
      overflow: hidden;
    }
    .root {
      width: 100%;
      height: 100%;
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-tooltip-bg);
      color: var(--dashboard-tooltip-fg);
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
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      max-width: min(40vw, 420px);
      max-height: 45vh;
      overflow: auto;
    }
    .legend-title {
      margin: 0 0 6px 0;
      color: var(--dashboard-description);
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
    .save-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 120;
      border: 1px solid var(--dashboard-border);
      background: var(--dashboard-widget-bg);
      color: var(--dashboard-fg);
      border-radius: 6px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
  </style>
</head>
<body>
  ${saveButtonHtml}
  <div class="root">
    <svg id="graph"></svg>
  </div>
  <div id="tooltip" class="tooltip"></div>
  <div id="legend" class="legend"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const graph = ${graphJson};
    const dashboardColors = ${dashboardColorsJson};
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const svg = d3.select('#graph');
    const tooltip = document.getElementById('tooltip');
    const legend = document.getElementById('legend');
    const saveButton = document.getElementById('save-dashboard');
    if (saveButton && vscodeApi) {
      saveButton.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveDashboard' });
      });
    }
    if (saveButton && !vscodeApi) {
      saveButton.style.display = 'none';
    }

    const locationMode = ${modeJson};
    let width = 0;
    let height = 0;
    let dragging = false;
    const isHierarchyMode = locationMode === 'hierarchy';
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const palette = dashboardColors.categoricalPalette;
    const regionLinkColor = dashboardColors.location.regionLink;
    const adjacentLinkColor = dashboardColors.location.adjacentLink;
    const regionLinkStrength = 0.21;
    const adjacentLinkStrength = regionLinkStrength / 5;
    const dimmedLinkOpacity = locationMode === 'hierarchy' ? 0.16 : 0.06;
    const dimmedLinkWidth = 0.9;
    const highlightedLinkOpacity = 1;
    const highlightedLinkWidth = 2.8;
    const nodeColorGroupById = new Map();
    const legendRows = [];

    if (isHierarchyMode) {
      const regionGroups = Array.from(new Set(graph.nodes.map((node) => node.regionGroup))).sort((a, b) => a.localeCompare(b));
      for (const node of graph.nodes) {
        nodeColorGroupById.set(node.id, node.regionGroup);
      }
      for (const regionGroup of regionGroups) {
        legendRows.push({ key: regionGroup, label: regionGroup });
      }
    } else {
      const neighbors = new Map(graph.nodes.map((node) => [node.id, []]));
      for (const edge of graph.links) {
        const sourceId = typeof edge.source === 'string' ? edge.source : edge.source.id;
        const targetId = typeof edge.target === 'string' ? edge.target : edge.target.id;
        if (!neighbors.has(sourceId) || !neighbors.has(targetId)) {
          continue;
        }
        neighbors.get(sourceId).push(targetId);
        neighbors.get(targetId).push(sourceId);
      }

      const visited = new Set();
      let componentCount = 0;
      for (const node of graph.nodes) {
        if (visited.has(node.id)) {
          continue;
        }
        componentCount += 1;
        const componentKey = 'component:' + componentCount;
        const queue = [node.id];
        let queueIndex = 0;
        let size = 0;
        visited.add(node.id);
        while (queueIndex < queue.length) {
          const currentId = queue[queueIndex];
          queueIndex += 1;
          size += 1;
          nodeColorGroupById.set(currentId, componentKey);
          for (const neighborId of neighbors.get(currentId) || []) {
            if (visited.has(neighborId)) {
              continue;
            }
            visited.add(neighborId);
            queue.push(neighborId);
          }
        }
        legendRows.push({ key: componentKey, label: 'Component ' + componentCount + ' (' + size + ')' });
      }
    }

    const colorGroups = legendRows.map((row) => row.key);
    const nodeColor = d3.scaleOrdinal(colorGroups, palette);

    function nodeFill(node) {
      const groupKey = nodeColorGroupById.get(node.id) || '__unassigned__';
      return nodeColor(groupKey);
    }

    function setSize() {
      const rect = document.body.getBoundingClientRect();
      width = Math.max(300, rect.width);
      height = Math.max(300, rect.height);
      svg.attr('viewBox', [0, 0, width, height]);
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

    function formatAdjacent(adjacent) {
      if (!Array.isArray(adjacent) || adjacent.length === 0) {
        return '(none)';
      }
      return adjacent.join(', ');
    }

    function renderLegend() {
      legend.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'legend-title';
      title.textContent = isHierarchyMode ? 'Region Family' : 'Connected Geography Components';
      legend.appendChild(title);

      for (const rowData of legendRows) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = nodeColor(rowData.key);
        const label = document.createElement('span');
        label.textContent = rowData.label;
        row.appendChild(swatch);
        row.appendChild(label);
        legend.appendChild(row);
      }
    }

    setSize();
    renderLegend();

    const regionArrowId = 'locations-region-arrow';
    if (isHierarchyMode) {
      const defs = svg.append('defs');
      defs
        .append('marker')
        .attr('id', regionArrowId)
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 7.2)
        .attr('refY', 0)
        .attr('markerWidth', 5)
        .attr('markerHeight', 5)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L8,0L0,4')
        .attr('fill', regionLinkColor);
    }

    const container = svg.append('g');
    const linkLayer = container.append('g').attr('fill', 'none');
    const nodeLayer = container.append('g');
    const labelLayer = container.append('g');

    const zoom = d3.zoom()
      .scaleExtent([0.2, 3.5])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
        hideTooltip();
        resetLocationLinkHighlight();
      });
    svg.call(zoom);

    function linkEndId(linkEnd) {
      return typeof linkEnd === 'string' ? linkEnd : linkEnd.id;
    }

    function defaultLocationLinkOpacity(linkDatum) {
      return isHierarchyMode ? 0.64 : 0.08;
    }

    function defaultLocationLinkWidth(linkDatum) {
      return isHierarchyMode ? 1.7 : 1.0;
    }

    const link = linkLayer
      .selectAll('line')
      .data(graph.links, (d) => d.id)
      .join('line')
      .attr('stroke', () => (isHierarchyMode ? regionLinkColor : adjacentLinkColor))
      .attr('stroke-opacity', (d) => defaultLocationLinkOpacity(d))
      .attr('stroke-width', (d) => defaultLocationLinkWidth(d))
      .attr('marker-end', () => (isHierarchyMode ? 'url(#' + regionArrowId + ')' : null))
      .on('mouseover', (event, d) => {
        if (dragging) return;
        const sourceId = linkEndId(d.source);
        const targetId = linkEndId(d.target);
        const sourceName = nodeById.get(sourceId)?.name || sourceId;
        const targetName = nodeById.get(targetId)?.name || targetId;
        if (d.linkKind === 'region') {
          showTooltip(event, ['Region Link', sourceName + ' -> ' + targetName]);
          return;
        }
        showTooltip(event, ['Geography Connection', sourceName + ' <-> ' + targetName]);
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
      .attr('r', 8.4)
      .attr('fill', (d) => nodeFill(d))
      .attr('stroke', 'rgba(0,0,0,0.45)')
      .attr('stroke-width', 1)
      .on('mouseover', (event, d) => {
        if (dragging) return;
        showTooltip(event, [
          d.name,
          d.region ? 'Region: ' + d.region : 'Region: (none)',
          (isHierarchyMode ? 'Connected locations: ' : 'Connected in geography: ') + formatAdjacent(d.adjacent),
          d.description ? 'Description: ' + d.description : 'Description: (none)',
          'Mentions: ' + formatMentions(d.mentions)
        ]);
      })
      .on('mousemove', (event) => {
        if (dragging || tooltip.style.display !== 'block') return;
        positionTooltip(event);
      })
      .on('mouseout', hideTooltip);

    const nodeLabel = labelLayer
      .selectAll('text')
      .data(graph.nodes, (d) => d.id)
      .join('text')
      .attr('font-size', 11)
      .attr('fill', 'var(--dashboard-fg)')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none')
      .text((d) => d.name);

    function resetLocationLinkHighlight() {
      link
        .attr('stroke-opacity', (d) => defaultLocationLinkOpacity(d))
        .attr('stroke-width', (d) => defaultLocationLinkWidth(d));
    }

    function highlightLocationLinksForNode(nodeId) {
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

    const simulation = d3.forceSimulation(graph.nodes)
      .alphaDecay(0.0023)
      .force(
        'link',
        d3
          .forceLink(graph.links)
          .id((d) => d.id)
          .distance(() => (isHierarchyMode ? 82 : 120))
          .strength(() => (isHierarchyMode ? regionLinkStrength : adjacentLinkStrength))
      )
      .force('charge', d3.forceManyBody().strength(-170))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX(width / 2).strength(0.018))
      .force('y', d3.forceY(height / 2).strength(0.018))
      .force('collision', d3.forceCollide(18))
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

    window.addEventListener('resize', () => {
      setSize();
      simulation.force('center', d3.forceCenter(width / 2, height / 2));
      simulation.force('x', d3.forceX(width / 2).strength(0.018));
      simulation.force('y', d3.forceY(height / 2).strength(0.018));
      simulation.alpha(0.35).restart();
      hideTooltip();
      resetLocationLinkHighlight();
    });

    const drag = d3.drag()
      .on('start', (event, d) => {
        dragging = true;
        hideTooltip();
        highlightLocationLinksForNode(d.id);
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        hideTooltip();
        highlightLocationLinksForNode(d.id);
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        dragging = false;
        hideTooltip();
        resetLocationLinkHighlight();
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
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
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "geography.yaml"), "{}\n", summary, workspaceRoot);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "events.yaml"), "{}\n", summary, workspaceRoot);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "relationships.yaml"), "{}\n", summary, workspaceRoot);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "documents.yaml"), "{}\n", summary, workspaceRoot);

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
  await ensureGitignoreEntry(workspaceRoot, ".DS_Store", summary);
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
type SaveDashboardMessage = { type: "saveDashboard" };
type TimelineModeMessage = { type: "setTimelineMode" | "timelineModeChanged"; mode: TimelineDashboardMode };
type VonnegutModeMessage = { type: "setVonnegutMode" | "vonnegutModeChanged"; mode: VonnegutDashboardMode };

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

function isSaveDashboardMessage(value: unknown): value is SaveDashboardMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (value as { type?: unknown }).type === "saveDashboard";
}

function isTimelineModeChangedMessage(value: unknown): value is TimelineModeMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value as { type?: unknown; mode?: unknown };
  return maybe.type === "timelineModeChanged" && (maybe.mode === "event" || maybe.mode === "document");
}

function isVonnegutModeChangedMessage(value: unknown): value is VonnegutModeMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value as { type?: unknown; mode?: unknown };
  return maybe.type === "vonnegutModeChanged" && (maybe.mode === "event" || maybe.mode === "document");
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
        "-",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox"
      ]
    : [
        "exec",
        "-",
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
      },
      prompt
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
  onStderrLine: (line: string) => void,
  stdinText?: string
): Promise<CommandResult> {
  let spawnCommand = command;
  let spawnArgs = args;
  if (process.platform === "win32" && isCmdScript(command)) {
    const powershell = await resolvePowerShellExecutable();
    spawnCommand = powershell;
    spawnArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildPowerShellInvocation(command, args)];
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(spawnCommand, spawnArgs, { cwd, stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
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

    if (!child.stdout || !child.stderr) {
      reject(new Error("Failed to initialize child process output streams."));
      return;
    }

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

    if (stdinText !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // Ignore EPIPE and similar errors if the subprocess closes stdin early.
      });
      child.stdin.end(stdinText);
    }

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

function parseEventPartyNames(value: unknown): string[] {
  return toUniqueStrings(parseEventParties(value).map((party) => party.name));
}

function parseEventParties(value: unknown): Array<{ name: string; role: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const parties: Array<{ name: string; role: string }> = [];
  for (const item of value) {
    const partyRecord = asRecord(item);
    for (const [partyName, partyValue] of Object.entries(partyRecord)) {
      const normalizedPartyName = asOptionalString(partyName);
      if (!normalizedPartyName) {
        continue;
      }
      const partyDetails = asRecord(partyValue);
      const role = asOptionalString(partyDetails["role"]);
      if (role) {
        parties.push({ name: normalizedPartyName, role });
      }
    }
  }

  return parties;
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

function toCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map((cell) => toCsvCell(cell)).join(",")).join("\n")}\n`;
}

function toCsvCell(value: string): string {
  const normalized = value ?? "";
  if (!/[",\n\r]/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, "\"\"")}"`;
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
