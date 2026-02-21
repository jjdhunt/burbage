import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

type FileAction = "skip" | "replace" | "merge";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("burbage.setup", async () => {
      await runSetupProject(context);
    }),
    vscode.commands.registerCommand("burbage.sync", async () => {
      vscode.window.showInformationMessage("Burbage sync is not implemented yet.");
    }),
    vscode.commands.registerCommand("burbage.openChat", async () => {
      vscode.window.showInformationMessage("Burbage chat is not implemented yet.");
    }),
    vscode.commands.registerCommand("burbage.openRelationshipDashboard", async () => {
      vscode.window.showInformationMessage("Relationship dashboard is not implemented yet.");
    })
  );
}

export function deactivate(): void {
  // No background resources yet.
}

async function runSetupProject(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a folder/workspace before running Burbage setup.");
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const summary: string[] = [];

  await ensureDirectory(path.join(workspaceRoot, "Manuscript"), summary);
  await ensureDirectory(path.join(workspaceRoot, "Entities"), summary);
  await ensureDirectory(path.join(workspaceRoot, ".vscode"), summary);

  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "characters.yaml"), "{}\n", summary);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "locations.yaml"), "{}\n", summary);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "events.yaml"), "{}\n", summary);
  await ensureFileIfMissing(path.join(workspaceRoot, "Entities", "relationships.yaml"), "{}\n", summary);

  await ensureGitRepo(workspaceRoot, summary);

  await copyTemplateWithPrompt({
    templatePath: path.join(context.extensionPath, "AGENTS_burbage.md"),
    destinationPath: path.join(workspaceRoot, "AGENTS.md"),
    summary,
    mergeMode: "append"
  });

  await copyTemplateWithPrompt({
    templatePath: path.join(context.extensionPath, "settings_burbage.json"),
    destinationPath: path.join(workspaceRoot, ".vscode", "settings.json"),
    summary,
    mergeMode: "json-defaults"
  });

  await vscode.window.showInformationMessage(
    "Burbage setup complete:\n" + summary.map((item) => `- ${item}`).join("\n")
  );
}

async function ensureDirectory(dirPath: string, summary: string[]): Promise<void> {
  if (await pathExists(dirPath)) {
    summary.push(`${relativeToCwd(dirPath)} already exists`);
    return;
  }

  await fs.mkdir(dirPath, { recursive: true });
  summary.push(`Created ${relativeToCwd(dirPath)}`);
}

async function ensureFileIfMissing(filePath: string, contents: string, summary: string[]): Promise<void> {
  if (await pathExists(filePath)) {
    summary.push(`${relativeToCwd(filePath)} already exists`);
    return;
  }

  await fs.writeFile(filePath, contents, "utf8");
  summary.push(`Created ${relativeToCwd(filePath)}`);
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

async function copyTemplateWithPrompt(options: {
  templatePath: string;
  destinationPath: string;
  summary: string[];
  mergeMode: "append" | "json-defaults";
}): Promise<void> {
  const { templatePath, destinationPath, summary, mergeMode } = options;

  if (!(await pathExists(templatePath))) {
    summary.push(`Template missing: ${relativeToCwd(templatePath)}`);
    return;
  }

  const templateContent = await fs.readFile(templatePath, "utf8");

  if (!(await pathExists(destinationPath))) {
    await fs.writeFile(destinationPath, templateContent, "utf8");
    summary.push(`Created ${relativeToCwd(destinationPath)} from template`);
    return;
  }

  const action = await promptFileAction(destinationPath);
  if (!action || action === "skip") {
    summary.push(`Skipped existing ${relativeToCwd(destinationPath)}`);
    return;
  }

  if (action === "replace") {
    await fs.writeFile(destinationPath, templateContent, "utf8");
    summary.push(`Replaced ${relativeToCwd(destinationPath)} from template`);
    return;
  }

  if (mergeMode === "append") {
    const existing = await fs.readFile(destinationPath, "utf8");
    if (existing.includes(templateContent.trim())) {
      summary.push(`${relativeToCwd(destinationPath)} already contains template content`);
      return;
    }

    const merged = `${existing.trimEnd()}\n\n---\n\n${templateContent.trim()}\n`;
    await fs.writeFile(destinationPath, merged, "utf8");
    summary.push(`Merged template into ${relativeToCwd(destinationPath)} (append mode)`);
    return;
  }

  const existingSettingsRaw = await fs.readFile(destinationPath, "utf8");
  const mergedJson = mergeJsonDefaults(templateContent, existingSettingsRaw);
  if (!mergedJson) {
    summary.push(`Could not merge ${relativeToCwd(destinationPath)} (invalid JSON)`);
    return;
  }

  await fs.writeFile(destinationPath, `${JSON.stringify(mergedJson, null, 2)}\n`, "utf8");
  summary.push(`Merged template into ${relativeToCwd(destinationPath)} (json defaults mode)`);
}

function mergeJsonDefaults(templateRaw: string, existingRaw: string): Record<string, unknown> | undefined {
  try {
    const template = JSON.parse(templateRaw) as Record<string, unknown>;
    const existing = JSON.parse(existingRaw) as Record<string, unknown>;
    return deepMerge(template, existing) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    result[key] = deepMerge(baseValue, overrideValue);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function promptFileAction(destinationPath: string): Promise<FileAction | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      { label: "Skip", description: "Keep existing file", action: "skip" as const },
      { label: "Merge", description: "Merge template into existing file", action: "merge" as const },
      { label: "Replace", description: "Overwrite existing file with template", action: "replace" as const }
    ],
    {
      title: "Burbage Setup",
      placeHolder: `${relativeToCwd(destinationPath)} already exists`,
      ignoreFocusOut: true
    }
  );

  return selected?.action;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function relativeToCwd(targetPath: string): string {
  return path.relative(process.cwd(), targetPath) || targetPath;
}
