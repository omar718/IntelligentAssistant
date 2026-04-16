import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import {
  startServer,
  stopServer,
  isServerRunning,
  registerOpenFolderCallback,
  registerPickFolderCallback,
} from './services/server';
import { getAvailableModels } from './services/llmService';
import { AuthManager } from './authManager';
import { ProjectWebSocket } from './projectWebSocket';
import { LocalInstaller, type RuntimeMissingInfo, type ConflictResolutionChoice, type ConflictResolutionInfo } from './localInstaller';
import { ApiOutputViewProvider } from './webviews/apiOutputProvider';


let authManager: AuthManager;
let lastRunningUrl: string | undefined;
const launchedProjects = new Map<string, ChildProcess>();
let pendingConflictResolver: ((choice: ConflictResolutionChoice) => void) | undefined;

const PENDING_INSTALL_KEY = 'pendingInstallProjectId';
const LAST_PICKED_FOLDER_KEY = 'lastPickedCloneFolder';
const PENDING_FOLDER_PATH_KEY = 'pendingInstallFolderPath';
const DEFAULT_RUNNING_URL = 'http://localhost:8998';

function getConfiguredRunningUrl(): string {
  const config = vscode.workspace.getConfiguration('projectAssistant');
  return config.get<string>('runningUrl') ?? DEFAULT_RUNNING_URL;
}

function resolveRunningUrl(port?: number): string {
  const configuredUrl = getConfiguredRunningUrl();

  if (port === undefined) {
    return configuredUrl;
  }

  try {
    const parsed = new URL(configuredUrl);
    parsed.port = String(port);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return `http://localhost:${port}`;
  }
}

async function waitForProjectPort(port: number, timeoutMs: number = 45_000): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_500);
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok || response.status >= 200) {
        return true;
      }
    } catch {
      // keep polling until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function launchInstalledProject(
  auth: AuthManager,
  projectId: string,
  outputChannel: vscode.OutputChannel,
): Promise<{ url?: string; port?: number }> {
  const mapContainerPathToHost = (rawPath: string): string => {
    const normalized = rawPath.replace(/\\/g, '/');

    if (normalized.startsWith('/hostusers/')) {
      const suffix = normalized.slice('/hostusers/'.length);
      return path.join('C:/Users', suffix);
    }

    if (normalized.startsWith('/tmp/intelligent-assistant/')) {
      const suffix = normalized.slice('/tmp/intelligent-assistant/'.length);
      return path.join('C:/tmp/intelligent-assistant', suffix);
    }

    return rawPath;
  };

  if (launchedProjects.has(projectId)) {
    outputChannel.appendLine(`[Launch] Project ${projectId} is already launched in this session.`);
    return {};
  }

  const projectResponse = await auth.getPublicApiClient().get<{
    id: string;
    path: string;
    type?: string | null;
    port?: number;
    metadata?: {
      host_path?: string;
      run_command?: string;
      launch_port?: number;
      detected_pm?: string;
      entry_point?: string;
      steps?: Array<{ action?: string; command?: string }>;
    };
  }>(`/api/projects/${projectId}/launch-info`);

  const project = projectResponse.data;
  const metadata = project.metadata ?? {};
  const hostPath = mapContainerPathToHost(metadata.host_path ?? project.path);
  const runCommand =
    metadata.run_command ??
    metadata.steps?.find((step) => step.action === 'run' && step.command)?.command ??
    (project.type === 'python' && metadata.entry_point ? `python ${metadata.entry_point}` : undefined) ??
    (project.type === 'nodejs' && metadata.entry_point ? `node ${metadata.entry_point}` : undefined) ??
    (metadata.detected_pm === 'npm' ? 'npm start' : undefined);

  const launchPort =
    metadata.launch_port ??
    project.port ??
    (project.type === 'python' ? 8000 : project.type === 'nodejs' ? 3000 : undefined);

  if (!hostPath) {
    throw new Error('Missing project path for launch');
  }

  if (!fs.existsSync(hostPath)) {
    throw new Error(`Launch path not found on host: ${hostPath}`);
  }

  if (!runCommand) {
    throw new Error('Missing run command for launch');
  }

  outputChannel.appendLine(`[Launch] Starting project ${projectId}`);
  outputChannel.appendLine(`[Launch] cwd=${hostPath}`);
  outputChannel.appendLine(`[Launch] command=${runCommand}`);

  const child = spawn(runCommand, {
    cwd: hostPath,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  launchedProjects.set(projectId, child);

  let spawnError: string | undefined;

  child.on('error', (err) => {
    spawnError = err.message;
    outputChannel.appendLine(`[Launch][error] ${err.message}`);
  });

  child.stdout.on('data', (chunk) => {
    outputChannel.appendLine(`[Launch][stdout] ${chunk.toString().trimEnd()}`);
  });

  child.stderr.on('data', (chunk) => {
    outputChannel.appendLine(`[Launch][stderr] ${chunk.toString().trimEnd()}`);
  });

  child.on('exit', (code, signal) => {
    launchedProjects.delete(projectId);
    outputChannel.appendLine(`[Launch] Process exited (code=${code ?? 'n/a'}, signal=${signal ?? 'n/a'})`);
  });

  child.unref();

  if (spawnError) {
    launchedProjects.delete(projectId);
    throw new Error(`Failed to start process: ${spawnError}`);
  }

  if (launchPort) {
    const ready = await waitForProjectPort(launchPort);
    if (spawnError) {
      launchedProjects.delete(projectId);
      throw new Error(`Failed to start process: ${spawnError}`);
    }
    if (!ready) {
      throw new Error(`Project started but port ${launchPort} did not become ready in time`);
    }
    return { url: resolveRunningUrl(launchPort), port: launchPort };
  }

  return { url: resolveRunningUrl(undefined), port: undefined };
}

async function getPendingInstallId(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.globalState.get<string>(PENDING_INSTALL_KEY);
}

async function setPendingInstallId(
  context: vscode.ExtensionContext,
  projectId: string | undefined
): Promise<void> {
  await context.globalState.update(PENDING_INSTALL_KEY, projectId);
}

async function setPendingInstallFolderPath(
  context: vscode.ExtensionContext,
  folderPath: string | undefined
): Promise<void> {
  await context.globalState.update(PENDING_FOLDER_PATH_KEY, folderPath);
}

async function getPendingInstallFolderPath(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  return context.globalState.get<string>(PENDING_FOLDER_PATH_KEY);
}

async function inferProjectIdFromFolder(
  auth: AuthManager,
  folderPath: string,
  outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
  if (!auth.isAuthenticated()) {
    return undefined;
  }

  const folderName = path.basename(folderPath).trim().toLowerCase();
  if (!folderName) {
    return undefined;
  }

  try {
    const res = await auth
      .getApiClient()
      .get<{ items: Array<{ id: string; name: string }> }>('/api/users/me/projects', {
        params: { per_page: 100 },
      });

    const exactMatch = res.data.items.find((p) => p.name?.trim().toLowerCase() === folderName);
    if (exactMatch?.id) {
      outputChannel.appendLine(
        `[OpenFolder] Inferred projectId ${exactMatch.id} from folder name "${path.basename(folderPath)}".`
      );
      return exactMatch.id;
    }
  } catch (err: any) {
    outputChannel.appendLine(
      `[OpenFolder] Could not infer projectId from API: ${err?.message ?? 'unknown error'}`
    );
  }

  return undefined;
}

async function promptProjectIdSelection(
  auth: AuthManager,
  folderPath: string,
): Promise<string | undefined> {
  if (!auth.isAuthenticated()) {
    return undefined;
  }

  try {
    const res = await auth
      .getApiClient()
      .get<{ items: Array<{ id: string; name: string }> }>('/api/users/me/projects', {
        params: { per_page: 100 },
      });

    if (!res.data.items.length) {
      return undefined;
    }

    const folderName = path.basename(folderPath).trim().toLowerCase();
    const sorted = [...res.data.items].sort((a, b) => {
      const aScore = a.name.trim().toLowerCase() === folderName ? 0 : 1;
      const bScore = b.name.trim().toLowerCase() === folderName ? 0 : 1;
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      return a.name.localeCompare(b.name);
    });

    const picked = await vscode.window.showQuickPick(
      sorted.map((p) => ({
        label: p.name,
        description: p.id,
        projectId: p.id,
      })),
      {
        title: `Select project for folder ${path.basename(folderPath)}`,
        placeHolder: 'Choose the project to install',
        ignoreFocusOut: true,
      }
    );

    return picked?.projectId;
  } catch {
    return undefined;
  }
}

function createMirroredOutputChannel(
  channel: vscode.OutputChannel,
  ui: ApiOutputViewProvider,
): vscode.OutputChannel {
  const mirrored = channel as vscode.OutputChannel & {
    appendLine: (value: string) => void;
    clear: () => void;
    show: (columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean) => void;
  };

  const originalAppendLine = mirrored.appendLine.bind(channel);
  const originalClear = mirrored.clear.bind(channel);

  mirrored.appendLine = (message: string) => {
    originalAppendLine(message);
    ui.appendLine(message, inferLogLevel(message));
  };

  mirrored.clear = () => {
    originalClear();
    ui.clear();
  };

  mirrored.show = () => {
    void vscode.commands.executeCommand('workbench.view.extension.project-assistant-sidebar');
  };

  return channel;
}

function inferLogLevel(message: string): 'info' | 'warning' | 'error' | 'success' {
  const normalized = message.toLowerCase();
  if (normalized.includes('[error]') || normalized.includes('[ws] error') || normalized.includes('failed')) {
    return 'error';
  }
  if (normalized.includes('[warning]') || normalized.includes('[warn]') || normalized.includes('stalled')) {
    return 'warning';
  }
  if (normalized.includes('completed') || normalized.includes('successfully') || normalized.includes('running on')) {
    return 'success';
  }
  return 'info';
}

export async function activate(context: vscode.ExtensionContext) {  // ← THIS WAS MISSING

  // ─── Output Channel ───────────────────────────────────────────────────────
  const apiOutputProvider = new ApiOutputViewProvider(context.extensionUri, (action, payload) => {
    switch (action) {
      case 'login':
        void vscode.commands.executeCommand('project-assistant.login');
        return;
      case 'logout':
        void vscode.commands.executeCommand('project-assistant.logout');
        return;
      case 'openInstallGuide':
        if (payload) {
          void vscode.env.openExternal(vscode.Uri.parse(payload));
        }
        return;
      case 'chooseDocker':
        if (pendingConflictResolver) {
          pendingConflictResolver('docker');
          pendingConflictResolver = undefined;
        }
        return;
      case 'retryConflict':
        if (pendingConflictResolver) {
          pendingConflictResolver('manual');
          pendingConflictResolver = undefined;
        }
        return;
    }
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ApiOutputViewProvider.viewType, apiOutputProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const outputChannel = createMirroredOutputChannel(
    vscode.window.createOutputChannel('Project Assistant API'),
    apiOutputProvider,
  );
  context.subscriptions.push(outputChannel);

  // ─── Status Bar ───────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  // ─── API Info Helper ──────────────────────────────────────────────────────
  const showApiInfo = (port: number) => {
    outputChannel.clear();
    outputChannel.appendLine(`URL: http://localhost:${port}/Mobelite/chat`);
    outputChannel.appendLine(' Method: POST');
    outputChannel.appendLine('--------------------------------------------------');
    outputChannel.appendLine('Request Body (JSON):');
    outputChannel.appendLine(JSON.stringify({ prompt: 'Your prompt here...' }, null, 2));
    outputChannel.appendLine('--------------------------------------------------');
    outputChannel.appendLine('Expected Response (JSON):');
    outputChannel.appendLine(
      JSON.stringify({ result: 'The refined or generated response text.' }, null, 2)
    );
    outputChannel.appendLine('--------------------------------------------------');
    outputChannel.show();
  };

  // ─── Online / Offline Callbacks ───────────────────────────────────────────
  let pendingInstallHandled = false;
  let pendingInstallInProgress = false;

  const maybeResumePendingInstall = async () => {
    if (pendingInstallHandled || pendingInstallInProgress) {
      return;
    }

    pendingInstallInProgress = true;

    try {
      const pendingId = await getPendingInstallId(context);
      if (!pendingId) {
        const pendingFolderPath = await getPendingInstallFolderPath(context);
        if (!pendingFolderPath) {
          return;
        }

        const action = await vscode.window.showWarningMessage(
          `Project opened from ${path.basename(pendingFolderPath)} without project id. Enter a project id to continue installation.`,
          'Enter Project ID',
          'Open Output',
          'Dismiss',
        );

        if (action === 'Open Output') {
          outputChannel.show(true);
        }

        if (action !== 'Enter Project ID') {
          return;
        }

        const manualProjectId = await vscode.window.showInputBox({
          title: 'Continue installation',
          prompt: 'Enter project id',
          placeHolder: 'proj_xxxxxxxx',
          ignoreFocusOut: true,
        });

        if (!manualProjectId?.trim()) {
          vscode.window.showWarningMessage('No project id entered. Installation remains pending.');
          return;
        }

        await setPendingInstallId(context, manualProjectId.trim());
        outputChannel.appendLine(
          `[Install] Manually linked pending folder ${pendingFolderPath} to project ${manualProjectId.trim()}`
        );
        await setPendingInstallFolderPath(context, undefined);
        return maybeResumePendingInstall();
      }

      await setPendingInstallFolderPath(context, undefined);
      if (!pendingId) {
        return;
      }

      outputChannel.appendLine(`[Install] Resuming pending installation for project ${pendingId}`);
      const started = await triggerInstallFromExtension(
        context,
        pendingId,
        authManager,
        outputChannel,
        statusBar,
        apiOutputProvider,
        true,
      );
      pendingInstallHandled = started;
    } finally {
      pendingInstallInProgress = false;
    }
  };

  const onOnline = async () => {
    statusBar.text = '$(check) Project Assistant ready';
    statusBar.backgroundColor = undefined;
    statusBar.command = undefined;
    statusBar.show();

    await maybeResumePendingInstall();
  };

  const onOffline = () => {
  };

  // ─── Auth Manager ─────────────────────────────────────────────────────────
  authManager = new AuthManager(
    context,
    statusBar,
    onOnline,
    onOffline,
    (message, level) => apiOutputProvider.appendLine(`[Auth] ${message}`, level ?? 'info')
  );

  // ─── Auto-Launch Logic ────────────────────────────────────────────────────
  if (!authManager.isAuthenticated()) {
    showOptionalLoginPrompt();
  }

  // ─── Folder Callbacks ─────────────────────────────────────────────────────
  registerOpenFolderCallback((folderPath: string, projectId?: string) => {
    void (async () => {
      try {
        outputChannel.appendLine(`[OpenFolder] Requested path: ${folderPath}`);

        const normalizePath = (value: string) => value.replace(/\\/g, '/').toLowerCase();
        const pathExists = async (targetPath: string): Promise<boolean> => {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
            return true;
          } catch {
            return false;
          }
        };

        let resolvedFolderPath = folderPath;
        const lastPickedFolder = context.globalState.get<string>(LAST_PICKED_FOLDER_KEY);
        if (lastPickedFolder) {
          const candidatePath = path.join(lastPickedFolder, path.basename(folderPath));
          const providedExists = await pathExists(folderPath);
          const candidateExists = await pathExists(candidatePath);
          const requestedParent = normalizePath(path.dirname(folderPath));
          const homeDir = normalizePath(os.homedir());

          // If backend sends ~/repo but user picked another destination, prefer the picked destination.
          if (
            candidateExists &&
            normalizePath(candidatePath) !== normalizePath(folderPath) &&
            (!providedExists || requestedParent === homeDir)
          ) {
            resolvedFolderPath = candidatePath;
            outputChannel.appendLine(
              `[OpenFolder] Re-mapped to preferred clone path: ${resolvedFolderPath}`
            );
          }
        }

        const uri = vscode.Uri.file(resolvedFolderPath);

        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          vscode.window.showErrorMessage(`Folder does not exist: ${resolvedFolderPath}`);
          return;
        }

        const resolvedProjectId = projectId;

        if (resolvedProjectId) {
          await setPendingInstallId(context, resolvedProjectId);
          await setPendingInstallFolderPath(context, undefined);
          outputChannel.appendLine(
            `[OpenFolder] Pending install set for project ${resolvedProjectId}`
          );
        } else {
          await setPendingInstallFolderPath(context, resolvedFolderPath);
          outputChannel.appendLine('[OpenFolder] No projectId provided. Requesting manual project id.');

          const action = await vscode.window.showWarningMessage(
            'Project opened without project id. Enter it now to continue installation.',
            'Enter Project ID',
            'Open Output',
            'Skip',
          );

          if (action === 'Enter Project ID') {
            const manualProjectId = await vscode.window.showInputBox({
              title: 'Continue installation',
              prompt: 'Enter project id',
              placeHolder: 'proj_xxxxxxxx',
              ignoreFocusOut: true,
            });

            if (manualProjectId?.trim()) {
              await setPendingInstallId(context, manualProjectId.trim());
              await setPendingInstallFolderPath(context, undefined);
              outputChannel.appendLine(
                `[OpenFolder] Manual projectId captured: ${manualProjectId.trim()}`
              );
            } else {
              outputChannel.appendLine('[OpenFolder] Manual projectId entry was skipped or empty.');
            }
          } else if (action === 'Open Output') {
            outputChannel.show(true);
          }
        }

        const requested = normalizePath(uri.fsPath);
        const alreadyOpen = (vscode.workspace.workspaceFolders ?? []).some(
          (wf) => normalizePath(wf.uri.fsPath) === requested
        );

        if (alreadyOpen) {
          outputChannel.appendLine('[OpenFolder] Target already open. Reloading window...');
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        }

        // Open inside the current Extension Development Host window.
        try {
          await vscode.commands.executeCommand('vscode.openFolder', uri, {
            forceReuseWindow: true,
            noRecentEntry: true,
          });
        } catch {
          await vscode.commands.executeCommand('vscode.openFolder', uri, false);
        }
      } catch (err: any) {
        console.error('Error in openFolderCallback:', err);
        vscode.window.showErrorMessage(`Error opening folder: ${err?.message || 'Unknown error'}`);
      }
    })();
  });

  registerPickFolderCallback(async () => {
    try {
      // Add a timeout to prevent hanging
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => {
          console.warn('Folder picker timeout - returning null');
          resolve(null);
        }, 60000); // 60 second timeout
      });

      const pickerPromise = (async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select clone destination',
          title: 'Where should the repository be cloned?',
          defaultUri: vscode.Uri.file(os.homedir()),
        });
        console.log('Folder picker result:', uris);
        return uris && uris.length > 0 ? uris[0].fsPath : null;
      })();

      const result = await Promise.race([pickerPromise, timeoutPromise]);

      if (result) {
        await context.globalState.update(LAST_PICKED_FOLDER_KEY, result);
      }
      return result;
    } catch (err: any) {
      console.error('Folder picker error:', err);
      vscode.window.showErrorMessage(`Folder picker error: ${err.message}`);
      return null;
    }
  });

  // ─── Auto-start Server ────────────────────────────────────────────────────
  startServer(6009)
    .then((port) => {
      outputChannel.appendLine(`Project Assistant server auto-started on port ${port}`);
    })
    .catch((err: Error) => {
      if (!err.message.includes('already running')) {
        vscode.window.showWarningMessage(
          `Project Assistant: server could not start — ${err.message}`
        );
      }
    });

  // ─── Pre-fetch Models ─────────────────────────────────────────────────────
  getAvailableModels().catch(console.error);

  // ─── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('project-assistant.showApiInfo', (port: number) => {
      showApiInfo(port || 6009);
    }),
    vscode.commands.registerCommand('project-assistant.retryInstall', async () => {
      const pendingId = await getPendingInstallId(context);
      if (!pendingId) {
        vscode.window.showWarningMessage('No pending installation found.');
        return;
      }
      await triggerInstallFromExtension(
        context,
        pendingId,
        authManager,
        outputChannel,
        statusBar,
        apiOutputProvider,
        true,
      );
    }),

    vscode.commands.registerCommand('project-assistant.openBrowser', () => {
      const url = lastRunningUrl ?? getConfiguredRunningUrl();
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand(
      'project-assistant.startServer',
      async (port: number, modelId: string) => {
        try {
          const actualPort = await startServer(port, modelId);
          vscode.window
            .showInformationMessage(
              `Project Assistant Server started on port ${actualPort}`,
              'Show API Usage'
            )
            .then((selection) => {
              if (selection === 'Show API Usage') {
                showApiInfo(actualPort);
              }
            });
          return { success: true, port: actualPort };
        } catch (err) {
          const error = err as Error;
          vscode.window.showErrorMessage(`Failed to start server: ${error.message}`);
          return { success: false, error: error.message };
        }
      }
    ),

    vscode.commands.registerCommand('project-assistant.stopServer', async () => {
      try {
        await stopServer();
        vscode.window.showInformationMessage('Project Assistant Server stopped');
        return { success: true };
      } catch (err) {
        const error = err as Error;
        vscode.window.showErrorMessage(`Failed to stop server: ${error.message}`);
        return { success: false, error: error.message };
      }
    }),

    vscode.commands.registerCommand('project-assistant.getModels', async () => {
      return await getAvailableModels();
    }),

    vscode.commands.registerCommand('project-assistant.getServerStatus', () => {
      return { running: isServerRunning() };
    }),

    vscode.commands.registerCommand('project-assistant.inspectAuthState', async () => {
      try {
        const hasStoredToken = await authManager.hasStoredToken();
        const hasInMemoryToken = authManager.isAuthenticated();
        const summary = `Auth state — keychain: ${hasStoredToken ? 'present' : 'missing'}, memory: ${hasInMemoryToken ? 'present' : 'missing'}`;
        vscode.window.showInformationMessage(summary);
        return {
          success: true,
          hasStoredToken,
          hasInMemoryToken,
        };
      } catch (err: any) {
        const message = err?.message || 'Failed to inspect auth state';
        vscode.window.showErrorMessage(message);
        return { success: false, error: message };
      }
    }),

    vscode.commands.registerCommand('project-assistant.login', async () => {
      try {
        const email = await vscode.window.showInputBox({
          prompt: 'Enter your email',
          placeHolder: 'you@example.com',
          ignoreFocusOut: true,
        });
        if (!email) {
          return { success: false, cancelled: true };
        }

        const password = await vscode.window.showInputBox({
          prompt: 'Enter your password',
          password: true,
          ignoreFocusOut: true,
        });
        if (!password) {
          return { success: false, cancelled: true };
        }

        await authManager.login(email, password);
        await onOnline();
        vscode.window.showInformationMessage('Successfully signed in!');
        return { success: true };
      } catch (err: any) {
        const msg =
          err?.response?.status === 401
            ? 'Invalid email or password'
            : 'Login failed. Check the backend is running.';
        vscode.window.showErrorMessage(msg);
        return { success: false, error: msg };
      }
    }),

    vscode.commands.registerCommand('project-assistant.logout', async () => {
      try {
        await authManager.logout();
        return { success: true };
      } catch (err: any) {
        vscode.window.showErrorMessage('Logout failed');
        return { success: false, error: err?.message };
      }
    }),

    vscode.commands.registerCommand('project-assistant.retryConnection', async () => {
      try {
        const online = await authManager.checkHealth();
        if (online) {
          onOnline();
          return { success: true, online: true };
        } else {
          vscode.window.showWarningMessage('Backend still offline. Is the server running?');
          return { success: false, online: false };
        }
      } catch (err: any) {
        vscode.window.showErrorMessage('Connection check failed');
        return { success: false, error: err?.message };
      }
    })
  );

  // ─── Activate Auth ────────────────────────────────────────────────────────
  await authManager.activate();
  await maybeResumePendingInstall();

  vscode.window.showInformationMessage('Project Assistant activated');

} // ← closing brace for activate()

async function showOptionalLoginPrompt() {
  const selection = await vscode.window.showInformationMessage(
    "Welcome! Would you like to log in to sync your projects with DevLauncher?",
    "Log In",
    "Maybe Later"
  );

  if (selection === "Log In") {
    vscode.commands.executeCommand('project-assistant.login');
  }
}

async function triggerInstallFromExtension(
  context: vscode.ExtensionContext,
  projectId: string,
  auth: AuthManager,
  outputChannel: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  apiOutputProvider: ApiOutputViewProvider,
  requireConfirmation: boolean = true,
): Promise<boolean> {
  const apiUrl =
    vscode.workspace.getConfiguration('projectAssistant').get<string>('apiUrl') ??
    'http://localhost:8000';

  const apiClient = auth.getPublicApiClient();

  if (requireConfirmation) {
    const answer = await vscode.window.showInformationMessage(
      'Project cloned and analyzed. Start installation now?',
      'Install',
      'Not now',
    );
    if (answer !== 'Install') {
      statusBar.text = '$(package) Click to install project';
      statusBar.command = 'project-assistant.retryInstall';
      statusBar.show();
      await setPendingInstallId(context, projectId);
      return false;
    }
  }

  // ── Fire POST /api/projects/:id/install ────────────────────────
  let taskId: string | undefined;
  try {
    const res = await apiClient.post(`/api/projects/${projectId}/install`);
    taskId = res.data.task_id;
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.detail ?? err?.message ?? 'Unknown error';

    if (status === 401 && String(msg).toLowerCase().includes('invalid or expired token')) {
      const backendMsg =
        'Installation backend is still auth-protected. Restart/update backend to expose public install routes.';
      outputChannel.appendLine(`[Install] ${backendMsg}`);
      outputChannel.appendLine(
        '[Install] Expected endpoints: POST /api/projects/{id}/install (public), GET /api/projects/{id}/status (public).'
      );
      const action = await vscode.window.showErrorMessage(
        backendMsg,
        'Open Output',
        'Log In'
      );
      if (action === 'Open Output') {
        outputChannel.show(true);
      }
      if (action === 'Log In') {
        void vscode.commands.executeCommand('project-assistant.login');
      }
    } else {
      vscode.window.showErrorMessage(`Failed to start installation: ${msg}`);
    }

    await setPendingInstallId(context, projectId);
    return false;
  }

  await setPendingInstallId(context, undefined);
  await setPendingInstallFolderPath(context, undefined);

  outputChannel.show(false);
  outputChannel.appendLine(
    `[Assistant] Installation started — ${taskId ? `task ${taskId}` : `project ${projectId}`}`
  );
  statusBar.text = '$(sync~spin) Installing…';
  statusBar.command = undefined;
  statusBar.show();

  let installCompleted = false;
  let wsProgressEventCount = 0;
  let wsLogEventCount = 0;
  let lastPolledStatus: string | undefined;
  let lastPolledDetailSignature: string | undefined;
  let lastStatusPayload: any;
  let pollTick = 0;
  const installStartedAt = Date.now();
  let stallWarningShown = false;

  const readStatusDetails = (payload: any): { progress?: number; detail?: string } => {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    const numericProgressCandidates = [
      payload.progress,
      payload.install_progress,
      payload.percent,
      payload.percentage,
    ];
    const progress = numericProgressCandidates.find((v) => typeof v === 'number');

    const detailCandidates = [
      payload.current_step,
      payload.step,
      payload.message,
      payload.detail,
      payload.last_log,
    ];
    const detail = detailCandidates.find((v) => typeof v === 'string' && v.trim().length > 0);

    return { progress, detail };
  };

  const handleTerminalStatus = async (
    status: string,
    port?: number,
    error?: string,
    options?: { skipProcessLaunch?: boolean }
  ) => {
    if (installCompleted) {
      return;
    }

    if (status === 'running') {
      try {
        const launched = options?.skipProcessLaunch
          ? undefined
          : await launchInstalledProject(auth, projectId, outputChannel);
        const url = launched?.url ?? resolveRunningUrl(port);
        const displayPort = (() => {
          try {
            const parsed = new URL(url);
            return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
          } catch {
            return launched?.port ? String(launched.port) : port ? String(port) : 'n/a';
          }
        })();

        installCompleted = true;
        lastRunningUrl = url;
        statusBar.text = `$(play) Running on :${displayPort}`;
        statusBar.tooltip = url;
        statusBar.command = 'project-assistant.openBrowser';
        statusBar.show();
        if (options?.skipProcessLaunch) {
          outputChannel.appendLine(`[Assistant] Local installer completed. App assumed running at ${url}`);
        } else {
          outputChannel.appendLine(`[Assistant] App running at ${url}`);
        }
        const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
        if (!opened) {
          outputChannel.appendLine(`[Assistant] Could not auto-open browser for ${url}.`);
        }

        const action = await vscode.window.showInformationMessage(
          opened
            ? `Project launched and opened at ${url}`
            : `Project launched successfully at ${url}`,
          'Open again',
        );
        if (action === 'Open again') {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      } catch (launchError: any) {
        installCompleted = true;
        const message = launchError?.message ?? 'unknown launch error';
        outputChannel.appendLine(`[Launch] Failed: ${message}`);
        statusBar.text = '$(error) Launch failed';
        statusBar.show();
        await vscode.window.showErrorMessage(`Project install finished, but launch failed: ${message}`);
      }
      return;
    }

    if (status === 'failed') {
      installCompleted = true;
      statusBar.text = '$(error) Installation failed';
      statusBar.show();
      outputChannel.appendLine(`[Assistant] Failed: ${error ?? ''}`);
      const action = await vscode.window.showErrorMessage(
        `Installation failed: ${error ?? 'unknown error'}`,
        'View logs',
      );
      if (action === 'View logs') {
        outputChannel.show(true);
      }
    }
  };

  // ── Subscribe to WebSocket ─────────────────────────────────────
  const wsUrl = apiUrl.replace(/^http/, 'ws');
  const ws = new ProjectWebSocket(projectId, wsUrl);

  outputChannel.appendLine('[Assistant] Waiting for installation progress events...');

  const pollTimer = setInterval(async () => {
    if (installCompleted) {
      clearInterval(pollTimer);
      return;
    }

    pollTick += 1;

    try {
      let status: string | undefined;
      let projectPort: number | undefined;

      const res = await apiClient.get<{ id: string; status: string; port?: number }>(
        `/api/projects/${projectId}/status`,
      );
      lastStatusPayload = res.data;
      status = res.data.status;
      projectPort = res.data.port;

      if (!status) {
        return;
      }

      if (status !== lastPolledStatus) {
        lastPolledStatus = status;
        outputChannel.appendLine(`[Assistant] Poll status: ${status}`);
      }

      const statusDetails = readStatusDetails(res.data);
      if (statusDetails.detail || statusDetails.progress !== undefined) {
        const detailSignature = `${statusDetails.progress ?? ''}|${statusDetails.detail ?? ''}`;
        if (detailSignature !== lastPolledDetailSignature) {
          lastPolledDetailSignature = detailSignature;
          const detailLabel = statusDetails.detail ?? 'no step details';
          if (statusDetails.progress !== undefined) {
            outputChannel.appendLine(
              `[Assistant] Poll detail: ${statusDetails.progress}% — ${detailLabel}`
            );
          } else {
            outputChannel.appendLine(`[Assistant] Poll detail: ${detailLabel}`);
          }
        }
      }

      if (status === 'installing') {
        statusBar.text = '$(sync~spin) Installing…';
        statusBar.show();

        if (!stallWarningShown && Date.now() - installStartedAt > 120_000) {
          stallWarningShown = true;
          outputChannel.appendLine(
            `[Assistant] Installation appears stalled for ${taskId ? `task ${taskId}` : `project ${projectId}`}. Status is still installing.`
          );
          const action = await vscode.window.showWarningMessage(
            'Installation is taking longer than expected. Backend worker may be stuck.',
            'View logs'
          );
          if (action === 'View logs') {
            outputChannel.show(true);
          }
        }
      }

      if (status === 'running') {
        await handleTerminalStatus('running', projectPort);
        clearInterval(pollTimer);
      }

      if (status === 'failed') {
        await handleTerminalStatus('failed', undefined, 'Backend reported failure state');
        clearInterval(pollTimer);
      }
    } catch (err: any) {
      if (pollTick % 5 === 0) {
        outputChannel.appendLine(
          `[Assistant] Polling status still pending: ${err?.message ?? 'unknown error'}`
        );
      }
    }

    if (pollTick === 3) {
      outputChannel.appendLine(
        '[Assistant] No realtime events yet; using API polling fallback until status changes.'
      );
    }
  }, 4000);

ws.on('installation_progress', (data: any) => {
  const pct = data.progress ?? 0;
  const step = data.step ?? '';
  outputChannel.appendLine(`[${pct}%] ${step}`);
  statusBar.text = `$(sync~spin) Installing… ${pct}%`;
});

ws.on('log', (data: any) => {
  outputChannel.appendLine(`  ${data.message}`);
});
  ws.on('conflict_detected', (data: any) => {
    if (data.has_conflicts) {
      outputChannel.appendLine('[Assistant] Conflicts:');
      (data.conflicts ?? []).forEach((c: any) =>
        outputChannel.appendLine(
          `  • ${c.component}: need ${c.required}, found ${c.actual ?? 'none'}`
        )
      );

      const promptableConflict = (data.conflicts ?? []).find((c: any) => c?.ask_user);
      if (promptableConflict) {
        const promptText =
          promptableConflict.prompt ??
          `Missing runtime ${promptableConflict.component}. Install it and retry.`;

        outputChannel.appendLine(`[Action Required] ${promptText}`);
        if (promptableConflict.install_hint) {
          outputChannel.appendLine(`  Install guide: ${promptableConflict.install_hint}`);
        }

        apiOutputProvider.setInstallAction(promptText, promptableConflict.install_hint);
      }
    }
  });

  ws.on('status_change', async (data: any) => {
    outputChannel.appendLine(`[Assistant] ${data.old_status} → ${data.new_status}`);

    if (data.new_status === 'running') {
      apiOutputProvider.clearInstallAction();
      if (wsProgressEventCount === 0 && wsLogEventCount === 0) {
        outputChannel.appendLine(
          '[Assistant] Install reached running before progress/log events were emitted (fast-path completion).'
        );
        outputChannel.appendLine(
          `[Assistant] ${taskId ? `Task ${taskId}` : `Project ${projectId}`} completed without detailed websocket events from backend.`
        );
        if (lastStatusPayload) {
          const payloadPreview = JSON.stringify(lastStatusPayload, null, 2);
          outputChannel.appendLine('[Assistant] Final status payload snapshot:');
          outputChannel.appendLine(payloadPreview);
        }
      }
      ws.close();
      clearInterval(pollTimer);
      await handleTerminalStatus('running', data.port);
    }

    if (data.new_status === 'failed') {
      ws.close();
      clearInterval(pollTimer);
      await handleTerminalStatus('failed', undefined, data.error);
    }
  });
  ws.on('connected', (data: any) => {
    outputChannel.appendLine(`[WS] Server ready for project ${data?.project_id ?? projectId}`);
  });
  ws.on('pong', () => {
    outputChannel.appendLine('[WS] Pong');
  });
  ws.on('ping', () => {
    outputChannel.appendLine('[WS] Ping');
  });
  ws.on('__connecting', (data: any) => {
    outputChannel.appendLine(`[WS] Connecting to ${data?.url ?? 'unknown url'}`);
  });

  const handleRuntimeMissing = async (info: RuntimeMissingInfo) => {
    const message = info.message || `Missing runtime \"${info.tool}\" for ${info.projectType}. Install it before continuing.`;
    outputChannel.appendLine(`[Action Required] ${message}`);
    outputChannel.appendLine(`  Install guide: ${info.installUrl}`);
    apiOutputProvider.setConflictAction(message, info.installUrl);
  };

  const handleConflictResolution = async (info: ConflictResolutionInfo): Promise<ConflictResolutionChoice> => {
    outputChannel.appendLine(`[Conflict] ${info.message}`);
    if (info.installUrl) {
      outputChannel.appendLine(`  Install guide: ${info.installUrl}`);
    }
    outputChannel.appendLine('[Paused] Waiting for your choice in the extension panel: Use Docker or I Fixed It, Retry.');

    apiOutputProvider.setConflictAction(info.message, info.installUrl);

    return await new Promise<ConflictResolutionChoice>((resolve) => {
      pendingConflictResolver = (choice: ConflictResolutionChoice) => {
        outputChannel.appendLine(
          choice === 'docker'
            ? '[Conflict] User selected Docker strategy.'
            : '[Conflict] User selected manual fix, retrying checks.'
        );

        if (choice === 'manual') {
          apiOutputProvider.setConflictAction('Re-checking environment...', info.installUrl);
        } else {
          apiOutputProvider.clearInstallAction();
        }

        resolve(choice);
      };
    });
  };

  const handleDockerImagePullApproval = async (image: string): Promise<boolean> => {
    outputChannel.appendLine(`[Docker] Image ${image} is missing locally.`);
    const choice = await vscode.window.showWarningMessage(
      `Docker image ${image} is not available locally. Pull it now?`,
      'Pull image',
      'Cancel',
    );

    if (choice === 'Pull image') {
      outputChannel.appendLine(`[Docker] User approved pulling ${image}.`);
      return true;
    }

    outputChannel.appendLine(`[Docker] User declined pulling ${image}.`);
    return false;
  };

  ws.on('__open', async () => {
    outputChannel.appendLine('[WS] Connected');
    
    // Check if install is already in progress (handles race condition where
    // start_installation event was broadcast before WS connection)
    try {
      const statusRes = await apiClient.get<{
        type?: string;
        path?: string;
        status: string;
        metadata?: {
          host_path?: string;
          run_command?: string;
          launch_port?: number;
          detected_pm?: string;
          entry_point?: string;
          env_vars?: Record<string, string>;
          version_constraints?: Record<string, string>;
        };
      }>(
        `/api/projects/${projectId}/status`,
      );
      if (statusRes.data.status === 'installing' && statusRes.data.metadata) {
        outputChannel.appendLine('[WS] Install already in progress, restoring LocalInstaller');
        
        const installer = new LocalInstaller(
          auth.getApiClient(),
          (msg: string, level?: string) => {
            outputChannel.appendLine(level === 'error' ? `[!] ${msg}` : `  ${msg}`);
          },
          handleRuntimeMissing,
          handleConflictResolution,
          handleDockerImagePullApproval,
        );

        const installOk = await installer.install({
          projectId,
          hostPath: statusRes.data.metadata.host_path ?? statusRes.data.path ?? '',
          projectType: statusRes.data.type || 'nodejs',
          detectedPm: statusRes.data.metadata.detected_pm || 'npm',
          runCommand: statusRes.data.metadata.run_command,
          launchPort: statusRes.data.metadata.launch_port,
          envVars: statusRes.data.metadata.env_vars,
          versionConstraints: statusRes.data.metadata.version_constraints,
        });

        if (installOk) {
          const localPort = installer.getLastLaunchPort();
          outputChannel.appendLine('[Assistant] Local install completed without backend status transition. Promoting to running state.');
          await handleTerminalStatus('running', localPort, undefined, { skipProcessLaunch: true });
        }
      }
    } catch (err) {
      // Non-fatal: just continue with normal event handlers
      outputChannel.appendLine(`[WS] Status check on connect failed (non-fatal): ${(err as any)?.message}`);
    }
  });
  ws.on('__error', (data: any) => {
    outputChannel.appendLine(`[WS] Error: ${data?.message ?? 'unknown websocket error'}`);
  });
  ws.on('__close', (data: any) => {
    outputChannel.appendLine(
      `[WS] Closed (closedByClient=${data?.closedByClient ? 'true' : 'false'}, code=${data?.code ?? 'n/a'}, clean=${data?.wasClean ? 'true' : 'false'}, reason=${data?.reason || 'n/a'})`
    );
  });
  outputChannel.appendLine(`[WS] Connecting to: ${wsUrl}/ws/projects/${projectId}`);

ws.on('start_installation', async (data: any) => {
  outputChannel.appendLine(`[Assistant] Starting local installation for ${data.host_path}`);
  apiOutputProvider.clearInstallAction();

  const installer = new LocalInstaller(
    auth.getApiClient(),
    (msg: string, level?: string) => {
      outputChannel.appendLine(level === 'error' ? `[!] ${msg}` : `  ${msg}`);
    },
    handleRuntimeMissing,
    handleConflictResolution,
    handleDockerImagePullApproval,
  );

  const installOk = await installer.install({
    projectId:          data.project_id,
    hostPath:           data.host_path,
    projectType:        data.project_type,
    detectedPm:         data.detected_pm,
    runCommand:         data.run_command,
    launchPort:         data.launch_port,
    envVars:            data.env_vars,
    versionConstraints: data.version_constraints,
  });

  if (installOk) {
    const localPort = installer.getLastLaunchPort();
    outputChannel.appendLine('[Assistant] Local install completed without backend status transition. Promoting to running state.');
    await handleTerminalStatus('running', localPort, undefined, { skipProcessLaunch: true });
  }
});

  ws.connect();
  return true;
}
export function deactivate() {
  authManager?.deactivate();
  return stopServer();
}