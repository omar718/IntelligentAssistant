/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const os = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(3));
const fs = __importStar(__webpack_require__(4));
const child_process_1 = __webpack_require__(5);
const server_1 = __webpack_require__(6);
const llmService_1 = __webpack_require__(8);
const authManager_1 = __webpack_require__(9);
const projectWebSocket_1 = __webpack_require__(11);
const localInstaller_1 = __webpack_require__(12);
const apiOutputProvider_1 = __webpack_require__(14);
let authManager;
let lastRunningUrl;
const launchedProjects = new Map();
let pendingConflictResolver;
const PENDING_INSTALL_KEY = 'pendingInstallProjectId';
const LAST_PICKED_FOLDER_KEY = 'lastPickedCloneFolder';
const PENDING_FOLDER_PATH_KEY = 'pendingInstallFolderPath';
const DEFAULT_RUNNING_URL = 'http://localhost:8998';
function getConfiguredRunningUrl() {
    const config = vscode.workspace.getConfiguration('projectAssistant');
    return config.get('runningUrl') ?? DEFAULT_RUNNING_URL;
}
function resolveRunningUrl(port) {
    const configuredUrl = getConfiguredRunningUrl();
    if (port === undefined) {
        return configuredUrl;
    }
    try {
        const parsed = new URL(configuredUrl);
        parsed.port = String(port);
        return parsed.toString().replace(/\/$/, '');
    }
    catch {
        return `http://localhost:${port}`;
    }
}
async function waitForProjectPort(port, timeoutMs = 45_000) {
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
        }
        catch {
            // keep polling until timeout
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
}
async function launchInstalledProject(auth, projectId, outputChannel) {
    const mapContainerPathToHost = (rawPath) => {
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
    const projectResponse = await auth.getPublicApiClient().get(`/api/projects/${projectId}/launch-info`);
    const project = projectResponse.data;
    const metadata = project.metadata ?? {};
    const hostPath = mapContainerPathToHost(metadata.host_path ?? project.path);
    const runCommand = metadata.run_command ??
        metadata.steps?.find((step) => step.action === 'run' && step.command)?.command ??
        (project.type === 'python' && metadata.entry_point ? `python ${metadata.entry_point}` : undefined) ??
        (project.type === 'nodejs' && metadata.entry_point ? `node ${metadata.entry_point}` : undefined) ??
        (metadata.detected_pm === 'npm' ? 'npm start' : undefined);
    const launchPort = metadata.launch_port ??
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
    const child = (0, child_process_1.spawn)(runCommand, {
        cwd: hostPath,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    launchedProjects.set(projectId, child);
    let spawnError;
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
async function getPendingInstallId(context) {
    return context.globalState.get(PENDING_INSTALL_KEY);
}
async function setPendingInstallId(context, projectId) {
    await context.globalState.update(PENDING_INSTALL_KEY, projectId);
}
async function setPendingInstallFolderPath(context, folderPath) {
    await context.globalState.update(PENDING_FOLDER_PATH_KEY, folderPath);
}
async function getPendingInstallFolderPath(context) {
    return context.globalState.get(PENDING_FOLDER_PATH_KEY);
}
async function inferProjectIdFromFolder(auth, folderPath, outputChannel) {
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
            .get('/api/users/me/projects', {
            params: { per_page: 100 },
        });
        const exactMatch = res.data.items.find((p) => p.name?.trim().toLowerCase() === folderName);
        if (exactMatch?.id) {
            outputChannel.appendLine(`[OpenFolder] Inferred projectId ${exactMatch.id} from folder name "${path.basename(folderPath)}".`);
            return exactMatch.id;
        }
    }
    catch (err) {
        outputChannel.appendLine(`[OpenFolder] Could not infer projectId from API: ${err?.message ?? 'unknown error'}`);
    }
    return undefined;
}
async function promptProjectIdSelection(auth, folderPath) {
    if (!auth.isAuthenticated()) {
        return undefined;
    }
    try {
        const res = await auth
            .getApiClient()
            .get('/api/users/me/projects', {
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
        const picked = await vscode.window.showQuickPick(sorted.map((p) => ({
            label: p.name,
            description: p.id,
            projectId: p.id,
        })), {
            title: `Select project for folder ${path.basename(folderPath)}`,
            placeHolder: 'Choose the project to install',
            ignoreFocusOut: true,
        });
        return picked?.projectId;
    }
    catch {
        return undefined;
    }
}
function createMirroredOutputChannel(channel, ui) {
    const mirrored = channel;
    const originalAppendLine = mirrored.appendLine.bind(channel);
    const originalClear = mirrored.clear.bind(channel);
    mirrored.appendLine = (message) => {
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
function inferLogLevel(message) {
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
async function activate(context) {
    // ─── Output Channel ───────────────────────────────────────────────────────
    const apiOutputProvider = new apiOutputProvider_1.ApiOutputViewProvider(context.extensionUri, (action, payload) => {
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
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(apiOutputProvider_1.ApiOutputViewProvider.viewType, apiOutputProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    const outputChannel = createMirroredOutputChannel(vscode.window.createOutputChannel('Project Assistant API'), apiOutputProvider);
    context.subscriptions.push(outputChannel);
    // ─── Status Bar ───────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBar);
    // ─── API Info Helper ──────────────────────────────────────────────────────
    const showApiInfo = (port) => {
        outputChannel.clear();
        outputChannel.appendLine(`URL: http://localhost:${port}/Mobelite/chat`);
        outputChannel.appendLine(' Method: POST');
        outputChannel.appendLine('--------------------------------------------------');
        outputChannel.appendLine('Request Body (JSON):');
        outputChannel.appendLine(JSON.stringify({ prompt: 'Your prompt here...' }, null, 2));
        outputChannel.appendLine('--------------------------------------------------');
        outputChannel.appendLine('Expected Response (JSON):');
        outputChannel.appendLine(JSON.stringify({ result: 'The refined or generated response text.' }, null, 2));
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
                const action = await vscode.window.showWarningMessage(`Project opened from ${path.basename(pendingFolderPath)} without project id. Enter a project id to continue installation.`, 'Enter Project ID', 'Open Output', 'Dismiss');
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
                outputChannel.appendLine(`[Install] Manually linked pending folder ${pendingFolderPath} to project ${manualProjectId.trim()}`);
                await setPendingInstallFolderPath(context, undefined);
                return maybeResumePendingInstall();
            }
            await setPendingInstallFolderPath(context, undefined);
            if (!pendingId) {
                return;
            }
            outputChannel.appendLine(`[Install] Resuming pending installation for project ${pendingId}`);
            const started = await triggerInstallFromExtension(context, pendingId, authManager, outputChannel, statusBar, apiOutputProvider, true);
            pendingInstallHandled = started;
        }
        finally {
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
    authManager = new authManager_1.AuthManager(context, statusBar, onOnline, onOffline, (message, level) => apiOutputProvider.appendLine(`[Auth] ${message}`, level ?? 'info'));
    // ─── Auto-Launch Logic ────────────────────────────────────────────────────
    if (!authManager.isAuthenticated()) {
        showOptionalLoginPrompt();
    }
    // ─── Folder Callbacks ─────────────────────────────────────────────────────
    (0, server_1.registerOpenFolderCallback)((folderPath, projectId) => {
        void (async () => {
            try {
                outputChannel.appendLine(`[OpenFolder] Requested path: ${folderPath}`);
                const normalizePath = (value) => value.replace(/\\/g, '/').toLowerCase();
                const pathExists = async (targetPath) => {
                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
                        return true;
                    }
                    catch {
                        return false;
                    }
                };
                let resolvedFolderPath = folderPath;
                const lastPickedFolder = context.globalState.get(LAST_PICKED_FOLDER_KEY);
                if (lastPickedFolder) {
                    const candidatePath = path.join(lastPickedFolder, path.basename(folderPath));
                    const providedExists = await pathExists(folderPath);
                    const candidateExists = await pathExists(candidatePath);
                    const requestedParent = normalizePath(path.dirname(folderPath));
                    const homeDir = normalizePath(os.homedir());
                    // If backend sends ~/repo but user picked another destination, prefer the picked destination.
                    if (candidateExists &&
                        normalizePath(candidatePath) !== normalizePath(folderPath) &&
                        (!providedExists || requestedParent === homeDir)) {
                        resolvedFolderPath = candidatePath;
                        outputChannel.appendLine(`[OpenFolder] Re-mapped to preferred clone path: ${resolvedFolderPath}`);
                    }
                }
                const uri = vscode.Uri.file(resolvedFolderPath);
                try {
                    await vscode.workspace.fs.stat(uri);
                }
                catch {
                    vscode.window.showErrorMessage(`Folder does not exist: ${resolvedFolderPath}`);
                    return;
                }
                const resolvedProjectId = projectId;
                if (resolvedProjectId) {
                    await setPendingInstallId(context, resolvedProjectId);
                    await setPendingInstallFolderPath(context, undefined);
                    outputChannel.appendLine(`[OpenFolder] Pending install set for project ${resolvedProjectId}`);
                }
                else {
                    await setPendingInstallFolderPath(context, resolvedFolderPath);
                    outputChannel.appendLine('[OpenFolder] No projectId provided. Requesting manual project id.');
                    const action = await vscode.window.showWarningMessage('Project opened without project id. Enter it now to continue installation.', 'Enter Project ID', 'Open Output', 'Skip');
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
                            outputChannel.appendLine(`[OpenFolder] Manual projectId captured: ${manualProjectId.trim()}`);
                        }
                        else {
                            outputChannel.appendLine('[OpenFolder] Manual projectId entry was skipped or empty.');
                        }
                    }
                    else if (action === 'Open Output') {
                        outputChannel.show(true);
                    }
                }
                const requested = normalizePath(uri.fsPath);
                const alreadyOpen = (vscode.workspace.workspaceFolders ?? []).some((wf) => normalizePath(wf.uri.fsPath) === requested);
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
                }
                catch {
                    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
                }
            }
            catch (err) {
                console.error('Error in openFolderCallback:', err);
                vscode.window.showErrorMessage(`Error opening folder: ${err?.message || 'Unknown error'}`);
            }
        })();
    });
    (0, server_1.registerPickFolderCallback)(async () => {
        try {
            // Add a timeout to prevent hanging
            const timeoutPromise = new Promise((resolve) => {
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
        }
        catch (err) {
            console.error('Folder picker error:', err);
            vscode.window.showErrorMessage(`Folder picker error: ${err.message}`);
            return null;
        }
    });
    // ─── Auto-start Server ────────────────────────────────────────────────────
    (0, server_1.startServer)(6009)
        .then((port) => {
        outputChannel.appendLine(`Project Assistant server auto-started on port ${port}`);
    })
        .catch((err) => {
        if (!err.message.includes('already running')) {
            vscode.window.showWarningMessage(`Project Assistant: server could not start — ${err.message}`);
        }
    });
    // ─── Pre-fetch Models ─────────────────────────────────────────────────────
    (0, llmService_1.getAvailableModels)().catch(console.error);
    // ─── Commands ─────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.showApiInfo', (port) => {
        showApiInfo(port || 6009);
    }), vscode.commands.registerCommand('project-assistant.retryInstall', async () => {
        const pendingId = await getPendingInstallId(context);
        if (!pendingId) {
            vscode.window.showWarningMessage('No pending installation found.');
            return;
        }
        await triggerInstallFromExtension(context, pendingId, authManager, outputChannel, statusBar, apiOutputProvider, true);
    }), vscode.commands.registerCommand('project-assistant.openBrowser', () => {
        const url = lastRunningUrl ?? getConfiguredRunningUrl();
        vscode.env.openExternal(vscode.Uri.parse(url));
    }), vscode.commands.registerCommand('project-assistant.startServer', async (port, modelId) => {
        try {
            const actualPort = await (0, server_1.startServer)(port, modelId);
            vscode.window
                .showInformationMessage(`Project Assistant Server started on port ${actualPort}`, 'Show API Usage')
                .then((selection) => {
                if (selection === 'Show API Usage') {
                    showApiInfo(actualPort);
                }
            });
            return { success: true, port: actualPort };
        }
        catch (err) {
            const error = err;
            vscode.window.showErrorMessage(`Failed to start server: ${error.message}`);
            return { success: false, error: error.message };
        }
    }), vscode.commands.registerCommand('project-assistant.stopServer', async () => {
        try {
            await (0, server_1.stopServer)();
            vscode.window.showInformationMessage('Project Assistant Server stopped');
            return { success: true };
        }
        catch (err) {
            const error = err;
            vscode.window.showErrorMessage(`Failed to stop server: ${error.message}`);
            return { success: false, error: error.message };
        }
    }), vscode.commands.registerCommand('project-assistant.getModels', async () => {
        return await (0, llmService_1.getAvailableModels)();
    }), vscode.commands.registerCommand('project-assistant.getServerStatus', () => {
        return { running: (0, server_1.isServerRunning)() };
    }), vscode.commands.registerCommand('project-assistant.inspectAuthState', async () => {
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
        }
        catch (err) {
            const message = err?.message || 'Failed to inspect auth state';
            vscode.window.showErrorMessage(message);
            return { success: false, error: message };
        }
    }), vscode.commands.registerCommand('project-assistant.login', async () => {
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
        }
        catch (err) {
            const msg = err?.response?.status === 401
                ? 'Invalid email or password'
                : 'Login failed. Check the backend is running.';
            vscode.window.showErrorMessage(msg);
            return { success: false, error: msg };
        }
    }), vscode.commands.registerCommand('project-assistant.logout', async () => {
        try {
            await authManager.logout();
            return { success: true };
        }
        catch (err) {
            vscode.window.showErrorMessage('Logout failed');
            return { success: false, error: err?.message };
        }
    }), vscode.commands.registerCommand('project-assistant.retryConnection', async () => {
        try {
            const online = await authManager.checkHealth();
            if (online) {
                onOnline();
                return { success: true, online: true };
            }
            else {
                vscode.window.showWarningMessage('Backend still offline. Is the server running?');
                return { success: false, online: false };
            }
        }
        catch (err) {
            vscode.window.showErrorMessage('Connection check failed');
            return { success: false, error: err?.message };
        }
    }));
    // ─── Activate Auth ────────────────────────────────────────────────────────
    await authManager.activate();
    await maybeResumePendingInstall();
    vscode.window.showInformationMessage('Project Assistant activated');
} // ← closing brace for activate()
async function showOptionalLoginPrompt() {
    const selection = await vscode.window.showInformationMessage("Welcome! Would you like to log in to sync your projects with DevLauncher?", "Log In", "Maybe Later");
    if (selection === "Log In") {
        vscode.commands.executeCommand('project-assistant.login');
    }
}
async function triggerInstallFromExtension(context, projectId, auth, outputChannel, statusBar, apiOutputProvider, requireConfirmation = true) {
    const apiUrl = vscode.workspace.getConfiguration('projectAssistant').get('apiUrl') ??
        'http://localhost:8000';
    const apiClient = auth.getPublicApiClient();
    if (requireConfirmation) {
        const answer = await vscode.window.showInformationMessage('Project cloned and analyzed. Start installation now?', 'Install', 'Not now');
        if (answer !== 'Install') {
            statusBar.text = '$(package) Click to install project';
            statusBar.command = 'project-assistant.retryInstall';
            statusBar.show();
            await setPendingInstallId(context, projectId);
            return false;
        }
    }
    // ── Fire POST /api/projects/:id/install ────────────────────────
    let taskId;
    try {
        const res = await apiClient.post(`/api/projects/${projectId}/install`);
        taskId = res.data.task_id;
    }
    catch (err) {
        const status = err?.response?.status;
        const msg = err?.response?.data?.detail ?? err?.message ?? 'Unknown error';
        if (status === 401 && String(msg).toLowerCase().includes('invalid or expired token')) {
            const backendMsg = 'Installation backend is still auth-protected. Restart/update backend to expose public install routes.';
            outputChannel.appendLine(`[Install] ${backendMsg}`);
            outputChannel.appendLine('[Install] Expected endpoints: POST /api/projects/{id}/install (public), GET /api/projects/{id}/status (public).');
            const action = await vscode.window.showErrorMessage(backendMsg, 'Open Output', 'Log In');
            if (action === 'Open Output') {
                outputChannel.show(true);
            }
            if (action === 'Log In') {
                void vscode.commands.executeCommand('project-assistant.login');
            }
        }
        else {
            vscode.window.showErrorMessage(`Failed to start installation: ${msg}`);
        }
        await setPendingInstallId(context, projectId);
        return false;
    }
    await setPendingInstallId(context, undefined);
    await setPendingInstallFolderPath(context, undefined);
    outputChannel.show(false);
    outputChannel.appendLine(`[Assistant] Installation started — ${taskId ? `task ${taskId}` : `project ${projectId}`}`);
    statusBar.text = '$(sync~spin) Installing…';
    statusBar.command = undefined;
    statusBar.show();
    let installCompleted = false;
    let wsProgressEventCount = 0;
    let wsLogEventCount = 0;
    let lastPolledStatus;
    let lastPolledDetailSignature;
    let lastStatusPayload;
    let pollTick = 0;
    const installStartedAt = Date.now();
    let stallWarningShown = false;
    const readStatusDetails = (payload) => {
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
    const handleTerminalStatus = async (status, port, error, options) => {
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
                    }
                    catch {
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
                }
                else {
                    outputChannel.appendLine(`[Assistant] App running at ${url}`);
                }
                const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
                if (!opened) {
                    outputChannel.appendLine(`[Assistant] Could not auto-open browser for ${url}.`);
                }
                const action = await vscode.window.showInformationMessage(opened
                    ? `Project launched and opened at ${url}`
                    : `Project launched successfully at ${url}`, 'Open again');
                if (action === 'Open again') {
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                }
            }
            catch (launchError) {
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
            const action = await vscode.window.showErrorMessage(`Installation failed: ${error ?? 'unknown error'}`, 'View logs');
            if (action === 'View logs') {
                outputChannel.show(true);
            }
        }
    };
    // ── Subscribe to WebSocket ─────────────────────────────────────
    const wsUrl = apiUrl.replace(/^http/, 'ws');
    const ws = new projectWebSocket_1.ProjectWebSocket(projectId, wsUrl);
    outputChannel.appendLine('[Assistant] Waiting for installation progress events...');
    const pollTimer = setInterval(async () => {
        if (installCompleted) {
            clearInterval(pollTimer);
            return;
        }
        pollTick += 1;
        try {
            let status;
            let projectPort;
            const res = await apiClient.get(`/api/projects/${projectId}/status`);
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
                        outputChannel.appendLine(`[Assistant] Poll detail: ${statusDetails.progress}% — ${detailLabel}`);
                    }
                    else {
                        outputChannel.appendLine(`[Assistant] Poll detail: ${detailLabel}`);
                    }
                }
            }
            if (status === 'installing') {
                statusBar.text = '$(sync~spin) Installing…';
                statusBar.show();
                if (!stallWarningShown && Date.now() - installStartedAt > 120_000) {
                    stallWarningShown = true;
                    outputChannel.appendLine(`[Assistant] Installation appears stalled for ${taskId ? `task ${taskId}` : `project ${projectId}`}. Status is still installing.`);
                    const action = await vscode.window.showWarningMessage('Installation is taking longer than expected. Backend worker may be stuck.', 'View logs');
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
        }
        catch (err) {
            if (pollTick % 5 === 0) {
                outputChannel.appendLine(`[Assistant] Polling status still pending: ${err?.message ?? 'unknown error'}`);
            }
        }
        if (pollTick === 3) {
            outputChannel.appendLine('[Assistant] No realtime events yet; using API polling fallback until status changes.');
        }
    }, 4000);
    ws.on('installation_progress', (data) => {
        const pct = data.progress ?? 0;
        const step = data.step ?? '';
        outputChannel.appendLine(`[${pct}%] ${step}`);
        statusBar.text = `$(sync~spin) Installing… ${pct}%`;
    });
    ws.on('log', (data) => {
        outputChannel.appendLine(`  ${data.message}`);
    });
    ws.on('conflict_detected', (data) => {
        if (data.has_conflicts) {
            outputChannel.appendLine('[Assistant] Conflicts:');
            (data.conflicts ?? []).forEach((c) => outputChannel.appendLine(`  • ${c.component}: need ${c.required}, found ${c.actual ?? 'none'}`));
            const promptableConflict = (data.conflicts ?? []).find((c) => c?.ask_user);
            if (promptableConflict) {
                const promptText = promptableConflict.prompt ??
                    `Missing runtime ${promptableConflict.component}. Install it and retry.`;
                outputChannel.appendLine(`[Action Required] ${promptText}`);
                if (promptableConflict.install_hint) {
                    outputChannel.appendLine(`  Install guide: ${promptableConflict.install_hint}`);
                }
                apiOutputProvider.setInstallAction(promptText, promptableConflict.install_hint);
            }
        }
    });
    ws.on('status_change', async (data) => {
        outputChannel.appendLine(`[Assistant] ${data.old_status} → ${data.new_status}`);
        if (data.new_status === 'running') {
            apiOutputProvider.clearInstallAction();
            if (wsProgressEventCount === 0 && wsLogEventCount === 0) {
                outputChannel.appendLine('[Assistant] Install reached running before progress/log events were emitted (fast-path completion).');
                outputChannel.appendLine(`[Assistant] ${taskId ? `Task ${taskId}` : `Project ${projectId}`} completed without detailed websocket events from backend.`);
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
    ws.on('connected', (data) => {
        outputChannel.appendLine(`[WS] Server ready for project ${data?.project_id ?? projectId}`);
    });
    ws.on('pong', () => {
        outputChannel.appendLine('[WS] Pong');
    });
    ws.on('ping', () => {
        outputChannel.appendLine('[WS] Ping');
    });
    ws.on('__connecting', (data) => {
        outputChannel.appendLine(`[WS] Connecting to ${data?.url ?? 'unknown url'}`);
    });
    const handleRuntimeMissing = async (info) => {
        const message = info.message || `Missing runtime \"${info.tool}\" for ${info.projectType}. Install it before continuing.`;
        outputChannel.appendLine(`[Action Required] ${message}`);
        outputChannel.appendLine(`  Install guide: ${info.installUrl}`);
        apiOutputProvider.setConflictAction(message, info.installUrl);
    };
    const handleConflictResolution = async (info) => {
        outputChannel.appendLine(`[Conflict] ${info.message}`);
        if (info.installUrl) {
            outputChannel.appendLine(`  Install guide: ${info.installUrl}`);
        }
        outputChannel.appendLine('[Paused] Waiting for your choice in the extension panel: Use Docker or I Fixed It, Retry.');
        apiOutputProvider.setConflictAction(info.message, info.installUrl);
        return await new Promise((resolve) => {
            pendingConflictResolver = (choice) => {
                outputChannel.appendLine(choice === 'docker'
                    ? '[Conflict] User selected Docker strategy.'
                    : '[Conflict] User selected manual fix, retrying checks.');
                if (choice === 'manual') {
                    apiOutputProvider.setConflictAction('Re-checking environment...', info.installUrl);
                }
                else {
                    apiOutputProvider.clearInstallAction();
                }
                resolve(choice);
            };
        });
    };
    const handleDockerImagePullApproval = async (image) => {
        outputChannel.appendLine(`[Docker] Image ${image} is missing locally.`);
        const choice = await vscode.window.showWarningMessage(`Docker image ${image} is not available locally. Pull it now?`, 'Pull image', 'Cancel');
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
            const statusRes = await apiClient.get(`/api/projects/${projectId}/status`);
            if (statusRes.data.status === 'installing' && statusRes.data.metadata) {
                outputChannel.appendLine('[WS] Install already in progress, restoring LocalInstaller');
                const installer = new localInstaller_1.LocalInstaller(auth.getApiClient(), (msg, level) => {
                    outputChannel.appendLine(level === 'error' ? `[!] ${msg}` : `  ${msg}`);
                }, handleRuntimeMissing, handleConflictResolution, handleDockerImagePullApproval);
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
        }
        catch (err) {
            // Non-fatal: just continue with normal event handlers
            outputChannel.appendLine(`[WS] Status check on connect failed (non-fatal): ${err?.message}`);
        }
    });
    ws.on('__error', (data) => {
        outputChannel.appendLine(`[WS] Error: ${data?.message ?? 'unknown websocket error'}`);
    });
    ws.on('__close', (data) => {
        outputChannel.appendLine(`[WS] Closed (closedByClient=${data?.closedByClient ? 'true' : 'false'}, code=${data?.code ?? 'n/a'}, clean=${data?.wasClean ? 'true' : 'false'}, reason=${data?.reason || 'n/a'})`);
    });
    outputChannel.appendLine(`[WS] Connecting to: ${wsUrl}/ws/projects/${projectId}`);
    ws.on('start_installation', async (data) => {
        outputChannel.appendLine(`[Assistant] Starting local installation for ${data.host_path}`);
        apiOutputProvider.clearInstallAction();
        const installer = new localInstaller_1.LocalInstaller(auth.getApiClient(), (msg, level) => {
            outputChannel.appendLine(level === 'error' ? `[!] ${msg}` : `  ${msg}`);
        }, handleRuntimeMissing, handleConflictResolution, handleDockerImagePullApproval);
        const installOk = await installer.install({
            projectId: data.project_id,
            hostPath: data.host_path,
            projectType: data.project_type,
            detectedPm: data.detected_pm,
            runCommand: data.run_command,
            launchPort: data.launch_port,
            envVars: data.env_vars,
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
function deactivate() {
    authManager?.deactivate();
    return (0, server_1.stopServer)();
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("os");

/***/ }),
/* 3 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 4 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 6 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerOpenFolderCallback = registerOpenFolderCallback;
exports.registerPickFolderCallback = registerPickFolderCallback;
exports.isServerRunning = isServerRunning;
exports.startServer = startServer;
exports.stopServer = stopServer;
const http = __importStar(__webpack_require__(7));
const llmService_1 = __webpack_require__(8);
let server = null;
let _openFolderCallback = null;
let _pickFolderCallback = null;
function registerOpenFolderCallback(cb) {
    _openFolderCallback = cb;
}
function registerPickFolderCallback(cb) {
    _pickFolderCallback = cb;
}
function isServerRunning() {
    return server !== null && server !== undefined;
}
function startServer(port = 6009, modelId) {
    return new Promise((resolve, reject) => {
        if (server) {
            if (server.listening) {
                reject(new Error('Server is already running'));
                return;
            }
            else {
                server = null;
            }
        }
        server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (req.method === 'GET' && req.url === '/pick-folder') {
                if (!_pickFolderCallback) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'pick-folder handler not registered' }));
                    return;
                }
                try {
                    const selectedPath = await _pickFolderCallback();
                    if (selectedPath) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ path: selectedPath }));
                    }
                    else {
                        // User cancelled the dialog
                        res.writeHead(204);
                        res.end();
                    }
                }
                catch (error) {
                    const err = error;
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }
            else if (req.method === 'POST' && req.url === '/open-folder') {
                let body = '';
                req.on('data', (chunk) => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        const folderPath = data.path;
                        const projectId = data.project_id;
                        if (!folderPath) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Missing "path" in request body.' }));
                            return;
                        }
                        if (_openFolderCallback) {
                            _openFolderCallback(folderPath, projectId);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true }));
                        }
                        else {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'open-folder handler not registered' }));
                        }
                    }
                    catch (error) {
                        const err = error;
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
            }
            else if (req.method === 'POST' && req.url === '/Mobelite/chat') {
                let body = '';
                req.on('data', (chunk) => {
                    body += chunk.toString();
                });
                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        let history = data.history;
                        if (!history && data.prompt) {
                            history = [{ role: 'user', content: data.prompt }];
                        }
                        if (!history) {
                            res.writeHead(400, { 'Content-Type': 'text/plain' });
                            res.end('Missing "prompt" or "history" in request body.');
                            return;
                        }
                        const requestModelId = data.modelId || modelId;
                        const systemPrompt = data.systemPrompt;
                        const responseText = await (0, llmService_1.sendChatRequest)(history, requestModelId, systemPrompt);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ result: responseText }));
                    }
                    catch (error) {
                        const err = error;
                        console.error('Server error:', err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
            }
            else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not Found' }));
            }
        });
        server.listen(port, () => {
            console.log(`Project Assistant server is running on http://localhost:${port}`);
            resolve(port);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                server = null;
                reject(new Error(`Port ${port} is already in use. Choose a different port.`));
            }
            else {
                server = null;
                reject(err);
            }
        });
    });
}
function stopServer() {
    return new Promise((resolve, reject) => {
        if (server) {
            server.close((err) => {
                if (err) {
                    console.error('Error stopping server:', err);
                    server = null;
                    reject(err);
                }
                else {
                    console.log('Project Assistant server stopped');
                    server = null;
                    resolve();
                }
            });
            setTimeout(() => {
                if (server && server.listening) {
                    if (typeof server.closeAllConnections === 'function') {
                        server.closeAllConnections();
                    }
                }
            }, 1000);
        }
        else {
            resolve();
        }
    });
}


/***/ }),
/* 7 */
/***/ ((module) => {

module.exports = require("http");

/***/ }),
/* 8 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getAvailableModels = getAvailableModels;
exports.selectModel = selectModel;
exports.sendChatRequest = sendChatRequest;
const vscode = __importStar(__webpack_require__(1));
let cachedModels = null;
async function getAvailableModels() {
    if (cachedModels) {
        return cachedModels;
    }
    try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        cachedModels = models.map((m) => ({
            id: m.id,
            name: m.name ?? 'Unknown',
            family: m.family ?? 'unknown',
        }));
        return cachedModels;
    }
    catch (error) {
        console.error('Error fetching models:', error);
        return [];
    }
}
async function selectModel(modelId) {
    let targetModel;
    if (modelId) {
        const selected = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: modelId,
        });
        targetModel = selected[0];
    }
    if (!targetModel) {
        const defaultModels = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'gpt-4.1',
        });
        targetModel = defaultModels[0] || (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0];
    }
    if (!targetModel) {
        throw new Error('Copilot not available. Please install GitHub Copilot extension.');
    }
    return targetModel;
}
async function sendChatRequest(history, modelId, systemPrompt) {
    try {
        const targetModel = await selectModel(modelId);
        const messages = [];
        if (systemPrompt) {
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
        }
        messages.push(...history.map((msg) => msg.role === 'user'
            ? vscode.LanguageModelChatMessage.User(msg.content)
            : vscode.LanguageModelChatMessage.Assistant(msg.content)));
        const chatResponse = await targetModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        let rawResponse = '';
        for await (const fragment of chatResponse.text) {
            rawResponse += fragment;
        }
        return rawResponse;
    }
    catch (error) {
        console.error('Error in sendChatRequest:', error);
        throw error;
    }
}


/***/ }),
/* 9 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AuthManager = void 0;
const vscode = __importStar(__webpack_require__(1));
const axios_1 = __importDefault(__webpack_require__(10));
const TOKEN_KEY = "auth.token";
const HEALTH_POLL_INTERVAL_MS = 30_000;
/**
 * AuthManager handles all authentication concerns for the VS Code extension.
 *
 * Security requirements (§3.3):
 *  - JWT stored in context.secrets (OS keychain) — NEVER in settings.json
 *  - Anthropic API key: never in the extension; all Claude calls go through the backend
 *  - Auto-reconnect: poll /health every 30s when backend is offline
 */
class AuthManager {
    context;
    statusBar;
    onOnline;
    onOffline;
    token;
    apiClient;
    publicApiClient;
    healthPollTimer;
    isOnline = false;
    isSessionVerified = false;
    onLog;
    constructor(context, statusBar, onOnline, onOffline, onLog) {
        this.context = context;
        this.statusBar = statusBar;
        this.onOnline = onOnline;
        this.onOffline = onOffline;
        this.onLog = onLog ?? (() => undefined);
        const apiUrl = vscode.workspace.getConfiguration("projectAssistant").get("apiUrl") ??
            "http://localhost:8000";
        this.apiClient = axios_1.default.create({
            baseURL: apiUrl,
            withCredentials: true,
            timeout: 5_000,
        });
        this.publicApiClient = axios_1.default.create({
            baseURL: apiUrl,
            withCredentials: true,
            timeout: 5_000,
        });
        // Inject Bearer token on every request
        this.apiClient.interceptors.request.use((config) => {
            if (this.token) {
                config.headers["Authorization"] = `Bearer ${this.token}`;
            }
            return config;
        });
        // 401 → clear token, show "session expired"
        this.apiClient.interceptors.response.use((res) => res, async (error) => {
            if (error.response?.status === 401) {
                await this.clearToken();
                await this.setAuthContext(false);
                this.showSessionExpired();
            }
            return Promise.reject(error);
        });
    }
    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------
    async activate() {
        // Restore token from secure storage
        this.token = await this.context.secrets.get(TOKEN_KEY);
        await this.setAuthContext(false);
        this.log("Initializing auth state...");
        // Check backend availability with 2-second timeout
        const online = await this.checkHealth();
        if (online) {
            this.log("Backend is online.", "success");
            if (this.token) {
                const valid = await this.validateStoredToken();
                if (!valid) {
                    await this.clearToken();
                }
            }
            this.isOnline = true;
            this.log("Auth services ready.", "success");
            this.onOnline();
        }
        else {
            this.isOnline = false;
            this.showOffline();
            this.startHealthPolling();
        }
    }
    deactivate() {
        this.stopHealthPolling();
    }
    // ---------------------------------------------------------------------------
    // Authentication
    // ---------------------------------------------------------------------------
    async login(email, password) {
        this.log(`Signing in as ${email}...`);
        const response = await this.apiClient.post("/auth/login", { email, password });
        const { access_token } = response.data;
        await this.storeToken(access_token);
        this.isSessionVerified = true;
        await this.setAuthContext(true);
        this.log(`Signed in as ${response.data.user.email}.`, "success");
        vscode.window.showInformationMessage(`Signed in as ${response.data.user.email}`);
    }
    async logout() {
        this.log("Signing out...");
        let logoutError;
        try {
            await this.apiClient.post("/auth/logout");
        }
        catch (error) {
            logoutError = error;
        }
        finally {
            await this.clearToken();
            await this.setAuthContext(false);
            this.statusBar.text = "$(account) Sign in to Intelligent Assistant";
            this.statusBar.command = "project-assistant.login";
            this.statusBar.show();
            this.log("Signed out.");
        }
        if (axios_1.default.isAxiosError(logoutError)) {
            const status = logoutError.response?.status;
            if (!status || status === 401 || status === 403 || status === 404) {
                return;
            }
        }
        if (logoutError) {
            throw logoutError;
        }
    }
    isAuthenticated() {
        return !!this.token;
    }
    async hasStoredToken() {
        const storedToken = await this.context.secrets.get(TOKEN_KEY);
        return !!storedToken;
    }
    getApiClient() {
        return this.apiClient;
    }
    getPublicApiClient() {
        return this.publicApiClient;
    }
    getAccessToken() {
        return this.token;
    }
    // ---------------------------------------------------------------------------
    // Token storage (OS keychain via SecretStorage)
    // ---------------------------------------------------------------------------
    async storeToken(token) {
        this.token = token;
        await this.context.secrets.store(TOKEN_KEY, token);
    }
    async clearToken() {
        this.token = undefined;
        this.isSessionVerified = false;
        await this.context.secrets.delete(TOKEN_KEY);
    }
    async validateStoredToken() {
        if (!this.token) {
            this.isSessionVerified = false;
            await this.setAuthContext(false);
            return false;
        }
        try {
            // Use the public client here to avoid triggering global 401 side-effects
            // when simply probing whether a restored token is still valid.
            await this.publicApiClient.get("/api/users/me", {
                headers: { Authorization: `Bearer ${this.token}` },
            });
            this.isSessionVerified = true;
            await this.setAuthContext(true);
            return true;
        }
        catch {
            this.isSessionVerified = false;
            await this.setAuthContext(false);
            return false;
        }
    }
    async setAuthContext(authenticated) {
        await vscode.commands.executeCommand("setContext", "projectAssistant.authenticated", authenticated);
    }
    // ---------------------------------------------------------------------------
    // Health check & offline handling
    // ---------------------------------------------------------------------------
    async checkHealth() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2_000);
            await this.apiClient.get("/health", {
                signal: controller.signal,
                validateStatus: () => true,
            });
            clearTimeout(timeout);
            return true;
        }
        catch {
            return false;
        }
    }
    startHealthPolling() {
        this.stopHealthPolling();
        this.healthPollTimer = setInterval(async () => {
            const online = await this.checkHealth();
            if (online && !this.isOnline) {
                this.isOnline = true;
                this.stopHealthPolling();
                this.onOnline();
            }
        }, HEALTH_POLL_INTERVAL_MS);
    }
    stopHealthPolling() {
        if (this.healthPollTimer) {
            clearInterval(this.healthPollTimer);
            this.healthPollTimer = undefined;
        }
    }
    // ---------------------------------------------------------------------------
    // Status bar messages
    // ---------------------------------------------------------------------------
    showOffline() {
        this.onOffline();
        this.statusBar.text = "$(warning) Backend offline — Start server to continue";
        this.statusBar.tooltip = "Click to retry connection";
        this.statusBar.command = "project-assistant.retryConnection";
        this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.statusBar.show();
        this.log("Backend offline — waiting for reconnect.", "warning");
    }
    showSessionExpired() {
        this.statusBar.text = "$(lock) Session expired — Click to sign in";
        this.statusBar.command = "project-assistant.login";
        this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.statusBar.show();
        this.log("Session expired. Please sign in again.", "warning");
        vscode.window
            .showWarningMessage("Your session has expired. Please sign in again.", "Sign In")
            .then((action) => {
            if (action === "Sign In") {
                vscode.commands.executeCommand("project-assistant.login");
            }
        });
    }
    log(message, level = "info") {
        this.onLog(message, level);
    }
}
exports.AuthManager = AuthManager;


/***/ }),
/* 10 */
/***/ ((module) => {

module.exports = require("axios");

/***/ }),
/* 11 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProjectWebSocket = void 0;
class ProjectWebSocket {
    projectId;
    wsBaseUrl;
    authToken;
    ws = null;
    handlers = new Map();
    reconnectTimer = null;
    closed = false;
    constructor(projectId, wsBaseUrl, // e.g. "ws://localhost:8000"
    authToken) {
        this.projectId = projectId;
        this.wsBaseUrl = wsBaseUrl;
        this.authToken = authToken;
    }
    on(event, handler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event).push(handler);
        return this;
    }
    emit(event, payload) {
        const eventHandlers = this.handlers.get(event) ?? [];
        eventHandlers.forEach((h) => h(payload));
    }
    connect() {
        this.closed = false;
        this._connect();
    }
    _connect() {
        const baseUrl = `${this.wsBaseUrl}/ws/projects/${this.projectId}`;
        const query = this.authToken
            ? `?token=${encodeURIComponent(this.authToken)}&access_token=${encodeURIComponent(this.authToken)}`
            : '';
        const url = `${baseUrl}${query}`;
        const redactedUrl = this.authToken ? `${baseUrl}?access_token=***` : baseUrl;
        this.emit('__connecting', { url: redactedUrl, projectId: this.projectId });
        try {
            this.ws = new WebSocket(url);
        }
        catch (err) {
            console.error('[ProjectWebSocket] Failed to create WebSocket:', err);
            this.emit('__error', { message: String(err) });
            return;
        }
        this.ws.onopen = () => {
            console.log(`[ProjectWebSocket] Connected for project ${this.projectId}`);
            this.emit('__open', { projectId: this.projectId });
        };
        this.ws.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                const { event: eventName, data } = payload;
                const eventHandlers = this.handlers.get(eventName) ?? [];
                eventHandlers.forEach(h => h(data));
            }
            catch (err) {
                console.error('[ProjectWebSocket] Failed to parse message:', err);
            }
        };
        this.ws.onerror = (err) => {
            console.error('[ProjectWebSocket] Error:', err);
            const eventType = err?.type ?? 'unknown';
            const readyState = this.ws?.readyState;
            this.emit('__error', {
                message: `type=${eventType}, readyState=${readyState}`,
            });
        };
        this.ws.onclose = (event) => {
            this.emit('__close', {
                projectId: this.projectId,
                closedByClient: this.closed,
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
            });
            if (this.closed)
                return;
            // Reconnect after 3s if not intentionally closed
            this.reconnectTimer = setTimeout(() => this._connect(), 3000);
        };
    }
    close() {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
exports.ProjectWebSocket = ProjectWebSocket;


/***/ }),
/* 12 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.LocalInstaller = void 0;
const cp = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(3));
const fs = __importStar(__webpack_require__(4));
class DockerFallbackRequestedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DockerFallbackRequestedError';
    }
}
class LocalInstaller {
    apiClient;
    onLog;
    onRuntimeMissing;
    onConflictResolution;
    onDockerImagePullApproval;
    proc = null;
    cancelled = false;
    lastLaunchPort;
    constructor(apiClient, onLog, onRuntimeMissing, onConflictResolution, onDockerImagePullApproval) {
        this.apiClient = apiClient;
        this.onLog = onLog;
        this.onRuntimeMissing = onRuntimeMissing;
        this.onConflictResolution = onConflictResolution;
        this.onDockerImagePullApproval = onDockerImagePullApproval;
    }
    // ── Public API ───────────────────────────────────────────────────
    async install(ctx) {
        this.cancelled = false;
        this.lastLaunchPort = undefined;
        try {
            // Step 1: detect conflicts (local version check)
            await this.reportProgress(ctx.projectId, 10, 'Checking environment');
            const useVenv = await this.checkConflicts(ctx);
            // Step 2: install dependencies
            await this.reportProgress(ctx.projectId, 30, 'Installing dependencies');
            const installOk = await this.runInstall(ctx, useVenv);
            if (!installOk)
                return false;
            // Step 3: write .env if needed
            await this.reportProgress(ctx.projectId, 80, 'Writing configuration');
            await this.writeEnvFile(ctx);
            // Step 4: launch
            await this.reportProgress(ctx.projectId, 90, 'Launching application');
            const port = await this.launch(ctx, useVenv);
            this.lastLaunchPort = port;
            await this.reportComplete(ctx.projectId, true, port);
            return true;
        }
        catch (err) {
            if (err instanceof DockerFallbackRequestedError) {
                try {
                    this.onLog('[Docker] Conflict redirected to Docker fallback. Launching containerized project...');
                    const dockerPort = await this.runDockerFallback(ctx);
                    this.lastLaunchPort = dockerPort;
                    await this.reportComplete(ctx.projectId, true, dockerPort);
                    return true;
                }
                catch (dockerErr) {
                    this.onLog(`[Error] Docker fallback failed: ${dockerErr?.message ?? dockerErr}`, 'error');
                    await this.reportComplete(ctx.projectId, false, undefined, dockerErr?.message ?? 'Docker fallback failed');
                    return false;
                }
            }
            this.onLog(`[Error] ${err?.message ?? err}`, 'error');
            await this.reportComplete(ctx.projectId, false, undefined, err?.message);
            return false;
        }
    }
    cancel() {
        this.cancelled = true;
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGTERM');
        }
    }
    getLastLaunchPort() {
        return this.lastLaunchPort;
    }
    // ── Private: conflict check ──────────────────────────────────────
    async checkConflicts(ctx) {
        let useVenv = false;
        const requestedPort = ctx.launchPort ?? this.defaultPort(ctx.projectType);
        const toolChecks = {
            nodejs: { cmd: 'node', install: 'https://nodejs.org' },
            python: { cmd: 'python', install: 'https://python.org' },
            php: { cmd: 'php', install: 'https://php.net' },
            java: { cmd: 'java', install: 'https://adoptium.net' },
            ruby: { cmd: 'ruby', install: 'https://www.ruby-lang.org' },
            go: { cmd: 'go', install: 'https://go.dev' },
        };
        const toolCheck = toolChecks[ctx.projectType];
        if (toolCheck) {
            while (true) {
                const version = await this.getVersion(toolCheck.cmd, '--version');
                if (version) {
                    this.onLog(`[Info] ${toolCheck.cmd} ${version} detected`);
                    break;
                }
                const message = `${toolCheck.cmd} is not installed or not in PATH. Install it from ${toolCheck.install} then try again.`;
                const choice = await this.resolveConflict({
                    component: toolCheck.cmd,
                    projectType: ctx.projectType,
                    message,
                    installUrl: toolCheck.install,
                });
                if (choice === 'docker') {
                    throw new DockerFallbackRequestedError(`User chose Docker for ${ctx.projectType}.`);
                }
                this.onLog(`[Info] Retrying ${toolCheck.cmd} check after user resolution...`);
            }
        }
        if (ctx.projectType === 'python') {
            const localVersion = await this.getVersion('python', '--version');
            const required = ctx.versionConstraints?.python;
            if (required && localVersion) {
                const localMajor = parseInt(localVersion.split('.')[0]);
                const reqMajor = parseInt(required.replace(/[^0-9.]/g, '').split('.')[0]);
                if (localMajor < reqMajor) {
                    this.onLog(`[Warning] Python ${localVersion} found, ${required} required — using venv`);
                    useVenv = true;
                }
            }
            useVenv = true; // always use venv for Python — best practice
        }
        if (ctx.projectType === 'nodejs') {
            await this.checkNodePmAvailable(ctx.hostPath);
        }
        if (ctx.projectType === 'java') {
            const mvnOrGradle = await this.resolveJavaBuildTool(ctx.hostPath);
            if (!mvnOrGradle) {
                const choice = await this.resolveConflict({
                    component: 'mvn/gradle',
                    projectType: ctx.projectType,
                    message: 'Neither Maven (mvn) nor Gradle was found. Install one and retry.',
                    installUrl: 'https://maven.apache.org',
                });
                if (choice === 'docker') {
                    throw new DockerFallbackRequestedError('User chose Docker for java project.');
                }
                const retryTool = await this.resolveJavaBuildTool(ctx.hostPath);
                if (!retryTool) {
                    throw new Error('Neither Maven (mvn) nor Gradle was found after retry.');
                }
            }
        }
        if (ctx.projectType === 'ruby') {
            const bundler = await this.commandExists('bundle');
            if (!bundler) {
                if (await this.commandExists('gem')) {
                    this.onLog('[Info] bundler not found, installing...');
                    const bundlerOk = await this.runCommand('gem install bundler', ctx.hostPath, ctx.projectId);
                    if (!bundlerOk) {
                        throw new Error('Failed to install bundler. Install Ruby bundler manually and try again.');
                    }
                }
                else {
                    const choice = await this.resolveConflict({
                        component: 'bundler',
                        projectType: ctx.projectType,
                        message: 'bundler is not installed and gem is unavailable. Install Ruby Bundler and retry.',
                        installUrl: 'https://bundler.io',
                    });
                    if (choice === 'docker') {
                        throw new DockerFallbackRequestedError('User chose Docker for ruby project.');
                    }
                    if (!(await this.commandExists('bundle'))) {
                        throw new Error('bundler is still unavailable after retry.');
                    }
                }
            }
        }
        const requestedPortAvailable = await this.isPortAvailable(requestedPort);
        if (!requestedPortAvailable) {
            const fallbackPort = await this.findAvailablePort(requestedPort + 1);
            if (fallbackPort) {
                ctx.launchPort = fallbackPort;
                this.onLog(`[Conflict] Port ${requestedPort} is already in use. Reassigned launch port to ${fallbackPort}`);
            }
            else {
                throw new Error(`Port ${requestedPort} is already in use and no fallback port could be reserved`);
            }
        }
        else {
            ctx.launchPort = requestedPort;
            this.onLog(`[Info] Port ${requestedPort} is available for launch`);
        }
        return useVenv;
    }
    // ── Private: install dependencies ───────────────────────────────
    async runInstall(ctx, useVenv) {
        const cwd = ctx.hostPath;
        if (ctx.projectType === 'nodejs') {
            // Only install if package.json exists
            if (!fs.existsSync(path.join(cwd, 'package.json'))) {
                this.onLog('[Warning] No package.json found, skipping npm install');
                return true;
            }
            const pm = this.detectNodePm(cwd);
            this.onLog(`[Info] Package manager: ${pm}`);
            return await this.runCommand(`${pm} install`, cwd, ctx.projectId);
        }
        if (ctx.projectType === 'python') {
            const hasPyproject = fs.existsSync(path.join(cwd, 'pyproject.toml'));
            const hasPipfile = fs.existsSync(path.join(cwd, 'Pipfile'));
            const hasReqs = fs.existsSync(path.join(cwd, 'requirements.txt'));
            if (!hasPyproject && !hasPipfile && !hasReqs) {
                this.onLog('[Warning] No dependency file found (requirements.txt / pyproject.toml / Pipfile). Skipping install.');
                return true;
            }
            if (hasPyproject) {
                const poetryOk = await this.commandExists('poetry');
                if (poetryOk) {
                    this.onLog('[Info] Package manager: poetry');
                    return await this.runCommand('poetry install', cwd, ctx.projectId);
                }
                this.onLog('[Warning] pyproject.toml found but poetry not installed, falling back to pip');
            }
            if (hasPipfile) {
                const pipenvOk = await this.commandExists('pipenv');
                if (pipenvOk) {
                    this.onLog('[Info] Package manager: pipenv');
                    return await this.runCommand('pipenv install', cwd, ctx.projectId);
                }
                this.onLog('[Warning] Pipfile found but pipenv not installed, falling back to pip');
            }
            // pip path
            if (useVenv) {
                const venvOk = await this.runCommand(`${this.resolvePythonBin(cwd, false)} -m venv .venv`, cwd, ctx.projectId);
                if (!venvOk)
                    return false;
            }
            if (hasReqs) {
                return await this.pipInstallWithFallback(cwd, ctx.projectId);
            }
            return true;
        }
        if (ctx.projectType === 'php') {
            if (!fs.existsSync(path.join(cwd, 'composer.json'))) {
                this.onLog('[Warning] No composer.json found, skipping composer install');
                return true;
            }
            if (!(await this.commandExists('composer'))) {
                throw new Error('composer is not installed. Install it from https://getcomposer.org then try again.');
            }
            this.onLog('[Info] Package manager: composer');
            return await this.runCommand('composer install', cwd, ctx.projectId);
        }
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildTool(cwd);
            if (!tool) {
                throw new Error('No Java build tool found. Install Maven or Gradle and try again.');
            }
            this.onLog(`[Info] Build tool: ${tool}`);
            if (tool === 'gradle') {
                const javaVersion = await this.getVersion('java', '--version');
                const gradleVersion = await this.getGradleVersion(cwd);
                this.onLog(`[Info] Gradle preflight: wrapper ${gradleVersion ?? 'unknown'}, java ${javaVersion ?? 'unknown'}`);
                if (this.isGradleJavaIncompatible(gradleVersion, javaVersion)) {
                    const incompatMessage = `Gradle ${gradleVersion ?? 'unknown'} is incompatible with Java ${javaVersion ?? 'unknown'}. ` +
                        `Use Java 11 for this project, or upgrade Gradle wrapper to 7.3+ (8+ recommended).`;
                    const choice = await this.resolveConflict({
                        component: 'gradle/java',
                        projectType: ctx.projectType,
                        message: incompatMessage,
                        installUrl: 'https://docs.gradle.org/current/userguide/compatibility.html',
                    });
                    if (choice === 'docker') {
                        throw new DockerFallbackRequestedError('User chose Docker for gradle/java incompatibility.');
                    }
                    const javaRetry = await this.getVersion('java', '--version');
                    const gradleRetry = await this.getGradleVersion(cwd);
                    if (this.isGradleJavaIncompatible(gradleRetry, javaRetry)) {
                        throw new Error(incompatMessage);
                    }
                }
            }
            if (tool === 'maven') {
                return await this.runCommand('mvn dependency:resolve -q', cwd, ctx.projectId);
            }
            const gradlew = this.gradleWrapper(cwd);
            return await this.runCommand(`${gradlew} dependencies --configuration runtimeClasspath -q`, cwd, ctx.projectId);
        }
        if (ctx.projectType === 'ruby') {
            if (!fs.existsSync(path.join(cwd, 'Gemfile'))) {
                this.onLog('[Warning] No Gemfile found, skipping bundler install');
                return true;
            }
            this.onLog('[Info] Package manager: bundler');
            return await this.runCommand('bundle install', cwd, ctx.projectId);
        }
        if (ctx.projectType === 'go') {
            if (!fs.existsSync(path.join(cwd, 'go.mod'))) {
                this.onLog('[Warning] No go.mod found, skipping go mod download');
                return true;
            }
            this.onLog('[Info] Package manager: go modules');
            return await this.runCommand('go mod download', cwd, ctx.projectId);
        }
        return true;
    }
    async pipInstallWithFallback(cwd, projectId) {
        const reqFile = path.join(cwd, 'requirements.txt');
        if (!fs.existsSync(reqFile)) {
            this.onLog('[Warning] No requirements.txt found, skipping pip install');
            return true;
        }
        // First attempt: pinned versions
        const pip = this.getPipCmd(cwd);
        const ok = await this.runCommand(`${pip} install -r requirements.txt`, cwd, projectId);
        if (ok)
            return true;
        // Second attempt: each package individually with unpinned fallback
        this.onLog('[Info] Retrying with individual package installs...');
        const lines = fs.readFileSync(reqFile, 'utf8').split('\n');
        for (const line of lines) {
            const pkg = line.trim();
            if (!pkg || pkg.startsWith('#'))
                continue;
            const pinOk = await this.runCommand(`${pip} install "${pkg}"`, cwd, projectId);
            if (!pinOk) {
                const name = pkg.split(/[>=<!~[]/)[0].trim();
                this.onLog(`[Fallback] ${pkg} failed, trying unpinned: ${name}`);
                await this.runCommand(`${pip} install "${name}"`, cwd, projectId);
                // continue even if fallback fails — some packages are optional
            }
        }
        return true;
    }
    // ── Private: .env writing ────────────────────────────────────────
    async writeEnvFile(ctx) {
        if (!ctx.envVars || Object.keys(ctx.envVars).length === 0)
            return;
        const envPath = path.join(ctx.hostPath, '.env');
        const examplePath = path.join(ctx.hostPath, '.env.example');
        // Start from .env.example if it exists
        let existing = {};
        if (fs.existsSync(examplePath)) {
            const lines = fs.readFileSync(examplePath, 'utf8').split('\n');
            for (const line of lines) {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match)
                    existing[match[1].trim()] = match[2].trim();
            }
        }
        // Merge with NLP-extracted env vars
        const merged = { ...existing, ...ctx.envVars };
        const content = Object.entries(merged)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        fs.writeFileSync(envPath, content, 'utf8');
        this.onLog(`[Info] Written .env (${Object.keys(merged).length} variables)`);
    }
    // ── Private: launch ──────────────────────────────────────────────
    async launch(ctx, useVenv) {
        const cwd = ctx.hostPath;
        // ── Always re-derive the command from what's actually on disk ──
        // Never trust ctx.runCommand from NLP — it may reference tools
        // that aren't installed (poetry, pipenv, etc.)
        const cmd = await this.resolveRunCommand(ctx, useVenv);
        const port = await this.resolvePort(ctx);
        this.onLog(`[Launch] Starting: ${cmd}`);
        this.onLog(`[Launch] cwd: ${cwd}`);
        this.onLog(`[Launch] port: ${port}`);
        const launchEnv = {
            ...process.env,
            PORT: String(port),
        };
        if (await this.shouldSkipCraPreflight(cwd, cmd)) {
            launchEnv.SKIP_PREFLIGHT_CHECK = 'true';
            this.onLog('[Info] Enabled CRA preflight bypass for this launch');
        }
        if (await this.shouldEnableLegacyOpenSsl(cwd, cmd)) {
            launchEnv.NODE_OPTIONS = `${launchEnv.NODE_OPTIONS ?? ''} --openssl-legacy-provider`.trim();
            this.onLog('[Info] Enabled legacy OpenSSL provider for this launch');
        }
        this.proc = cp.spawn(cmd, [], {
            cwd,
            shell: true,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: launchEnv,
        });
        this.proc.stdout?.on('data', (d) => d.toString().split('\n').filter(Boolean)
            .forEach(line => this.onLog(line.trim())));
        this.proc.stderr?.on('data', (d) => d.toString().split('\n').filter(Boolean)
            .forEach(line => this.onLog(line.trim(), 'stderr')));
        // Give process 2s to crash before checking port
        await new Promise(r => setTimeout(r, 2000));
        if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
            throw new Error(`Process exited immediately with code ${this.proc.exitCode}. ` +
                `Check the output above for errors.`);
        }
        const shouldWaitForPort = this.shouldWaitForPort(ctx.projectType, cmd);
        if (!shouldWaitForPort) {
            this.onLog('[Info] Skipping port readiness check for non-server command.');
            return port;
        }
        const waitTimeoutMs = (ctx.projectType === 'java' || ctx.projectType === 'go') ? 60_000 : 30_000;
        const bound = await this.waitForPort(port, waitTimeoutMs);
        if (!bound) {
            if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
                throw new Error(`Process exited with code ${this.proc.exitCode}`);
            }
            this.onLog(`[Warning] Port ${port} not responding after ${Math.round(waitTimeoutMs / 1000)}s`);
        }
        return port;
    }
    async resolveRunCommand(ctx, useVenv) {
        const cwd = ctx.hostPath;
        const normalizedRunCommand = (ctx.runCommand ?? '').trim();
        if (normalizedRunCommand.length > 0) {
            if (ctx.projectType === 'nodejs') {
                const pkg = path.join(cwd, 'package.json');
                if (fs.existsSync(pkg)) {
                    const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
                    const scriptMatch = normalizedRunCommand.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)$/i);
                    if (scriptMatch) {
                        const scriptName = scriptMatch[1];
                        if (!scripts[scriptName]) {
                            this.onLog(`[Warning] Backend run command "${normalizedRunCommand}" references missing script "${scriptName}". Falling back to detected scripts.`);
                        }
                        else {
                            return normalizedRunCommand;
                        }
                    }
                    else {
                        return normalizedRunCommand;
                    }
                }
                else {
                    return normalizedRunCommand;
                }
            }
            else {
                return normalizedRunCommand;
            }
        }
        // ── Node.js ───────────────────────────────────────────────────
        if (ctx.projectType === 'nodejs') {
            const pm = this.detectNodePm(cwd);
            const pkg = path.join(cwd, 'package.json');
            if (fs.existsSync(pkg)) {
                const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
                if (scripts.start)
                    return `${pm} start`;
                if (scripts.dev)
                    return `${pm} run dev`;
                if (scripts.serve)
                    return `${pm} run serve`;
                if (scripts.preview)
                    return `${pm} run preview`;
                const scriptNames = Object.keys(scripts);
                throw new Error(`No runnable Node script found. Expected one of start/dev/serve/preview, but found: ` +
                    (scriptNames.length ? scriptNames.join(', ') : 'none'));
            }
            throw new Error('No package.json found to determine Node launch command.');
        }
        // ── Python ────────────────────────────────────────────────────
        if (ctx.projectType === 'python') {
            // Find the actual python binary to use
            const pythonBin = this.resolvePythonBin(cwd, useVenv);
            // Priority 1: manage.py → Django (search recursively)
            const managePy = await this.findFileRecursive(cwd, 'manage.py');
            if (managePy) {
                const port = await this.resolvePort(ctx);
                return `${pythonBin} ${managePy} runserver 0.0.0.0:${port}`;
            }
            // Priority 2: known entry points (search recursively)
            for (const f of ['app.py', 'main.py', 'run.py', 'server.py', 'wsgi.py']) {
                const found = await this.findFileRecursive(cwd, f);
                if (found) {
                    return `${pythonBin} ${found}`;
                }
            }
            // Priority 3: check if uvicorn is installed and there's an asgi app (search recursively)
            for (const f of ['asgi.py', 'application.py']) {
                const found = await this.findFileRecursive(cwd, f);
                if (found) {
                    const port = await this.resolvePort(ctx);
                    const module = found.replace(/\.py$/, '').replace(/[\\/]/g, '.');
                    return `${pythonBin} -m uvicorn ${module}:app --host 0.0.0.0 --port ${port}`;
                }
            }
            // Priority 4: fall back to flask run if flask is in requirements
            if (await this.requirementsMentions(cwd, 'flask')) {
                const port = await this.resolvePort(ctx);
                return `${pythonBin} -m flask run --host=0.0.0.0 --port=${port}`;
            }
            // Priority 5: nothing found — tell the user clearly
            throw new Error(`Cannot determine how to start this Python project. ` +
                `No manage.py, app.py, main.py, or run.py found in ${cwd} or subdirectories.`);
        }
        // ── PHP ───────────────────────────────────────────────────────
        if (ctx.projectType === 'php') {
            if (fs.existsSync(path.join(cwd, 'artisan'))) {
                return `php artisan serve --port=${await this.resolvePort(ctx)}`;
            }
            if (fs.existsSync(path.join(cwd, 'bin', 'console'))) {
                return `php -S 0.0.0.0:${await this.resolvePort(ctx)} -t public`;
            }
            const entry = this.findPhpEntry(cwd);
            return `php -S 0.0.0.0:${await this.resolvePort(ctx)} ${entry}`;
        }
        // ── Java ─────────────────────────────────────────────────────
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildTool(cwd);
            if (!tool) {
                throw new Error('No Java build tool found for this project');
            }
            if (tool === 'maven') {
                if (await this.fileContains(cwd, 'pom.xml', 'spring-boot')) {
                    return 'mvn spring-boot:run -q';
                }
                return 'mvn spring-boot:run -q';
            }
            const gradlew = this.gradleWrapper(cwd);
            if (await this.fileContains(cwd, 'build.gradle', 'spring-boot') || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot')) {
                return `${gradlew} bootRun`;
            }
            return `${gradlew} run`;
        }
        // ── Ruby ─────────────────────────────────────────────────────
        if (ctx.projectType === 'ruby') {
            const port = await this.resolvePort(ctx);
            if (fs.existsSync(path.join(cwd, 'config', 'application.rb'))) {
                return `bundle exec rails server -p ${port}`;
            }
            for (const f of ['app.rb', 'main.rb', 'server.rb', 'config.ru']) {
                if (fs.existsSync(path.join(cwd, f))) {
                    if (f === 'config.ru')
                        return `bundle exec rackup --port ${port}`;
                    return `bundle exec ruby ${f}`;
                }
            }
            throw new Error('Cannot determine Ruby entry point');
        }
        // ── Go ───────────────────────────────────────────────────────
        if (ctx.projectType === 'go') {
            const mainFile = this.findGoMain(cwd);
            if (mainFile) {
                return `go run ${mainFile}`;
            }
            return 'go run .';
        }
        throw new Error(`Unsupported project type: ${ctx.projectType}`);
    }
    shouldWaitForPort(projectType, cmd) {
        const normalized = cmd.toLowerCase();
        if (projectType === 'java') {
            // For Java, only block on port readiness for likely web/server commands.
            return (normalized.includes('spring-boot:run') ||
                normalized.includes('bootrun') ||
                normalized.includes('quarkus') ||
                normalized.includes('micronaut') ||
                normalized.includes('java -jar'));
        }
        // Keep current behavior for other ecosystems.
        return true;
    }
    resolvePythonBin(cwd, useVenv) {
        if (useVenv) {
            // Windows venv
            const win = path.join(cwd, '.venv', 'Scripts', 'python.exe');
            if (fs.existsSync(win))
                return `"${win}"`;
            // Unix venv
            const unix = path.join(cwd, '.venv', 'bin', 'python');
            if (fs.existsSync(unix))
                return unix;
        }
        // System python
        return process.platform === 'win32' ? 'python' : 'python3';
    }
    async resolvePort(ctx) {
        // Check if the originally intended port is free
        const intended = ctx.launchPort ?? this.defaultPort(ctx.projectType);
        if (!this.isPortInUse(intended))
            return intended;
        // Find next free port
        for (let p = intended + 1; p < intended + 100; p++) {
            if (!this.isPortInUse(p)) {
                this.onLog(`[Conflict] Port ${intended} is in use. Using port ${p} instead`);
                return p;
            }
        }
        return intended;
    }
    defaultPort(projectType) {
        const ports = {
            nodejs: 3000,
            python: 8000,
            php: 8000,
            java: 8080,
            ruby: 3000,
            go: 8080,
        };
        return ports[projectType] ?? 3000;
    }
    isPortInUse(port) {
        // Synchronous check using net
        const net = __webpack_require__(13);
        const server = net.createServer();
        try {
            server.listen(port, '127.0.0.1');
            server.close();
            return false;
        }
        catch {
            return true;
        }
    }
    async requirementsMentions(cwd, pkg) {
        const req = path.join(cwd, 'requirements.txt');
        if (!fs.existsSync(req))
            return false;
        return fs.readFileSync(req, 'utf8').toLowerCase().includes(pkg.toLowerCase());
    }
    async checkNodePmAvailable(cwd) {
        const pm = this.detectNodePm(cwd);
        if (pm === 'npm') {
            return;
        }
        const exists = await this.commandExists(pm);
        if (!exists) {
            this.onLog(`[Warning] ${pm} not found, falling back to npm`);
        }
    }
    async resolveJavaBuildTool(cwd) {
        if (fs.existsSync(path.join(cwd, 'pom.xml')) && await this.commandExists('mvn')) {
            return 'maven';
        }
        const hasGradleFile = fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'));
        if (hasGradleFile && (fs.existsSync(path.join(cwd, 'gradlew')) || fs.existsSync(path.join(cwd, 'gradlew.bat')) || await this.commandExists('gradle'))) {
            return 'gradle';
        }
        return null;
    }
    async resolveJavaBuildToolForDocker(cwd) {
        const pom = await this.findFileRecursive(cwd, 'pom.xml', 3);
        if (pom) {
            return 'maven';
        }
        const gradle = await this.findFileRecursive(cwd, 'build.gradle', 3)
            || await this.findFileRecursive(cwd, 'build.gradle.kts', 3);
        if (gradle) {
            return 'gradle';
        }
        return null;
    }
    gradleWrapper(cwd) {
        const win = path.join(cwd, 'gradlew.bat');
        const unix = path.join(cwd, 'gradlew');
        if (process.platform === 'win32' && fs.existsSync(win))
            return 'gradlew.bat';
        if (fs.existsSync(unix))
            return './gradlew';
        return 'gradle';
    }
    async getGradleVersion(cwd) {
        const wrapperVersion = this.getGradleVersionFromWrapper(cwd);
        if (wrapperVersion) {
            return wrapperVersion;
        }
        const cmd = `${this.gradleWrapper(cwd)} --version`;
        const output = await this.execAndCapture(cmd, cwd);
        if (!output) {
            return null;
        }
        const match = output.match(/Gradle\s+(\d+(?:\.\d+){0,2})/i);
        return match ? match[1] : null;
    }
    getGradleVersionFromWrapper(cwd) {
        const wrapperPropsPath = path.join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties');
        if (!fs.existsSync(wrapperPropsPath)) {
            return null;
        }
        try {
            const content = fs.readFileSync(wrapperPropsPath, 'utf8');
            const match = content.match(/distributionUrl=.*gradle-(\d+(?:\.\d+){0,2})-(?:bin|all)\.zip/i);
            return match ? match[1] : null;
        }
        catch {
            return null;
        }
    }
    isGradleJavaIncompatible(gradleVersion, javaVersion) {
        if (!gradleVersion || !javaVersion) {
            return false;
        }
        const gradleMajor = parseInt(gradleVersion.split('.')[0], 10);
        const javaMajor = parseInt(javaVersion.split('.')[0], 10);
        if (Number.isNaN(gradleMajor) || Number.isNaN(javaMajor)) {
            return false;
        }
        if (javaMajor >= 17 && gradleMajor < 7) {
            return true;
        }
        if (javaMajor >= 21 && gradleMajor < 8) {
            return true;
        }
        return false;
    }
    findPhpEntry(cwd) {
        // Common entry points in order of priority
        const candidates = [
            'index.php',
            'public/index.php',
            'public_html/index.php',
            'src/index.php',
            'app/index.php',
            'www/index.php',
        ];
        for (const f of candidates) {
            if (fs.existsSync(path.join(cwd, f)))
                return f;
        }
        // Last resort — find any .php file in root
        const rootPhp = fs.readdirSync(cwd).find(f => f.endsWith('.php'));
        return rootPhp ?? 'index.php';
    }
    findGoMain(cwd) {
        if (fs.existsSync(path.join(cwd, 'main.go'))) {
            return 'main.go';
        }
        const cmdDir = path.join(cwd, 'cmd');
        if (fs.existsSync(cmdDir)) {
            const subdirs = fs.readdirSync(cmdDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
            if (subdirs.length > 0) {
                return `./cmd/${subdirs[0].name}`;
            }
        }
        return null;
    }
    async fileContains(cwd, file, text) {
        const fullPath = path.join(cwd, file);
        if (!fs.existsSync(fullPath))
            return false;
        return fs.readFileSync(fullPath, 'utf8').includes(text);
    }
    inferRunCommand(ctx, useVenv) {
        if (ctx.projectType === 'nodejs') {
            const pm = this.detectNodePm(ctx.hostPath);
            return `${pm} start`;
        }
        if (ctx.projectType === 'python') {
            // Check for common entry points
            const candidates = ['manage.py', 'app.py', 'main.py', 'run.py', 'wsgi.py'];
            for (const f of candidates) {
                if (fs.existsSync(path.join(ctx.hostPath, f))) {
                    if (f === 'manage.py')
                        return 'python manage.py runserver';
                    return `python ${f}`;
                }
            }
            return 'python app.py';
        }
        return '';
    }
    async shouldSkipCraPreflight(cwd, cmd) {
        if (!cmd.includes('npm start') && !cmd.includes('react-scripts start')) {
            return false;
        }
        const packageJsonPath = path.join(cwd, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return false;
        }
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const scripts = packageJson.scripts ?? {};
            const dependencies = {
                ...(packageJson.dependencies ?? {}),
                ...(packageJson.devDependencies ?? {}),
            };
            return Boolean(String(scripts.start ?? '').includes('react-scripts') ||
                dependencies['react-scripts']);
        }
        catch {
            return false;
        }
    }
    async shouldEnableLegacyOpenSsl(cwd, cmd) {
        const packageJsonPath = path.join(cwd, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return false;
        }
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const scripts = packageJson.scripts ?? {};
            const dependencies = {
                ...(packageJson.dependencies ?? {}),
                ...(packageJson.devDependencies ?? {}),
            };
            const startScript = String(scripts.start ?? '');
            const usesReactScripts = startScript.includes('react-scripts') || Boolean(dependencies['react-scripts']);
            const usesWebpack4 = /^4\./.test(String(dependencies.webpack ?? ''));
            const launchesFrontendDev = /npm\s+start|react-scripts\s+start|webpack-dev-server/.test(cmd);
            return launchesFrontendDev && (usesReactScripts || usesWebpack4);
        }
        catch {
            return false;
        }
    }
    // ── Private: helpers ─────────────────────────────────────────────
    async findFileRecursive(cwd, filename, maxDepth = 3, currentDepth = 0) {
        if (currentDepth > maxDepth)
            return null;
        const fullPath = path.join(cwd, filename);
        if (fs.existsSync(fullPath)) {
            return filename;
        }
        try {
            const entries = fs.readdirSync(cwd, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    const subPath = path.join(cwd, entry.name);
                    const result = await this.findFileRecursive(subPath, filename, maxDepth, currentDepth + 1);
                    if (result) {
                        return path.join(entry.name, result).replace(/\\/g, '/');
                    }
                }
            }
        }
        catch {
            // If directory read fails, continue
        }
        return null;
    }
    detectNodePm(cwd) {
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')))
            return 'pnpm';
        if (fs.existsSync(path.join(cwd, 'yarn.lock')))
            return 'yarn';
        return 'npm';
    }
    detectPythonPm(cwd) {
        if (fs.existsSync(path.join(cwd, 'pyproject.toml')))
            return 'poetry';
        if (fs.existsSync(path.join(cwd, 'Pipfile')))
            return 'pipenv';
        return 'pip';
    }
    getPipCmd(cwd) {
        const win = path.join(cwd, '.venv', 'Scripts', 'pip.exe');
        const unix = path.join(cwd, '.venv', 'bin', 'pip');
        if (fs.existsSync(win))
            return `"${win}"`;
        if (fs.existsSync(unix))
            return unix;
        return 'pip';
    }
    async commandExists(cmd) {
        return new Promise(resolve => {
            cp.exec(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, (err) => resolve(!err));
        });
    }
    async getVersion(cmd, flag) {
        return new Promise(resolve => {
            cp.exec(`${cmd} ${flag}`, (err, stdout, stderr) => {
                if (err) {
                    resolve(null);
                    return;
                }
                const output = (stdout || stderr).trim();
                const match = output.match(/(\d+\.\d+[\.\d]*)/);
                resolve(match ? match[1] : output);
            });
        });
    }
    async execAndCapture(cmd, cwd) {
        return new Promise((resolve) => {
            cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
                if (err) {
                    resolve('');
                    return;
                }
                resolve((stdout || stderr || '').trim());
            });
        });
    }
    async execAndCaptureResult(cmd, cwd) {
        return new Promise((resolve) => {
            cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
                const output = (stdout || '').trim();
                const errorOutput = (stderr || err?.message || '').trim();
                if (err) {
                    resolve({ ok: false, output, errorOutput });
                    return;
                }
                resolve({ ok: true, output: output || errorOutput, errorOutput: '' });
            });
        });
    }
    async resolveConflict(info) {
        const missingRuntimePattern = /(not\s+installed|not\s+found|missing|unavailable)/i;
        if (this.onRuntimeMissing && info.installUrl && missingRuntimePattern.test(info.message)) {
            await this.onRuntimeMissing({
                tool: info.component,
                installUrl: info.installUrl,
                projectType: info.projectType,
                message: info.message,
            });
        }
        this.onLog('[Paused] Installation is waiting for your conflict resolution choice in the extension panel.');
        if (this.onConflictResolution) {
            return await this.onConflictResolution(info);
        }
        return 'manual';
    }
    async runDockerFallback(ctx) {
        await this.reportProgress(ctx.projectId, 35, 'Preparing Docker fallback');
        const hasDocker = await this.commandExists('docker');
        if (!hasDocker) {
            throw new Error('Docker is not installed or not in PATH. Install Docker Desktop and retry.');
        }
        const cwd = ctx.hostPath;
        let port = await this.resolvePort(ctx);
        const normalizedPath = cwd.replace(/\\/g, '/');
        const containerBaseName = `pa-${ctx.projectId.slice(-8)}-${Date.now()}`;
        const image = await this.resolveDockerImage(ctx, cwd);
        const hasImage = await this.dockerImageExists(image, cwd);
        if (!hasImage) {
            const approved = this.onDockerImagePullApproval
                ? await this.onDockerImagePullApproval(image)
                : false;
            if (!approved) {
                throw new Error(`Docker image ${image} is not available locally and pull was not approved.`);
            }
            this.onLog(`[Docker] Pulling image ${image}...`);
            const pullResult = await this.execAndCaptureResult(`docker pull ${image}`, cwd);
            if (!pullResult.ok) {
                const details = pullResult.errorOutput || pullResult.output || 'No output from docker pull.';
                this.onLog(`[Docker] docker pull failed: ${details}`, 'error');
                throw new Error(`Failed to pull Docker image ${image}. ${details}`);
            }
            this.onLog(`[Docker] Image ready: ${image}`);
        }
        let containerName = '';
        let containerId = '';
        let lastDockerError = '';
        for (let attempt = 1; attempt <= 6; attempt += 1) {
            containerName = `${containerBaseName}-${attempt}`;
            const containerScript = await this.resolveDockerScript(ctx, cwd, port);
            const escapedScript = containerScript.replace(/"/g, '\\"');
            await this.execAndCapture(`docker rm -f ${containerName}`, cwd);
            const dockerRunCmd = `docker run -d --name ${containerName} --rm ` +
                `--entrypoint sh ` +
                `-p ${port}:${port} -w /workspace ` +
                `-v "${normalizedPath}:/workspace" -e PORT=${port} ` +
                `${image} -lc "${escapedScript}"`;
            this.onLog(`[Docker] Starting container with image ${image} on port ${port} (attempt ${attempt}/6)`);
            const dockerRun = await this.execAndCaptureResult(dockerRunCmd, cwd);
            containerId = dockerRun.output;
            if (dockerRun.ok && containerId) {
                break;
            }
            const details = dockerRun.errorOutput || 'No stderr output from docker command.';
            lastDockerError = details;
            const portBusy = /port is already allocated|bind for 0\.0\.0\.0:\d+ failed/i.test(details);
            if (!portBusy || attempt === 6) {
                this.onLog(`[Docker] docker run failed: ${details}`, 'error');
                throw new Error(`Failed to start Docker container. ${details}`);
            }
            const nextPort = await this.findAvailablePort(port + 1, 100);
            if (!nextPort) {
                this.onLog(`[Docker] docker run failed: ${details}`, 'error');
                throw new Error(`Failed to start Docker container. ${details}`);
            }
            this.onLog(`[Docker] Port ${port} is busy. Retrying on port ${nextPort}.`, 'warning');
            port = nextPort;
        }
        if (!containerId) {
            const details = lastDockerError || 'Unknown docker run error.';
            this.onLog(`[Docker] docker run failed: ${details}`, 'error');
            throw new Error(`Failed to start Docker container. ${details}`);
        }
        this.onLog(`[Docker] Container started: ${containerName}`);
        this.onLog(`[Docker] Logs: docker logs -f ${containerName}`);
        await this.reportProgress(ctx.projectId, 90, 'Launching application in Docker');
        const waitMs = ctx.projectType === 'java' ? 180_000 : 90_000;
        const bound = await this.waitForPort(port, waitMs);
        if (!bound) {
            const running = await this.isContainerRunning(containerName, cwd);
            const recentLogs = await this.execAndCapture(`docker logs --tail 80 ${containerName}`, cwd);
            if (!running) {
                throw new Error(`Docker container exited before becoming ready on port ${port}. ` +
                    `Recent logs:\n${recentLogs || 'No container logs available.'}`);
            }
            throw new Error(`Docker container is running but port ${port} is not responding after ${Math.round(waitMs / 1000)}s. ` +
                `Recent logs:\n${recentLogs || 'No container logs available.'}`);
        }
        return port;
    }
    async dockerImageExists(image, cwd) {
        const inspect = await this.execAndCaptureResult(`docker image inspect ${image}`, cwd);
        return inspect.ok;
    }
    async isContainerRunning(containerName, cwd) {
        const result = await this.execAndCapture(`docker inspect -f "{{.State.Running}}" ${containerName}`, cwd);
        return result.trim().toLowerCase() === 'true';
    }
    async resolveDockerImage(ctx, cwd) {
        if (ctx.projectType === 'nodejs')
            return 'node:20-bookworm';
        if (ctx.projectType === 'python')
            return 'python:3.11-bookworm';
        if (ctx.projectType === 'php') {
            return fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer:2' : 'php:8.2-cli';
        }
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildToolForDocker(cwd);
            if (!tool) {
                this.onLog('[Warning] Could not detect pom.xml/build.gradle. Defaulting Java Docker image to Maven.', 'warning');
            }
            return tool === 'gradle' ? 'gradle:8.7-jdk17' : 'maven:3.9-eclipse-temurin-17';
        }
        if (ctx.projectType === 'ruby')
            return 'ruby:3.3';
        if (ctx.projectType === 'go')
            return 'golang:1.22';
        return 'ubuntu:24.04';
    }
    async resolveDockerScript(ctx, cwd, port) {
        if (ctx.projectType === 'nodejs') {
            const install = fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'npm ci' : 'npm install';
            const runCmd = (await this.resolveRunCommand(ctx, false)).replace(/^pnpm\s+|^yarn\s+/, 'npm ');
            return `${install} && ${runCmd}`;
        }
        if (ctx.projectType === 'python') {
            const install = fs.existsSync(path.join(cwd, 'requirements.txt')) ? 'pip install -r requirements.txt && ' : '';
            const runCmd = (await this.resolveRunCommand(ctx, false)).replace(/^"?[A-Za-z]:[^\s"]*python(?:\.exe)?"?\s+/i, 'python ');
            return `${install}${runCmd}`;
        }
        if (ctx.projectType === 'php') {
            const composerInstall = fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer install && ' : '';
            if (fs.existsSync(path.join(cwd, 'artisan'))) {
                return `${composerInstall}php artisan serve --host=0.0.0.0 --port=${port}`;
            }
            const publicIndex = path.join(cwd, 'public', 'index.php');
            if (fs.existsSync(publicIndex)) {
                return `${composerInstall}php -S 0.0.0.0:${port} -t public public/index.php`;
            }
            const rootIndex = path.join(cwd, 'index.php');
            if (fs.existsSync(rootIndex)) {
                return `${composerInstall}php -S 0.0.0.0:${port} -t . index.php`;
            }
            const entry = this.findPhpEntry(cwd);
            return `${composerInstall}php -S 0.0.0.0:${port} -t ${path.dirname(entry) === '.' ? '.' : path.dirname(entry)} ${entry}`;
        }
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildToolForDocker(cwd);
            if (!tool || tool === 'maven') {
                return `mvn spring-boot:run -q -Dspring-boot.run.arguments=--server.port=${port}`;
            }
            const hasSpring = await this.fileContains(cwd, 'build.gradle', 'spring-boot')
                || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot');
            return hasSpring
                ? `gradle bootRun --no-daemon --args='--server.port=${port}'`
                : 'gradle run --no-daemon';
        }
        if (ctx.projectType === 'ruby') {
            if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
                const rails = fs.existsSync(path.join(cwd, 'config', 'application.rb'));
                return rails
                    ? `bundle install && bundle exec rails server -b 0.0.0.0 -p ${port}`
                    : `bundle install && bundle exec ruby ${this.findRubyEntry(cwd)}`;
            }
            return `ruby ${this.findRubyEntry(cwd)}`;
        }
        if (ctx.projectType === 'go') {
            const mainFile = this.findGoMain(cwd);
            return mainFile ? `go run ${mainFile}` : 'go run .';
        }
        return 'sleep infinity';
    }
    findRubyEntry(cwd) {
        for (const f of ['app.rb', 'main.rb', 'server.rb']) {
            if (fs.existsSync(path.join(cwd, f))) {
                return f;
            }
        }
        return 'main.rb';
    }
    runCommand(cmd, cwd, projectId) {
        return new Promise(resolve => {
            if (this.cancelled) {
                resolve(false);
                return;
            }
            this.onLog(`[Run] ${cmd}`);
            const proc = cp.spawn(cmd, [], {
                cwd,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.stdout?.on('data', (d) => d.toString().split('\n').filter(Boolean)
                .forEach(line => this.onLog(line.trim())));
            proc.stderr?.on('data', (d) => d.toString().split('\n').filter(Boolean)
                .forEach(line => this.onLog(line.trim(), 'stderr')));
            proc.on('close', code => resolve(code === 0));
            proc.on('error', err => {
                this.onLog(`[Error] ${err.message}`, 'error');
                resolve(false);
            });
        });
    }
    waitForPort(port, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const net = __webpack_require__(13);
            const check = () => {
                if (Date.now() - start > timeoutMs) {
                    resolve(false);
                    return;
                }
                const sock = new net.Socket();
                sock.setTimeout(500);
                sock.on('connect', () => { sock.destroy(); resolve(true); });
                sock.on('error', () => { sock.destroy(); setTimeout(check, 1000); });
                sock.on('timeout', () => { sock.destroy(); setTimeout(check, 1000); });
                sock.connect(port, '127.0.0.1');
            };
            check();
        });
    }
    async isPortAvailable(port) {
        const hasActiveListener = (await this.canConnectToPort(port, '127.0.0.1')) ||
            (await this.canConnectToPort(port, '::1'));
        if (hasActiveListener) {
            return false;
        }
        const canBindV4 = await this.canBindPort(port, '0.0.0.0');
        const canBindV6 = await this.canBindPort(port, '::');
        return canBindV4 || canBindV6;
    }
    canConnectToPort(port, host) {
        return new Promise(resolve => {
            const net = __webpack_require__(13);
            const socket = new net.Socket();
            let resolved = false;
            const finish = (value) => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    resolve(value);
                }
            };
            socket.setTimeout(400);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
            socket.connect(port, host);
        });
    }
    canBindPort(port, host) {
        return new Promise(resolve => {
            const net = __webpack_require__(13);
            const server = net.createServer();
            let resolved = false;
            const finish = (value) => {
                if (!resolved) {
                    resolved = true;
                    resolve(value);
                }
            };
            server.once('error', () => finish(false));
            server.once('listening', () => {
                server.close(() => finish(true));
            });
            server.listen(port, host);
        });
    }
    async findAvailablePort(startPort, maxAttempts = 50) {
        for (let i = 0; i < maxAttempts; i += 1) {
            const candidate = startPort + i;
            if (await this.isPortAvailable(candidate)) {
                return candidate;
            }
        }
        return null;
    }
    // ── Backend reporting ────────────────────────────────────────────
    async reportProgress(projectId, progress, step) {
        this.onLog(`[${progress}%] ${step}`);
        try {
            await this.apiClient.post(`/api/projects/${projectId}/install-progress`, {
                progress, step,
            });
        }
        catch (err) {
            // Non-fatal — installation continues even if backend reporting fails
            if (err?.response?.status === 401) {
                this.onLog('[Warning] Session expired — progress will not sync to dashboard', 'stderr');
            }
            // Swallow all other errors silently
        }
    }
    async reportComplete(projectId, success, port, error) {
        // Retry up to 3 times with backoff — this one matters
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await this.apiClient.post(`/api/projects/${projectId}/install-complete`, {
                    success, port, error,
                });
                return;
            }
            catch (err) {
                if (attempt === 3) {
                    this.onLog(`[Warning] Could not report completion to backend after ${attempt} attempts`, 'stderr');
                }
                else {
                    await new Promise(r => setTimeout(r, attempt * 1000));
                }
            }
        }
    }
}
exports.LocalInstaller = LocalInstaller;


/***/ }),
/* 13 */
/***/ ((module) => {

module.exports = require("net");

/***/ }),
/* 14 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ApiOutputViewProvider = void 0;
class ApiOutputViewProvider {
    _extensionUri;
    _onUiAction;
    static viewType = 'projectAssistant.apiOutput';
    _view;
    _entries = [];
    _nextId = 1;
    _installGuideUrl;
    _actionMessage;
    _showConflictActions = false;
    constructor(_extensionUri, _onUiAction) {
        this._extensionUri = _extensionUri;
        this._onUiAction = _onUiAction;
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message) => {
            switch (message?.type) {
                case 'clear':
                    this.clear();
                    break;
                case 'uiAction':
                    if (typeof message.action === 'string') {
                        this._onUiAction?.(message.action, message.payload);
                    }
                    break;
            }
        });
        this._postSnapshot();
        this._postActionState();
    }
    appendLine(message, level = 'info') {
        const entry = {
            id: this._nextId++,
            level,
            message,
        };
        this._entries.push(entry);
        if (this._entries.length > 400) {
            this._entries.splice(0, this._entries.length - 400);
        }
        this._view?.webview.postMessage({ type: 'append', entry });
    }
    clear() {
        this._entries.length = 0;
        this._view?.webview.postMessage({ type: 'clear' });
    }
    setInstallAction(message, installGuideUrl) {
        this._actionMessage = message;
        this._installGuideUrl = installGuideUrl;
        this._showConflictActions = false;
        this._postActionState();
    }
    setConflictAction(message, installGuideUrl) {
        this._actionMessage = message;
        this._installGuideUrl = installGuideUrl;
        this._showConflictActions = true;
        this._postActionState();
    }
    clearInstallAction() {
        this._actionMessage = undefined;
        this._installGuideUrl = undefined;
        this._showConflictActions = false;
        this._postActionState();
    }
    _postSnapshot() {
        if (!this._view) {
            return;
        }
        this._view.webview.postMessage({ type: 'snapshot', entries: this._entries });
    }
    _postActionState() {
        if (!this._view) {
            return;
        }
        this._view.webview.postMessage({
            type: 'actionState',
            message: this._actionMessage,
            installGuideUrl: this._installGuideUrl,
            showConflictActions: this._showConflictActions,
        });
    }
    _getHtml(webview) {
        const cspSource = webview.cspSource;
        return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-api-output';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          :root {
            --bg: var(--vscode-sideBar-background);
            --panel: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
            --text: var(--vscode-foreground);
            --muted: var(--vscode-descriptionForeground);
            --border: var(--vscode-panel-border);
            --accent: var(--vscode-button-background);
            --error: var(--vscode-errorForeground);
            --warn: var(--vscode-editorWarning-foreground);
            --success: var(--vscode-terminal-ansiGreen);
          }

          * { box-sizing: border-box; }

          body {
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            background: var(--bg);
            color: var(--text);
            font-family: var(--vscode-editor-font-family, var(--vscode-font-family, sans-serif));
          }

          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 14px;
            border-bottom: 1px solid var(--border);
            background: color-mix(in srgb, var(--bg) 94%, #000 6%);
          }

          .title {
            display: flex;
            flex-direction: column;
            gap: 2px;
          }

          .title h1 {
            margin: 0;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0;
          }

          .title p {
            margin: 0;
            font-size: 11px;
            color: var(--muted);
          }

          .toolbar {
            display: flex;
            gap: 8px;
          }

          button {
            border: 1px solid var(--border);
            background: var(--panel);
            color: var(--text);
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 12px;
            cursor: pointer;
            transition: border-color 120ms ease, background 120ms ease;
          }

          button:hover {
            border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
            background: color-mix(in srgb, var(--panel) 78%, var(--accent) 22%);
          }

          .content {
            flex: 1;
            min-height: 0;
            overflow: auto;
            padding: 12px;
          }

          .actions {
            margin-top: 10px;
            display: none;
            flex-direction: column;
            gap: 8px;
          }

          .actions.visible {
            display: flex;
          }

          .action-card {
            border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
            border-radius: 10px;
            padding: 10px;
            background: color-mix(in srgb, var(--bg) 92%, #fff 8%);
          }

          .action-text {
            font-size: 12px;
            line-height: 1.4;
            margin-bottom: 8px;
          }

          .action-row {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }

          .auth-row {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }

          .empty {
            display: grid;
            place-items: center;
            height: 100%;
            border: 1px dashed var(--border);
            border-radius: 10px;
            color: var(--muted);
            padding: 18px;
            text-align: center;
            background: rgba(255,255,255,0.015);
          }

          .log-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }

          .log-entry {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 10px;
            border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
            border-radius: 10px;
            background: color-mix(in srgb, var(--bg) 92%, #fff 8%);
          }

          .log-entry.info { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 72%, transparent); }
          .log-entry.warning { box-shadow: inset 2px 0 0 var(--warn); }
          .log-entry.error { box-shadow: inset 2px 0 0 var(--error); }
          .log-entry.success { box-shadow: inset 2px 0 0 var(--success); }

          .log-message {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            word-break: break-word;
            font-size: 12.5px;
            line-height: 1.5;
            flex: 1;
            min-width: 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">
            <h1>Console</h1>
            <p>Authentication, install, and runtime logs shown here.</p>
          </div>
          <div class="toolbar">
            <button id="clear-btn" type="button">Clear</button>
              <div class="auth-row">
                <button id="sign-in-btn" type="button">Sign In</button>
                <button id="sign-out-btn" type="button">Sign Out</button>
              </div>

          </div>
        </div>

        <div class="content">
          <div id="empty" class="empty">
            No output yet.
            <br />
            Sign in or trigger a project install.
          </div>
          <div id="log-list" class="log-list" style="display:none;"></div>

          <div id="actions" class="actions">
            <div id="action-card" class="action-card" style="display:none;">
              <div id="action-text" class="action-text"></div>
              <div class="action-row">
                <button id="install-guide-btn" type="button">Install Runtime</button>
                <button id="use-docker-btn" type="button" style="display:none;">Use Docker</button>
                <button id="retry-conflict-btn" type="button" style="display:none;">I Fixed It, Retry</button>
              </div>
            </div>
          </div>
        </div>

        <script nonce="api-output">
          const vscode = acquireVsCodeApi();
          const content = document.querySelector('.content');
          const logList = document.getElementById('log-list');
          const empty = document.getElementById('empty');
          const actions = document.getElementById('actions');
          const actionCard = document.getElementById('action-card');
          const actionText = document.getElementById('action-text');
          const installGuideBtn = document.getElementById('install-guide-btn');
          const useDockerBtn = document.getElementById('use-docker-btn');
          const retryConflictBtn = document.getElementById('retry-conflict-btn');
          const clearBtn = document.getElementById('clear-btn');
          const signInBtn = document.getElementById('sign-in-btn');
          const signOutBtn = document.getElementById('sign-out-btn');
          let entries = [];
          let installGuideUrl = null;

          function levelFromMessage(entry) {
            if (entry.level) {
              return entry.level;
            }
            const message = String(entry.message || '');
            if (message.includes('[Error]') || message.includes('[error]')) return 'error';
            if (message.includes('[Warning]') || message.includes('[warn]')) return 'warning';
            if (message.includes('completed') || message.includes('success')) return 'success';
            return 'info';
          }

          function escapeHtml(value) {
            return String(value)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          }

          function scrollToLatest() {
            if (!content) {
              return;
            }

            content.scrollTop = content.scrollHeight;
          }

          function render() {
            if (!entries.length) {
              empty.style.display = 'grid';
              logList.style.display = 'none';
              logList.innerHTML = '';
              scrollToLatest();
              return;
            }

            empty.style.display = 'none';
            logList.style.display = 'flex';
            logList.innerHTML = entries.map((entry) => {
              const level = levelFromMessage(entry);
              return '<div class="log-entry ' + level + '">' +
                '<div class="log-message">' + escapeHtml(entry.message || '') + '</div>' +
                '</div>';
            }).join('');
            scrollToLatest();
          }

          clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
          });

          installGuideBtn.addEventListener('click', () => {
            if (!installGuideUrl) {
              return;
            }
            vscode.postMessage({ type: 'uiAction', action: 'openInstallGuide', payload: installGuideUrl });
          });

          useDockerBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'chooseDocker' });
          });

          retryConflictBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'retryConflict' });
          });

          signInBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'login' });
          });

          signOutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'logout' });
          });

          window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'actionState') {
              actions.classList.add('visible');

              const hasActionMessage = typeof message.message === 'string' && message.message.trim().length > 0;
              installGuideUrl = typeof message.installGuideUrl === 'string' ? message.installGuideUrl : null;
              const showConflictActions = Boolean(message.showConflictActions);

              if (hasActionMessage) {
                actionCard.style.display = 'block';
                actionText.textContent = message.message;
                installGuideBtn.style.display = installGuideUrl ? 'inline-block' : 'none';
                useDockerBtn.style.display = showConflictActions ? 'inline-block' : 'none';
                retryConflictBtn.style.display = showConflictActions ? 'inline-block' : 'none';
              } else {
                actionCard.style.display = 'none';
              }
            }
            if (message.type === 'snapshot') {
              entries = Array.isArray(message.entries) ? message.entries : [];
              render();
            }
            if (message.type === 'append') {
              entries.push(message.entry);
              render();
            }
            if (message.type === 'clear') {
              entries = [];
              render();
            }
          });
        </script>
      </body>
      </html>`;
    }
}
exports.ApiOutputViewProvider = ApiOutputViewProvider;


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
