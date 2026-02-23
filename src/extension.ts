import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile as execFileCb } from "node:child_process";
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
      await openRelationshipDashboard();
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

async function openRelationshipDashboard(): Promise<void> {
  try {
    const workspaceRoot = getWorkspaceRootOrThrow();
    const entities = await resolveEntitiesDirectory(workspaceRoot);
    const charactersPath = path.join(entities.dirPath, "characters.yaml");
    const relationshipsPath = path.join(entities.dirPath, "relationships.yaml");

    const [charactersRaw, relationshipsRaw] = await Promise.all([
      fs.readFile(charactersPath, "utf8"),
      fs.readFile(relationshipsPath, "utf8")
    ]);

    const graph = buildRelationshipGraph(parseYaml(charactersRaw), parseYaml(relationshipsRaw), entities.sourceLabel);
    const panel = vscode.window.createWebviewPanel(
      "burbage.relationshipDashboard",
      "Burbage: Relationship Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = getRelationshipDashboardHtml(graph);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open relationship dashboard: ${message}`);
  }
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

    const zoom = d3.zoom()
      .scaleExtent([0.2, 3.5])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
        hideTooltip();
      });
    svg.call(zoom);

    const link = linkLayer
      .selectAll('line')
      .data(graph.links, (d) => d.id)
      .join('line')
      .attr('stroke-width', 1.8)
      .on('mouseover', (event, d) => {
        if (dragging) return;
        showTooltip(event, [
          'Relationship: ' + d.relationshipType,
          'Formation: ' + d.formation,
          'Status: ' + d.status,
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

    const simulation = d3.forceSimulation(graph.nodes)
      .force('link', d3.forceLink(graph.links).id((d) => d.id).distance(82).strength(0.35))
      .force('charge', d3.forceManyBody().strength(-130))
      .force('center', d3.forceCenter(width / 2, height / 2))
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
      });

    const drag = d3.drag()
      .on('start', (event, d) => {
        dragging = true;
        hideTooltip();
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        hideTooltip();
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        dragging = false;
        hideTooltip();
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
    void this.view.webview.postMessage({ type: "status", text: "Running Codex..." });

    try {
      const result = await runCodexPrompt(normalized, workspaceRoot, this.threadId);
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

function getSidebarHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); margin: 0; padding: 0; }
    .root { display: grid; grid-template-rows: auto 1fr auto auto; height: 100vh; }
    .actions { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; }
    .transcript { padding: 12px; overflow-y: auto; }
    .message { white-space: pre-wrap; margin: 0 0 10px 0; padding: 10px; border-radius: 6px; }
    .message.user { background: var(--vscode-editor-inactiveSelectionBackground); }
    .message.assistant { background: var(--vscode-sideBar-background); }
    .message.error { background: var(--vscode-inputValidation-errorBackground); }
    .composer { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
    textarea { resize: vertical; min-height: 60px; max-height: 200px; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 4px; }
    button { font: inherit; padding: 0 14px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .status { min-height: 20px; padding: 0 12px 10px 12px; color: var(--vscode-descriptionForeground); }
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
      <button id="send">Send</button>
    </div>
    <div id="status" class="status"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const transcript = document.getElementById("transcript");
    const promptEl = document.getElementById("prompt");
    const sendBtn = document.getElementById("send");
    const syncBtn = document.getElementById("sync");
    const statusEl = document.getElementById("status");

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

    sendBtn.addEventListener("click", send);
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
      if (msg.type === "assistant") addMessage("assistant", msg.text || "");
      if (msg.type === "error") addMessage("error", msg.text || "Unknown error");
      if (msg.type === "status") statusEl.textContent = msg.text || "";
    });
  </script>
</body>
</html>`;
}

async function runCodexPrompt(
  prompt: string,
  workspaceRoot: string,
  threadId?: string
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

  let result: CommandResult;
  try {
    result = await execCommandCapture(codexCommand, args, workspaceRoot);
  } catch (error) {
    throw new Error(formatExecError("Codex command failed.", error));
  }

  const parsed = parseCodexJsonEvents(result.stdout);
  const lastMessage = parsed.lastAssistantMessage?.trim() ?? "";
  const returnedThreadId = parsed.threadId;

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
