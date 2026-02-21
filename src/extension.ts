import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

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

  await vscode.window.showInformationMessage(
    "Burbage setup complete:\n" + summary.map((item) => `- ${item}`).join("\n")
  );
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
  if (process.platform === "win32" && isCmdScript(command)) {
    const powershell = await resolvePowerShellExecutable();
    const script = buildPowerShellInvocation(command, args);
    await execFile(
      powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { cwd }
    );
    return;
  }

  await execFile(command, args, { cwd });
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
  try {
    await fs.access(commandPath);
    await execCommand(commandPath, ["--version"], cwd);
    return true;
  } catch {
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
