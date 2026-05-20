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
let pendingTroubleshootResolver;
let pendingTroubleshootMode;
let queuedConflictFileChoice;
let activeInstaller;
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
    const shouldBuildBeforeNodeStart = (hostPath, runCommand) => {
        if (!/^(?:npm(?:\s+run)?|pnpm|yarn)\s+start(?:\s+.*)?$/i.test(runCommand.trim())) {
            return false;
        }
        const packageJsonPath = path.join(hostPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return false;
        }
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const startScript = packageJson.scripts?.start;
            if (typeof startScript !== 'string') {
                return false;
            }
            const nodeEntryMatch = startScript.match(/\bnode(?:\.exe)?\s+([^&|;]+)/i);
            if (nodeEntryMatch) {
                const rawEntry = nodeEntryMatch[1].trim().replace(/^['"]|['"]$/g, '');
                const resolvedEntry = rawEntry.replace(/^\.\//, '');
                if (resolvedEntry && !fs.existsSync(path.join(hostPath, resolvedEntry))) {
                    return true;
                }
            }
            if (/\b(dist|build)\/|\b(dist|build)\\/i.test(startScript)) {
                const referencedSegment = startScript.match(/(?:dist|build)[^\s"'&|;]*/i)?.[0] ?? '';
                if (referencedSegment && !fs.existsSync(path.join(hostPath, referencedSegment))) {
                    return true;
                }
            }
        }
        catch {
            return false;
        }
        return false;
    };
    const buildCommandForStartCommand = (hostPath, runCommand) => {
        const trimmed = runCommand.trim();
        const packageJsonPath = path.join(hostPath, 'package.json');
        const packageJson = fs.existsSync(packageJsonPath)
            ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
            : undefined;
        const hasCompileScript = typeof packageJson?.scripts?.compile === 'string' && packageJson.scripts.compile.trim().length > 0;
        const hasBuildScript = typeof packageJson?.scripts?.build === 'string' && packageJson.scripts.build.trim().length > 0;
        if (/^npm\s+run\s+start(?:\s+.*)?$/i.test(trimmed)) {
            if (hasCompileScript) {
                return 'npm run compile';
            }
            if (hasBuildScript) {
                return 'npm run build';
            }
            return undefined;
        }
        if (/^npm\s+start(?:\s+.*)?$/i.test(trimmed)) {
            if (hasCompileScript) {
                return 'npm run compile';
            }
            if (hasBuildScript) {
                return 'npm run build';
            }
            return undefined;
        }
        if (/^pnpm\s+start(?:\s+.*)?$/i.test(trimmed)) {
            if (hasCompileScript) {
                return 'pnpm compile';
            }
            if (hasBuildScript) {
                return 'pnpm build';
            }
            return undefined;
        }
        if (/^yarn\s+start(?:\s+.*)?$/i.test(trimmed)) {
            if (hasCompileScript) {
                return 'yarn compile';
            }
            if (hasBuildScript) {
                return 'yarn build';
            }
            return undefined;
        }
        return undefined;
    };
    const augmentNodeStartCommand = (hostPath, runCommand) => {
        if (shouldBuildBeforeNodeStart(hostPath, runCommand)) {
            const buildCommand = buildCommandForStartCommand(hostPath, runCommand);
            if (buildCommand) {
                outputChannel.appendLine('[Launch] Detected missing build output for node start command; running build first.');
                return `${buildCommand} && ${runCommand}`;
            }
        }
        return runCommand;
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
    const launchCommand = project.type === 'nodejs' ? augmentNodeStartCommand(hostPath, runCommand) : runCommand;
    outputChannel.appendLine(`[Launch] Starting project ${projectId}`);
    outputChannel.appendLine(`[Launch] cwd=${hostPath}`);
    outputChannel.appendLine(`[Launch] command=${launchCommand}`);
    const child = (0, child_process_1.spawn)(launchCommand, {
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
            case 'analyzeWorkspace':
                void vscode.commands.executeCommand('project-assistant.analyzeWorkspace');
                return;
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
            case 'chooseAutoTroubleshoot':
                if (pendingTroubleshootResolver) {
                    pendingTroubleshootResolver('auto');
                    pendingTroubleshootResolver = undefined;
                }
                return;
            case 'chooseGuidedTroubleshoot':
                if (pendingTroubleshootResolver) {
                    pendingTroubleshootResolver('guided');
                    pendingTroubleshootResolver = undefined;
                }
                return;
            case 'specifyFile':
                if (pendingConflictResolver && payload && payload.trim().length > 0) {
                    pendingConflictResolver({ action: 'specifyFile', value: payload.trim() });
                    pendingConflictResolver = undefined;
                }
                else if (!pendingConflictResolver) {
                    if (payload && payload.trim().length > 0) {
                        queuedConflictFileChoice = payload.trim();
                        outputChannel.appendLine(`[Conflict] Queued file name: ${queuedConflictFileChoice}. It will be applied when the prompt is ready.`);
                    }
                    else {
                        outputChannel.appendLine('[Conflict] No active conflict prompt. Start/retry installation, then submit the file name again.');
                    }
                }
                else {
                    outputChannel.appendLine('[Conflict] Please provide a non-empty Python file name (for example manage.py).');
                }
                return;
            case 'cancelInstall':
                if (activeInstaller) {
                    outputChannel.appendLine('[Assistant] Cancel requested for the active installation.');
                    activeInstaller.cancel();
                    apiOutputProvider.clearInstallAction();
                    apiOutputProvider.setInstallInProgress(false);
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
    let analyzeInProgress = false;
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
                outputChannel.appendLine(`[Install] Pending install skipped: folder "${path.basename(pendingFolderPath)}" has no project id.`);
                return;
            }
            await setPendingInstallFolderPath(context, undefined);
            if (!pendingId) {
                return;
            }
            outputChannel.appendLine(`[Install] Resuming pending installation for project ${pendingId}`);
            const started = await triggerInstallFromExtension(context, pendingId, authManager, outputChannel, statusBar, apiOutputProvider, false);
            pendingInstallHandled = started;
        }
        finally {
            pendingInstallInProgress = false;
        }
    };
    const analyzeOpenWorkspace = async () => {
        if (analyzeInProgress) {
            outputChannel.appendLine('[Analyze] Analysis is already in progress.');
            return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('Open a project folder in VS Code before running Analyse.');
            return;
        }
        let usePublicApi = false;
        if (!authManager.isAuthenticated()) {
            const action = await vscode.window.showWarningMessage('In order to get your stack report you must sign in', 'Sign In', 'Analyze anyway');
            if (action === 'Sign In') {
                void vscode.commands.executeCommand('project-assistant.login');
                return;
            }
            if (action === 'Analyze anyway') {
                usePublicApi = true;
            }
            else {
                return;
            }
        }
        analyzeInProgress = true;
        const targetFolder = workspaceFolders[0].uri.fsPath;
        const ANALYZE_REQUEST_TIMEOUT_MS = 120_000;
        const mapHostPathToContainer = (hostPath) => {
            const normalized = hostPath.replace(/\\/g, '/');
            const usersPrefix = 'c:/users/';
            if (normalized.toLowerCase().startsWith(usersPrefix)) {
                return `/hostusers/${normalized.slice(usersPrefix.length)}`;
            }
            const tmpPrefix = 'c:/tmp/intelligent-assistant/';
            if (normalized.toLowerCase().startsWith(tmpPrefix)) {
                return `/tmp/intelligent-assistant/${normalized.slice(tmpPrefix.length)}`;
            }
            return normalized;
        };
        const candidatePaths = [targetFolder];
        const mappedCandidate = mapHostPathToContainer(targetFolder);
        if (mappedCandidate !== targetFolder) {
            candidatePaths.push(mappedCandidate);
        }
        try {
            outputChannel.show(false);
            outputChannel.appendLine(`[Analyze] Starting analysis for open workspace: ${targetFolder}`);
            statusBar.text = '$(sync~spin) Analyzing workspace…';
            statusBar.command = undefined;
            statusBar.show();
            let projectId;
            let lastError;
            for (let i = 0; i < candidatePaths.length; i += 1) {
                const candidatePath = candidatePaths[i];
                const attemptTaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                outputChannel.appendLine(`[Analyze] Attempt ${i + 1}/${candidatePaths.length} using path: ${candidatePath}`);
                outputChannel.appendLine(`[Analyze] Task id: ${attemptTaskId}`);
                try {
                    const client = usePublicApi ? authManager.getPublicApiClient() : authManager.getApiClient();
                    const createRes = await client.post('/api/projects', {
                        source: {
                            type: 'local',
                            path: candidatePath,
                        },
                        task_id: attemptTaskId,
                    }, {
                        timeout: ANALYZE_REQUEST_TIMEOUT_MS,
                    });
                    projectId = createRes.data?.project_id;
                    if (!projectId) {
                        throw new Error('Backend did not return a project id after analysis.');
                    }
                    break;
                }
                catch (err) {
                    lastError = err;
                    const status = err?.response?.status;
                    const detail = String(err?.response?.data?.detail ?? err?.message ?? '').toLowerCase();
                    const canRetryPath = status === 400 && detail.includes('path does not exist') && i < candidatePaths.length - 1;
                    if (canRetryPath) {
                        outputChannel.appendLine('[Analyze] Backend reported missing path. Retrying with container-compatible path...');
                        continue;
                    }
                    throw err;
                }
            }
            if (!projectId) {
                throw lastError ?? new Error('Analysis failed for all local path candidates.');
            }
            if (!projectId) {
                throw new Error('Backend did not return a project id after analysis.');
            }
            outputChannel.appendLine(`[Analyze] Analysis complete. Project id: ${projectId}`);
            await setPendingInstallId(context, projectId);
            await setPendingInstallFolderPath(context, targetFolder);
            const started = await triggerInstallFromExtension(context, projectId, authManager, outputChannel, statusBar, apiOutputProvider, false);
            if (!started) {
                outputChannel.appendLine('[Analyze] Installation did not start automatically. Use retry from the console if needed.');
            }
        }
        catch (err) {
            const status = err?.response?.status;
            const detail = err?.response?.data?.detail ?? err?.message ?? 'unknown error';
            if (status === 401 || status === 403) {
                outputChannel.appendLine('[Analyze] Session expired. Please sign in again.');
                statusBar.text = '$(lock) Session expired';
                statusBar.command = 'project-assistant.login';
                statusBar.show();
                void vscode.commands.executeCommand('project-assistant.login');
            }
            else {
                outputChannel.appendLine(`[Analyze] Failed: ${detail}`);
                statusBar.text = '$(error) Analyze failed';
                statusBar.show();
                vscode.window.showErrorMessage(`Analyse failed: ${detail}`);
            }
        }
        finally {
            analyzeInProgress = false;
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
                    await setPendingInstallFolderPath(context, resolvedFolderPath);
                    outputChannel.appendLine(`[OpenFolder] Pending install set for project ${resolvedProjectId} at ${resolvedFolderPath}`);
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
                            await setPendingInstallFolderPath(context, resolvedFolderPath);
                            outputChannel.appendLine(`[OpenFolder] Manual projectId captured: ${manualProjectId.trim()} for ${resolvedFolderPath}`);
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
    }), vscode.commands.registerCommand('project-assistant.analyzeWorkspace', async () => {
        await analyzeOpenWorkspace();
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
            // Update webview authentication state
            try {
                apiOutputProvider.setAuthenticated(authManager.isAuthenticated());
            }
            catch { }
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
            try {
                apiOutputProvider.setAuthenticated(authManager.isAuthenticated());
            }
            catch { }
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
    // Ensure webview reflects current auth state after activation
    try {
        apiOutputProvider.setAuthenticated(authManager.isAuthenticated());
    }
    catch { }
    await maybeResumePendingInstall();
} // ← closing brace for activate()
async function showOptionalLoginPrompt() {
    const selection = await vscode.window.showInformationMessage("Welcome! Would you like to log in to get your project stack report?", "Log In", "Maybe Later");
    if (selection === "Log In") {
        vscode.commands.executeCommand('project-assistant.login');
    }
}
async function requestTroubleshootMode(apiOutputProvider, outputChannel) {
    if (pendingTroubleshootMode) {
        return pendingTroubleshootMode;
    }
    apiOutputProvider.setTroubleshootModeAction('Choose how the assistant should troubleshoot conflicts before installation starts.');
    return await new Promise((resolve) => {
        pendingTroubleshootResolver = (choice) => {
            pendingTroubleshootMode = choice;
            outputChannel.appendLine(`[Assistant] Troubleshoot mode selected: ${choice}`);
            apiOutputProvider.clearInstallAction();
            resolve(choice);
        };
    });
}
async function triggerInstallFromExtension(context, projectId, auth, outputChannel, statusBar, apiOutputProvider, requireConfirmation = true) {
    const apiUrl = vscode.workspace.getConfiguration('projectAssistant').get('apiUrl') ??
        'http://localhost:8000';
    const apiClient = auth.getPublicApiClient();
    if (requireConfirmation) {
        const answer = await vscode.window.showInformationMessage('Project cloned and analyzed. Start installation now?', { modal: true }, { title: 'Install' }, { title: 'Close', isCloseAffordance: true });
        if (answer?.title !== 'Install') {
            statusBar.text = '$(package) Click to install project';
            statusBar.command = 'project-assistant.retryInstall';
            statusBar.show();
            await setPendingInstallId(context, projectId);
            return false;
        }
    }
    await requestTroubleshootMode(apiOutputProvider, outputChannel);
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
        pendingTroubleshootMode = undefined;
        return false;
    }
    await setPendingInstallId(context, undefined);
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
                await setPendingInstallFolderPath(context, undefined);
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
                const message = launchError?.message ?? 'unknown launch error';
                outputChannel.appendLine(`[Launch] Failed: ${message}`);
                statusBar.text = '$(error) Launch failed';
                statusBar.show();
                await vscode.window.showErrorMessage(`Project install finished, but launch failed: ${message}`);
            }
            return;
        }
        if (status === 'failed') {
            // ensure completed so subsequent handlers won't reopen
            installCompleted = true;
            await setPendingInstallFolderPath(context, undefined);
            const cancelled = typeof error === 'string' && error.toLowerCase().includes('cancel');
            statusBar.text = '$(error) Installation failed';
            statusBar.show();
            if (cancelled) {
                statusBar.text = '$(circle-slash) Installation cancelled';
                outputChannel.appendLine(`[Assistant] Cancelled: ${error ?? 'Installation cancelled by user.'}`);
                return;
            }
            outputChannel.appendLine(`[Assistant] Failed: ${error ?? ''}`);
            const action = await vscode.window.showErrorMessage(`Installation failed: ${error ?? 'unknown error'}`, 'View logs');
            if (action === 'View logs') {
                outputChannel.show(true);
            }
        }
    };
    const runLocalInstallation = async (input, launchAfterInstall) => {
        const installer = new localInstaller_1.LocalInstaller(auth.getApiClient(), auth.getPublicApiClient(), (msg, level) => {
            outputChannel.appendLine(level === 'error' ? `[!] ${msg}` : `  ${msg}`);
        }, handleRuntimeMissing, handleConflictResolution, handleDockerImagePullApproval);
        activeInstaller = installer;
        apiOutputProvider.setInstallInProgress(true);
        apiOutputProvider.clearInstallAction();
        try {
            const troubleshootMode = input.troubleshootMode ?? pendingTroubleshootMode ?? 'guided';
            pendingTroubleshootMode = undefined;
            const installOk = await installer.install({ ...input, troubleshootMode });
            if (installOk && launchAfterInstall) {
                const localPort = installer.getLastLaunchPort();
                outputChannel.appendLine('[Assistant] Local install completed without backend status transition. Promoting to running state.');
                await handleTerminalStatus('running', localPort, undefined, { skipProcessLaunch: true });
            }
            if (!installOk && !installer.wasCancelled()) {
                outputChannel.appendLine('[Assistant] Local installation failed. Marking status as failed locally.');
                await handleTerminalStatus('failed', undefined, 'Local install failed (backend completion sync may have failed due to expired session).', { skipProcessLaunch: true });
            }
            if (!installOk && installer.wasCancelled()) {
                outputChannel.appendLine('[Assistant] Installation cancelled by user.');
            }
        }
        finally {
            if (activeInstaller === installer) {
                activeInstaller = undefined;
            }
            apiOutputProvider.setInstallInProgress(false);
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
                // stall-warning removed
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
        // realtime fallback notification removed
    }, 4000);
    ws.on('installation_progress', (data) => {
        wsProgressEventCount += 1;
        const pct = data.progress ?? 0;
        const step = data.step ?? '';
        outputChannel.appendLine(`[${pct}%] ${step}`);
        statusBar.text = `$(sync~spin) Installing… ${pct}%`;
    });
    ws.on('log', (data) => {
        wsLogEventCount += 1;
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
            // When no progress/log events were emitted, verify backend status once
            // before treating the project as running to avoid false-positive WS events.
            if (wsProgressEventCount === 0 && wsLogEventCount === 0) {
                try {
                    const verifyRes = await apiClient.get(`/api/projects/${projectId}/status`);
                    const verifiedStatus = String(verifyRes.data?.status ?? '').toLowerCase();
                    if (verifiedStatus !== 'running') {
                        outputChannel.appendLine(`[Assistant] Ignoring transient websocket running event because backend status is still "${verifiedStatus || 'unknown'}". Continuing to wait...`);
                        return;
                    }
                }
                catch (verifyErr) {
                    outputChannel.appendLine(`[Assistant] Could not verify websocket running event (${verifyErr?.message ?? 'unknown error'}). Continuing to wait for stable status...`);
                    return;
                }
            }
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
            const localInstallerStillActive = !!activeInstaller;
            await handleTerminalStatus('running', data.port, undefined, {
                skipProcessLaunch: localInstallerStillActive,
            });
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
        const showFileInput = info.allowFileInput ?? false;
        if (showFileInput) {
            outputChannel.appendLine('[Paused] Waiting for your choice: Type the filename, use Docker, or I Fixed It, Retry.');
        }
        else {
            outputChannel.appendLine('[Paused] Waiting for your choice in the extension panel: Use Docker or I Fixed It, Retry.');
        }
        apiOutputProvider.setConflictAction(info.message, info.installUrl, showFileInput);
        return await new Promise((resolve) => {
            pendingConflictResolver = (choice) => {
                if (typeof choice === 'object' && choice.action === 'specifyFile') {
                    outputChannel.appendLine(`[Conflict] User specified file: ${choice.value}`);
                    apiOutputProvider.setConflictAction('Retrying with specified file...', info.installUrl);
                }
                else if (choice === 'docker') {
                    outputChannel.appendLine('[Conflict] User selected Docker strategy.');
                    apiOutputProvider.clearInstallAction();
                }
                else if (choice === 'manual') {
                    outputChannel.appendLine('[Conflict] User selected manual fix, retrying checks.');
                    apiOutputProvider.setConflictAction('Re-checking environment...', info.installUrl);
                }
                resolve(choice);
            };
            if (showFileInput && queuedConflictFileChoice) {
                const queuedValue = queuedConflictFileChoice;
                queuedConflictFileChoice = undefined;
                outputChannel.appendLine(`[Conflict] Applying queued file name: ${queuedValue}`);
                pendingConflictResolver({ action: 'specifyFile', value: queuedValue });
                pendingConflictResolver = undefined;
            }
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
                const pendingFolderPath = await getPendingInstallFolderPath(context);
                const statusHostPath = statusRes.data.metadata.host_path ?? statusRes.data.path ?? '';
                const normalizePath = (value) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
                let resolvedHostPath = statusHostPath;
                if (pendingFolderPath && fs.existsSync(pendingFolderPath)) {
                    const statusPathUsable = Boolean(statusHostPath) && fs.existsSync(statusHostPath);
                    const differsFromPending = !statusHostPath ||
                        (statusPathUsable && normalizePath(statusHostPath) !== normalizePath(pendingFolderPath));
                    if (!statusPathUsable || differsFromPending) {
                        outputChannel.appendLine(`[WS] Using pending analyzed folder for install context: ${pendingFolderPath}`);
                        resolvedHostPath = pendingFolderPath;
                    }
                }
                outputChannel.appendLine('[WS] Install already in progress, restoring LocalInstaller');
                await requestTroubleshootMode(apiOutputProvider, outputChannel);
                await runLocalInstallation({
                    projectId,
                    hostPath: resolvedHostPath,
                    projectType: statusRes.data.type || 'nodejs',
                    detectedPm: statusRes.data.metadata.detected_pm || 'npm',
                    runCommand: statusRes.data.metadata.run_command,
                    launchPort: statusRes.data.metadata.launch_port,
                    envVars: statusRes.data.metadata.env_vars,
                    versionConstraints: statusRes.data.metadata.version_constraints,
                    services: statusRes.data.metadata.services,
                }, true);
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
        const pendingFolderPath = await getPendingInstallFolderPath(context);
        const eventHostPath = typeof data.host_path === 'string' ? data.host_path : '';
        const normalizePath = (value) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
        let resolvedHostPath = eventHostPath;
        if (pendingFolderPath && fs.existsSync(pendingFolderPath)) {
            const eventPathUsable = Boolean(eventHostPath) && fs.existsSync(eventHostPath);
            const differsFromPending = !eventHostPath ||
                (eventPathUsable && normalizePath(eventHostPath) !== normalizePath(pendingFolderPath));
            if (!eventPathUsable || differsFromPending) {
                outputChannel.appendLine(`[Assistant] Replacing backend host path with pending analyzed folder: ${pendingFolderPath}`);
                resolvedHostPath = pendingFolderPath;
            }
        }
        outputChannel.appendLine(`[Assistant] Starting local installation for ${resolvedHostPath}`);
        // Show persistent modal message with option to start installation
        const action = await vscode.window.showInformationMessage('Ready to install. Start installation now?', { modal: true }, { title: 'Start Installation' }, { title: 'Cancel', isCloseAffordance: true });
        if (action?.title === 'Start Installation') {
            await requestTroubleshootMode(apiOutputProvider, outputChannel);
            await runLocalInstallation({
                projectId: data.project_id,
                hostPath: resolvedHostPath,
                projectType: data.project_type,
                detectedPm: data.detected_pm,
                runCommand: data.run_command,
                launchPort: data.launch_port,
                envVars: data.env_vars,
                versionConstraints: data.version_constraints,
                services: data.services,
            }, true);
        }
        else {
            outputChannel.appendLine('[Assistant] Installation cancelled by user.');
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
    sessionExpiredNotified = false;
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
        this.sessionExpiredNotified = false;
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
        if (this.sessionExpiredNotified) {
            return;
        }
        this.sessionExpiredNotified = true;
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
    publicApiClient;
    onLog;
    onRuntimeMissing;
    onConflictResolution;
    onDockerImagePullApproval;
    proc = null;
    cancelled = false;
    lastLaunchPort;
    mappedWebserverPort = null;
    lastCommandOutput = '';
    troubleshootMode = 'guided';
    constructor(apiClient, publicApiClient, onLog, onRuntimeMissing, onConflictResolution, onDockerImagePullApproval) {
        this.apiClient = apiClient;
        this.publicApiClient = publicApiClient;
        this.onLog = onLog;
        this.onRuntimeMissing = onRuntimeMissing;
        this.onConflictResolution = onConflictResolution;
        this.onDockerImagePullApproval = onDockerImagePullApproval;
    }
    // ── Public API ───────────────────────────────────────────────────
    async install(ctx) {
        this.cancelled = false;
        this.lastLaunchPort = undefined;
        this.troubleshootMode = ctx.troubleshootMode ?? 'guided';
        try {
            await this.reportProgress(ctx.projectId, 10, 'Checking environment');
            const useVenv = await this.checkConflicts(ctx);
            await this.reportProgress(ctx.projectId, 30, 'Installing dependencies');
            const installOk = await this.runInstall(ctx, useVenv);
            if (!installOk)
                return false;
            await this.reportProgress(ctx.projectId, 80, 'Writing configuration');
            await this.writeEnvFile(ctx);
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
    wasCancelled() {
        return this.cancelled;
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
            useVenv = true;
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
            if (!fs.existsSync(path.join(cwd, 'package.json'))) {
                this.onLog('[Warning] No package.json found, skipping npm install');
                return true;
            }
            const pm = await this.resolveNodePackageManager(cwd);
            this.onLog(`[Info] Package manager: ${pm}`);
            const hasNpmLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
            const baseInstallCmd = pm === 'npm' && hasNpmLock ? 'npm ci' : `${pm} install`;
            const primaryOk = await this.runCommand(baseInstallCmd, cwd, ctx.projectId);
            if (primaryOk)
                return true;
            if (pm === 'npm') {
                this.onLog('[Warning] npm dependency resolution failed. Retrying with --legacy-peer-deps...', 'warning');
                const legacyCmd = hasNpmLock ? 'npm ci --legacy-peer-deps' : 'npm install --legacy-peer-deps';
                const legacyOk = await this.runCommand(legacyCmd, cwd, ctx.projectId);
                if (legacyOk)
                    return true;
                this.onLog('[Warning] npm legacy peer-deps retry failed. Retrying with --force as last resort...', 'warning');
                const forceOk = await this.runCommand('npm install --force', cwd, ctx.projectId);
                if (forceOk)
                    return true;
            }
            return await this.handleNodeInstallFailure(ctx, cwd, hasNpmLock);
        }
        if (ctx.projectType === 'python') {
            const hasPyproject = fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
                fs.existsSync(path.join(cwd, 'src', 'pyproject.toml'));
            const hasPipfile = fs.existsSync(path.join(cwd, 'Pipfile')) ||
                fs.existsSync(path.join(cwd, 'src', 'Pipfile'));
            const hasReqs = fs.existsSync(path.join(cwd, 'requirements.txt')) ||
                fs.existsSync(path.join(cwd, 'src', 'requirements.txt'));
            if (!hasPyproject && !hasPipfile && !hasReqs) {
                this.onLog('[Warning] No dependency file found. Skipping install.');
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
            const composerOk = await this.runCommand('composer install', cwd, ctx.projectId);
            if (composerOk)
                return true;
            return await this.handlePhpInstallFailure(ctx, cwd);
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
        let reqFile = path.join(cwd, 'requirements.txt');
        if (!fs.existsSync(reqFile)) {
            reqFile = path.join(cwd, 'src', 'requirements.txt');
            if (!fs.existsSync(reqFile)) {
                this.onLog('[Warning] No requirements.txt found, skipping pip install');
                return true;
            }
        }
        const pip = this.getPipCmd(cwd);
        const ok = await this.runCommand(`${pip} install -r "${reqFile}"`, cwd, projectId);
        if (ok)
            return true;
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
        let existing = {};
        if (fs.existsSync(examplePath)) {
            const lines = fs.readFileSync(examplePath, 'utf8').split('\n');
            for (const line of lines) {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match)
                    existing[match[1].trim()] = match[2].trim();
            }
        }
        const merged = { ...existing, ...ctx.envVars };
        const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(envPath, content, 'utf8');
        this.onLog(`[Info] Written .env (${Object.keys(merged).length} variables)`);
    }
    // ── Private: launch ──────────────────────────────────────────────
    async launch(ctx, useVenv) {
        const cwd = ctx.hostPath;
        let cmd;
        try {
            cmd = await this.resolveRunCommand(ctx, useVenv);
        }
        catch (err) {
            const errorMessage = err?.message ?? String(err);
            this.onLog(`[!] [Error] ${errorMessage}`, 'stderr');
            await this.reportComplete(ctx.projectId, false, undefined, errorMessage);
            throw err;
        }
        const port = await this.resolvePort(ctx);
        this.onLog(`[Launch] Starting: ${cmd}`);
        this.onLog(`[Launch] cwd: ${cwd}`);
        this.onLog(`[Launch] port: ${port}`);
        const launchEnv = { ...process.env, PORT: String(port) };
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
        this.proc.stdout?.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(line => this.onLog(line.trim())));
        this.proc.stderr?.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(line => this.onLog(line.trim(), 'stderr')));
        await new Promise(r => setTimeout(r, 2000));
        if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
            throw new Error(`Process exited immediately with code ${this.proc.exitCode}.`);
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
    async resolveRunCommand(ctx, useVenv, specifiedFile) {
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
                            this.onLog(`[Warning] Backend run command "${normalizedRunCommand}" references missing script "${scriptName}". Falling back.`);
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
            // If user provided a runCommand for a Python project, attempt to rewrite any relative .py path to an absolute path.
            if (ctx.projectType === 'python') {
                try {
                    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const pyMatch = normalizedRunCommand.match(/(?:^|\s)(?:['\"])?([^'\"\s]+\.py)(?:['\"])?/i);
                    if (pyMatch && pyMatch[1]) {
                        const rel = pyMatch[1];
                        const abs = path.resolve(cwd, rel);
                        // Verify the script actually exists before using the rewritten command
                        if (fs.existsSync(abs)) {
                            const replaced = normalizedRunCommand.replace(new RegExp(escapeRegExp(rel), 'g'), `"${abs}"`);
                            this.onLog(`[Launch] Rewrote run command to use absolute Python script path: ${replaced}`);
                            return replaced;
                        }
                        else {
                            this.onLog(`[Warning] Backend run command references Python script "${rel}" which doesn't exist at "${abs}". Falling back to auto-detection.`);
                            // Fall through to auto-detection below
                        }
                    }
                }
                catch (e) {
                    // fall through and use auto-detection
                }
            }
            else {
                return normalizedRunCommand;
            }
        }
        if (ctx.projectType === 'nodejs') {
            const pm = await this.resolveNodePackageManager(cwd);
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
                throw new Error(`No runnable Node script found. Expected one of start/dev/serve/preview, but found: ${scriptNames.length ? scriptNames.join(', ') : 'none'}`);
            }
            throw new Error('No package.json found to determine Node launch command.');
        }
        if (ctx.projectType === 'python') {
            const pythonBin = this.resolvePythonBin(cwd, useVenv);
            if (specifiedFile) {
                const normalizedSpecifiedFile = this.normalizeSpecifiedPythonFile(specifiedFile);
                const specifiedPath = path.isAbsolute(normalizedSpecifiedFile)
                    ? normalizedSpecifiedFile
                    : path.join(cwd, normalizedSpecifiedFile);
                if (!normalizedSpecifiedFile.toLowerCase().endsWith('.py')) {
                    throw new Error(`"${normalizedSpecifiedFile}" is not a Python file. Please provide a .py entry file path.`);
                }
                if (fs.existsSync(specifiedPath)) {
                    return `${pythonBin} "${specifiedPath}"`;
                }
                const hasPathSeparator = normalizedSpecifiedFile.includes('/') || normalizedSpecifiedFile.includes('\\');
                if (!path.isAbsolute(normalizedSpecifiedFile) && !hasPathSeparator) {
                    const discovered = await this.findFileRecursive(cwd, normalizedSpecifiedFile, 5);
                    if (discovered) {
                        return `${pythonBin} "${path.join(cwd, discovered)}"`;
                    }
                }
                throw new Error(`Specified Python entry file not found: ${normalizedSpecifiedFile} (looked in ${specifiedPath})`);
            }
            const managePy = await this.findFileWithSrcFallback(cwd, 'manage.py', ctx);
            if (managePy) {
                const port = await this.resolvePort(ctx);
                const scriptPath = path.resolve(cwd, managePy);
                return `${pythonBin} "${scriptPath}" runserver 0.0.0.0:${port}`;
            }
            for (const f of ['app.py', 'main.py', 'run.py', 'server.py', 'wsgi.py']) {
                const found = await this.findFileWithSrcFallback(cwd, f, ctx);
                if (found) {
                    const scriptPath = path.resolve(cwd, found);
                    return `${pythonBin} "${scriptPath}"`;
                }
            }
            for (const f of ['asgi.py', 'application.py']) {
                const found = await this.findFileWithSrcFallback(cwd, f, ctx);
                if (found) {
                    const port = await this.resolvePort(ctx);
                    const module = found.replace(/\.py$/, '').replace(/[\\/]/g, '.');
                    return `${pythonBin} -m uvicorn ${module}:app --host 0.0.0.0 --port ${port}`;
                }
            }
            if (await this.requirementsMentions(cwd, 'flask')) {
                const port = await this.resolvePort(ctx);
                return `${pythonBin} -m flask run --host=0.0.0.0 --port=${port}`;
            }
            return await this.promptUserToAddPythonEntryPoint(ctx, useVenv, `Cannot determine how to start this Python project. No manage.py, app.py, main.py, or run.py found in ${cwd} or subdirectories.`);
        }
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
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildTool(cwd);
            if (!tool)
                throw new Error('No Java build tool found for this project');
            if (tool === 'maven')
                return 'mvn spring-boot:run -q';
            const gradlew = this.gradleWrapper(cwd);
            if (await this.fileContains(cwd, 'build.gradle', 'spring-boot') || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot')) {
                return `${gradlew} bootRun`;
            }
            return `${gradlew} run`;
        }
        if (ctx.projectType === 'ruby') {
            const port = await this.resolvePort(ctx);
            if (fs.existsSync(path.join(cwd, 'config', 'application.rb')))
                return `bundle exec rails server -p ${port}`;
            for (const f of ['app.rb', 'main.rb', 'server.rb', 'config.ru']) {
                if (fs.existsSync(path.join(cwd, f))) {
                    if (f === 'config.ru')
                        return `bundle exec rackup --port ${port}`;
                    return `bundle exec ruby ${f}`;
                }
            }
            throw new Error('Cannot determine Ruby entry point');
        }
        if (ctx.projectType === 'go') {
            const mainFile = this.findGoMain(cwd);
            return mainFile ? `go run ${mainFile}` : 'go run .';
        }
        throw new Error(`Unsupported project type: ${ctx.projectType}`);
    }
    // ── Docker Compose: port scanning ────────────────────────────────
    //
    // Read all host:container port mappings from the compose file BEFORE
    // running docker compose up, so we can remap any that are already in use.
    parseComposePorts(cwd, composeFile) {
        const filePath = path.join(cwd, composeFile);
        if (!fs.existsSync(filePath))
            return [];
        const content = fs.readFileSync(filePath, 'utf8');
        const mappings = [];
        // Match service blocks and their ports sections
        // Handles both "host:container" string format and long-form mapping objects
        const servicePattern = /^(\s{2})(\w[\w-]*):/gm;
        let serviceMatch;
        const lines = content.split('\n');
        let currentService = '';
        let inPortsSection = false;
        let serviceIndent = '';
        for (const line of lines) {
            // Detect service name (2-space indent, word chars)
            const serviceLineMatch = line.match(/^  ([\w][\w-]*):\s*$/);
            if (serviceLineMatch) {
                currentService = serviceLineMatch[1];
                inPortsSection = false;
                serviceIndent = '  ';
                continue;
            }
            // Detect ports: section under a service
            if (currentService && line.match(/^    ports:\s*$/)) {
                inPortsSection = true;
                continue;
            }
            // Exit ports section when we hit another key at same indent
            if (inPortsSection && line.match(/^    \w/) && !line.match(/^      /)) {
                inPortsSection = false;
                continue;
            }
            // Parse port entries like:  - "8000:80" or  - 8000:80
            if (inPortsSection && currentService) {
                const portEntryMatch = line.match(/^\s+-\s+["']?(\d+):(\d+)["']?/);
                if (portEntryMatch) {
                    mappings.push({
                        hostPort: parseInt(portEntryMatch[1], 10),
                        containerPort: parseInt(portEntryMatch[2], 10),
                        service: currentService,
                    });
                }
            }
        }
        return mappings;
    }
    async buildPortRemapPlan(mappings) {
        const plan = {};
        let hasConflicts = false;
        for (const mapping of mappings) {
            const inUse = !(await this.isPortAvailable(mapping.hostPort));
            if (inUse) {
                hasConflicts = true;
                const freePort = await this.findAvailablePort(mapping.hostPort + 1, 200);
                if (!freePort) {
                    this.onLog(`[Docker] Warning: No free port found near ${mapping.hostPort} for service ${mapping.service}`, 'warning');
                    continue;
                }
                this.onLog(`[Docker] Port ${mapping.hostPort} in use — remapping ${mapping.service} to ${freePort}:${mapping.containerPort}`);
                if (!plan[mapping.service])
                    plan[mapping.service] = [];
                plan[mapping.service].push({ hostPort: freePort, containerPort: mapping.containerPort });
            }
        }
        return { plan, hasConflicts };
    }
    writePortRemapOverride(cwd, plan) {
        const overrideFileName = '.project-assistant.port-remap-override.yml';
        const overridePath = path.join(cwd, overrideFileName);
        const lines = ['services:'];
        for (const [service, portMappings] of Object.entries(plan)) {
            lines.push(`  ${service}:`);
            lines.push(`    ports: !override [`);
            for (const pm of portMappings) {
                lines.push(`      "${pm.hostPort}:${pm.containerPort}",`);
            }
            lines.push(`    ]`);
        }
        lines.push('');
        fs.writeFileSync(overridePath, lines.join('\n'), 'utf8');
        return overrideFileName;
    }
    // ── Docker: runDockerFallback ────────────────────────────────────
    async runDockerFallback(ctx) {
        await this.reportProgress(ctx.projectId, 35, 'Preparing Docker fallback');
        this.mappedWebserverPort = null;
        const hasDocker = await this.commandExists('docker');
        if (!hasDocker) {
            throw new Error('Docker is not installed or not in PATH. Install Docker Desktop and retry.');
        }
        const cwd = ctx.hostPath;
        let containerPort = ctx.launchPort ?? this.defaultPort(ctx.projectType);
        // ── FIX 1: Try Docker Compose for ANY project type that has a compose file,
        //           not just PHP. Laracom is detected as php, but this also handles
        //           Node, Python, Ruby etc. projects that ship with docker-compose.yml
        const composeContext = this.findDockerComposeContext(cwd);
        if (composeContext) {
            this.onLog(`[Docker] Found compose file: ${composeContext.dir}/${composeContext.file}`);
            return await this.runComposeFallback(ctx, composeContext.dir, composeContext.file);
        }
        // ── No compose file — fall back to single-container docker run ──
        let port = await this.resolvePort(ctx);
        if (ctx.projectType === 'nodejs') {
            const inferredContainerPort = await this.inferNodeLaunchPort(cwd);
            if (inferredContainerPort) {
                containerPort = inferredContainerPort;
            }
        }
        const normalizedPath = cwd.replace(/\\/g, '/');
        const containerBaseName = `pa-${ctx.projectId.slice(-8)}-${Date.now()}`;
        const image = await this.resolveDockerImage(ctx, cwd);
        const hasImage = await this.dockerImageExists(image, cwd);
        if (!hasImage) {
            const approved = this.onDockerImagePullApproval ? await this.onDockerImagePullApproval(image) : false;
            if (!approved)
                throw new Error(`Docker image ${image} is not available locally and pull was not approved.`);
            this.onLog(`[Docker] Pulling image ${image}...`);
            const pullResult = await this.execAndCaptureResult(`docker pull ${image}`, cwd);
            if (!pullResult.ok)
                throw new Error(`Failed to pull Docker image ${image}. ${pullResult.errorOutput || pullResult.output}`);
            this.onLog(`[Docker] Image ready: ${image}`);
        }
        let containerName = '';
        let containerId = '';
        let lastDockerError = '';
        for (let attempt = 1; attempt <= 6; attempt += 1) {
            containerName = `${containerBaseName}-${attempt}`;
            const containerScript = await this.resolveDockerScript(ctx, cwd, containerPort);
            const escapedScript = containerScript.replace(/"/g, '\\"');
            await this.execAndCapture(`docker rm -f ${containerName}`, cwd);
            const dockerRunCmd = `docker run -d --name ${containerName} --rm --entrypoint sh ` +
                `-p ${port}:${containerPort} -w /workspace ` +
                `-v "${normalizedPath}:/workspace" -e PORT=${containerPort} ` +
                `${image} -lc "${escapedScript}"`;
            this.onLog(`[Docker] Starting container on host:${port} -> container:${containerPort} (attempt ${attempt}/6)`);
            const dockerRun = await this.execAndCaptureResult(dockerRunCmd, cwd);
            containerId = dockerRun.output;
            if (dockerRun.ok && containerId)
                break;
            const details = dockerRun.errorOutput || 'No stderr from docker command.';
            lastDockerError = details;
            const portBusy = /port is already allocated|bind for 0\.0\.0\.0:\d+ failed/i.test(details);
            if (!portBusy || attempt === 6)
                throw new Error(`Failed to start Docker container. ${details}`);
            const nextPort = await this.findAvailablePort(port + 1, 100);
            if (!nextPort)
                throw new Error(`Failed to start Docker container. ${details}`);
            this.onLog(`[Docker] Port ${port} is busy. Retrying on port ${nextPort}.`, 'warning');
            port = nextPort;
        }
        if (!containerId)
            throw new Error(`Failed to start Docker container. ${lastDockerError}`);
        this.onLog(`[Docker] Container started: ${containerName}`);
        await this.reportProgress(ctx.projectId, 90, 'Launching application in Docker');
        const waitMs = ctx.projectType === 'java' ? 180_000 : 90_000;
        const bound = await this.waitForPort(port, waitMs);
        if (!bound) {
            const running = await this.isContainerRunning(containerName, cwd);
            const recentLogs = await this.execAndCapture(`docker logs --tail 80 ${containerName}`, cwd);
            if (!running)
                throw new Error(`Docker container exited before becoming ready on port ${port}.\n${recentLogs}`);
            throw new Error(`Docker container running but port ${port} not responding after ${Math.round(waitMs / 1000)}s.\n${recentLogs}`);
        }
        if (this.shouldRequireHttpReadiness(ctx.projectType)) {
            const httpTimeoutMs = this.getDockerHttpReadinessTimeoutMs(ctx.projectType);
            const httpReady = await this.waitForHttpReady(port, httpTimeoutMs);
            if (!httpReady) {
                const recentLogs = await this.execAndCapture(`docker logs --tail 80 ${containerName}`, cwd);
                if (/missingsecret/i.test(recentLogs)) {
                    throw new Error('Auth.js reported MissingSecret inside Docker. Set AUTH_SECRET or NEXTAUTH_SECRET for this project. '
                        + 'The installer now injects a development default for NextAuth-like projects; retry installation so the updated Docker fallback script is used.\n'
                        + recentLogs);
                }
                throw new Error(`Docker container bound port ${port} but did not return HTTP responses in time.\n${recentLogs}`);
            }
        }
        return port;
    }
    // ── Docker Compose: unified fallback for all project types ───────
    async runComposeFallback(ctx, cwd, composeFile) {
        await this.reportProgress(ctx.projectId, 40, 'Starting Docker Compose stack');
        // ── FIX 2: Pre-flight port scan — remap conflicting ports BEFORE running up ──
        const mappings = this.parseComposePorts(cwd, composeFile);
        this.onLog(`[Docker] Compose port scan: found ${mappings.length} host port binding(s)`);
        const { plan, hasConflicts } = await this.buildPortRemapPlan(mappings);
        let upResult;
        let portOverrideFile = null;
        if (hasConflicts && Object.keys(plan).length > 0) {
            // Write a compose override with remapped ports and use it
            portOverrideFile = this.writePortRemapOverride(cwd, plan);
            this.onLog(`[Docker] Pre-flight: remapping conflicting ports via override file`);
            try {
                upResult = await this.execAndCaptureResult(`docker compose -f "${composeFile}" -f "${portOverrideFile}" up -d --build`, cwd);
            }
            finally {
                // Always clean up override file
                try {
                    fs.unlinkSync(path.join(cwd, portOverrideFile));
                }
                catch { }
                portOverrideFile = null;
            }
        }
        else {
            // No pre-flight conflicts detected — run normally
            upResult = await this.runComposeUpWithFallback(cwd, composeFile);
        }
        if (!upResult.ok) {
            // ── FIX 3: If compose still failed after our pre-flight remap, try
            //           the full fallback chain one more time with fresh port scan ──
            const failText = this.composeResultText(upResult);
            const conflictPort = this.extractDockerPortConflict(failText);
            if (conflictPort) {
                this.onLog(`[Docker] Post-run port conflict on ${conflictPort} — attempting emergency remap`, 'warning');
                const emergencyResult = await this.runComposeUpWithFallback(cwd, composeFile);
                if (!emergencyResult.ok) {
                    const details = emergencyResult.errorOutput || emergencyResult.output || 'No output from docker compose up.';
                    throw new Error(`Failed to start Docker Compose stack. ${details}`);
                }
                upResult = emergencyResult;
            }
            else {
                const details = upResult.errorOutput || upResult.output || 'No output from docker compose up.';
                throw new Error(`Failed to start Docker Compose stack. ${details}`);
            }
        }
        // ── Resolve which port to poll ─────────────────────────────────
        const serviceName = await this.detectComposeServiceName(cwd, composeFile);
        let resolvedPort = await this.resolveComposeHostPort(cwd, composeFile, serviceName);
        // If port was remapped by pre-flight, use the remapped port
        if (!resolvedPort && Object.keys(plan).length > 0) {
            const webserverPlan = plan['webserver'] || plan['app'] || plan[serviceName];
            if (webserverPlan && webserverPlan.length > 0) {
                resolvedPort = webserverPlan[0].hostPort;
                this.onLog(`[Docker] Using pre-flight remapped port: ${resolvedPort}`);
            }
        }
        const port = resolvedPort ?? this.mappedWebserverPort ?? (ctx.launchPort ?? this.defaultPort(ctx.projectType));
        await this.reportProgress(ctx.projectId, 90, 'Waiting for Docker Compose stack to be ready');
        const bound = await this.waitForPort(port, 120_000);
        if (!bound) {
            throw new Error(`Docker Compose stack started but port ${port} did not become ready within 120s.`);
        }
        this.onLog(`[Docker] Stack ready on port ${port}`);
        return port;
    }
    // ── Docker Compose: helpers ──────────────────────────────────────
    findDockerComposeFile(cwd) {
        for (const candidate of ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml']) {
            if (fs.existsSync(path.join(cwd, candidate)))
                return candidate;
        }
        return null;
    }
    findDockerComposeContext(cwd) {
        const rootCompose = this.findDockerComposeFile(cwd);
        if (rootCompose) {
            return { dir: cwd, file: rootCompose };
        }
        let current = cwd;
        for (let depth = 0; depth < 3; depth += 1) {
            const parent = path.dirname(current);
            if (parent === current)
                break;
            // Only climb to parent folders if they look like an actual monorepo root.
            // This prevents accidentally picking an unrelated docker-compose.yml above the project.
            if (!this.isLikelyMonorepoRoot(parent)) {
                break;
            }
            const parentCompose = this.findDockerComposeFile(parent);
            if (parentCompose) {
                return { dir: parent, file: parentCompose };
            }
            current = parent;
        }
        return null;
    }
    isLikelyMonorepoRoot(dir) {
        const markers = [
            'pnpm-workspace.yaml',
            'turbo.json',
            'nx.json',
            'lerna.json',
            'rush.json',
            '.yarnrc.yml',
        ];
        if (markers.some((marker) => fs.existsSync(path.join(dir, marker)))) {
            return true;
        }
        const packageJsonPath = path.join(dir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return false;
        }
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            return Boolean(pkg?.workspaces);
        }
        catch {
            return false;
        }
    }
    composeResultText(result) {
        return `${result.output || ''}\n${result.errorOutput || ''}`;
    }
    extractDockerPortConflict(text) {
        const normalized = String(text ?? '');
        if (!normalized)
            return undefined;
        const m = normalized.match(/Bind for 0\.0\.0\.0:(\d+)|port (\d+) .* failed|bind.*:(\d+)|:(\d+).*already allocated|Ports are not available: exposing port TCP 0\.0\.0\.0:(\d+)/i);
        if (!m)
            return undefined;
        const conflictPort = m[1] || m[2] || m[3] || m[4] || m[5];
        if (!conflictPort)
            return undefined;
        const parsed = parseInt(conflictPort, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    async getComposeServices(cwd, composeFile) {
        const result = await this.execAndCaptureResult(`docker compose -f "${composeFile}" config --services`, cwd);
        const cliServices = result.ok
            ? result.output
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(s => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s))
            : [];
        // Fallback parser: compose config can fail on partially broken user files.
        const fileServices = this.parseComposeServiceNames(cwd, composeFile);
        return Array.from(new Set([...cliServices, ...fileServices]));
    }
    parseComposeServiceNames(cwd, composeFile) {
        const filePath = path.join(cwd, composeFile);
        if (!fs.existsSync(filePath))
            return [];
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        const services = [];
        let inServicesBlock = false;
        let serviceIndent = null;
        for (const line of lines) {
            if (!inServicesBlock) {
                if (/^\s*services:\s*$/.test(line))
                    inServicesBlock = true;
                continue;
            }
            if (!line.trim() || /^\s*#/.test(line))
                continue;
            const keyMatch = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$/);
            if (!keyMatch)
                continue;
            const indent = line.match(/^\s*/)?.[0].length ?? 0;
            // Reached next top-level key (e.g. volumes/networks) after services block.
            if (indent === 0)
                break;
            if (serviceIndent === null) {
                serviceIndent = indent;
            }
            // Collect only direct children of services:
            if (indent === serviceIndent) {
                services.push(keyMatch[1]);
            }
            else if (indent < serviceIndent) {
                break;
            }
        }
        return services;
    }
    async runComposeUpWithFallback(cwd, composeFile) {
        this.mappedWebserverPort = null;
        const primaryUp = await this.execAndCaptureResult(`docker compose -f "${composeFile}" up -d --build`, cwd);
        if (primaryUp.ok)
            return primaryUp;
        const primaryText = this.composeResultText(primaryUp);
        const allServices = await this.getComposeServices(cwd, composeFile);
        // ── Mailhog build failure ──────────────────────────────────────
        const hasMailhogBuildFailure = /mailhog/i.test(primaryText);
        const coreServiceNames = allServices.filter(s => !/mailhog/i.test(s));
        if (hasMailhogBuildFailure && coreServiceNames.length > 0) {
            this.onLog(`[Docker] Mailhog build failure — retrying without mailhog`, 'warning');
            const coreUp = await this.execAndCaptureResult(`docker compose -f "${composeFile}" up -d --build --no-deps ${coreServiceNames.join(' ')}`, cwd);
            if (coreUp.ok)
                return coreUp;
            const coreNoBuild = await this.execAndCaptureResult(`docker compose -f "${composeFile}" up -d --no-build --no-deps ${coreServiceNames.join(' ')}`, cwd);
            if (coreNoBuild.ok)
                return coreNoBuild;
            return await this.retryComposeWithoutDbHostPort(cwd, composeFile, coreServiceNames);
        }
        // ── Any port conflict ──────────────────────────────────────────
        const conflictPort = this.extractDockerPortConflict(primaryText);
        if (conflictPort && conflictPort > 1000) {
            this.onLog(`[Docker] Port ${conflictPort} conflict after compose up — trying db port removal + alternate ports`);
            return await this.retryComposeWithoutDbHostPort(cwd, composeFile, allServices);
        }
        return primaryUp;
    }
    async retryComposeWithoutDbHostPort(cwd, composeFile, services) {
        this.onLog('[Docker] Attempting to start without DB host port binding...');
        const overrideFileName = '.project-assistant.db-port-override.yml';
        const overridePath = path.join(cwd, overrideFileName);
        const overrideContent = [
            'services:',
            '  db:',
            '    expose:',
            '      - "3306"',
            '    ports: !override []',
            '',
        ].join('\n');
        fs.writeFileSync(overridePath, overrideContent, 'utf8');
        try {
            const cmd = `docker compose -f "${composeFile}" -f "${overrideFileName}" up -d --no-build --force-recreate ${services.join(' ')}`;
            const result = await this.execAndCaptureResult(cmd, cwd);
            const resultText = this.composeResultText(result);
            if (result.ok)
                return result;
            // Still conflicting — try alternate ports for webserver/app
            const conflictPort = this.extractDockerPortConflict(resultText);
            if (conflictPort && conflictPort > 1000) {
                const appWebOnly = services.filter(s => s !== 'db');
                if (appWebOnly.length > 0) {
                    return await this.retryComposeWithAlternatePorts(cwd, composeFile, overrideFileName, appWebOnly, conflictPort);
                }
            }
            return result;
        }
        finally {
            try {
                fs.unlinkSync(overridePath);
            }
            catch { }
        }
    }
    async retryComposeWithAlternatePorts(cwd, composeFile, dbOverrideFileName, services, conflictPort) {
        // Build a list of candidate alternate ports, starting from conflictPort+1
        const candidates = [];
        for (let p = conflictPort + 1; p <= conflictPort + 20; p++) {
            if (await this.isPortAvailable(p)) {
                candidates.push(p);
                if (candidates.length >= 6)
                    break;
            }
        }
        // Also try some well-known alternates
        for (const p of [8888, 9000, 9001, 8080, 5000]) {
            if (!candidates.includes(p) && await this.isPortAvailable(p)) {
                candidates.push(p);
                if (candidates.length >= 8)
                    break;
            }
        }
        for (const altPort of candidates) {
            const portOverrideFileName = `.project-assistant.port-${altPort}-override.yml`;
            const portOverridePath = path.join(cwd, portOverrideFileName);
            this.onLog(`[Docker] Trying alternate port ${altPort} for services: ${services.join(', ')}`);
            const overrideLines = [
                'services:',
                '  db:',
                '    expose:',
                '      - "3306"',
                '    ports: !override []',
            ];
            if (services.includes('webserver')) {
                overrideLines.push('  webserver:', `    ports: !override ["${altPort}:80"]`);
            }
            if (services.includes('app')) {
                const appPort = altPort + 1;
                if (await this.isPortAvailable(appPort)) {
                    overrideLines.push('  app:', `    ports: !override ["${appPort}:8000"]`);
                }
            }
            fs.writeFileSync(portOverridePath, `${overrideLines.join('\n')}\n`, 'utf8');
            try {
                await this.execAndCaptureResult(`docker compose -f "${composeFile}" -f "${dbOverrideFileName}" -f "${portOverrideFileName}" down`, cwd);
                const cmd = `docker compose -f "${composeFile}" -f "${dbOverrideFileName}" -f "${portOverrideFileName}" up -d --no-build ${services.join(' ')}`;
                const result = await this.execAndCaptureResult(cmd, cwd);
                if (result.ok) {
                    this.mappedWebserverPort = altPort;
                    return result;
                }
                const failedPort = this.extractDockerPortConflict(this.composeResultText(result));
                if (!failedPort)
                    return result; // non-port error — return as-is
                // port still busy — try next candidate
            }
            finally {
                try {
                    fs.unlinkSync(portOverridePath);
                }
                catch { }
            }
        }
        return { ok: false, output: '', errorOutput: 'All alternate ports exhausted — no available port found.' };
    }
    async detectComposeServiceName(cwd, composeFile) {
        const services = await this.getComposeServices(cwd, composeFile);
        for (const preferred of ['webserver', 'app', 'php', 'backend', 'laravel', 'web']) {
            const match = services.find(s => s.toLowerCase() === preferred);
            if (match)
                return match;
        }
        return services[0] ?? 'app';
    }
    async resolveComposeHostPort(cwd, composeFile, serviceName) {
        if (this.mappedWebserverPort && this.mappedWebserverPort > 0)
            return this.mappedWebserverPort;
        for (const containerPort of [80, 8000, 8080]) {
            const portResult = await this.execAndCaptureResult(`docker compose -f "${composeFile}" port ${serviceName} ${containerPort}`, cwd);
            const output = (portResult.output || '').trim();
            if (!output)
                continue;
            const match = output.match(/:(\d+)\s*$/);
            if (match) {
                const parsed = Number(match[1]);
                if (Number.isFinite(parsed) && parsed > 0)
                    return parsed;
            }
        }
        return undefined;
    }
    // ── Remaining helpers (unchanged) ───────────────────────────────
    shouldWaitForPort(projectType, cmd) {
        const normalized = cmd.toLowerCase();
        if (projectType === 'java') {
            return normalized.includes('spring-boot:run') || normalized.includes('bootrun') ||
                normalized.includes('quarkus') || normalized.includes('micronaut') || normalized.includes('java -jar');
        }
        return true;
    }
    resolvePythonBin(cwd, useVenv) {
        if (useVenv) {
            const win = path.join(cwd, '.venv', 'Scripts', 'python.exe');
            if (fs.existsSync(win))
                return `"${win}"`;
            const unix = path.join(cwd, '.venv', 'bin', 'python');
            if (fs.existsSync(unix))
                return unix;
        }
        return process.platform === 'win32' ? 'python' : 'python3';
    }
    async resolvePort(ctx) {
        let intended = ctx.launchPort ?? this.defaultPort(ctx.projectType);
        // Only infer port from app config if no port was explicitly configured by the user.
        if (ctx.projectType === 'nodejs' && !ctx.launchPort) {
            const inferred = await this.inferNodeLaunchPort(ctx.hostPath);
            if (inferred) {
                this.onLog(`[Info] Detected Node app default port ${inferred}; using it for launch`);
                intended = inferred;
            }
        }
        if (!this.isPortInUse(intended))
            return intended;
        for (let p = intended + 1; p < intended + 100; p++) {
            if (!this.isPortInUse(p)) {
                this.onLog(`[Conflict] Port ${intended} is in use. Using port ${p} instead`);
                return p;
            }
        }
        return intended;
    }
    defaultPort(projectType) {
        const ports = { nodejs: 3000, python: 8000, php: 8000, java: 8080, ruby: 3000, go: 8080 };
        return ports[projectType] ?? 3000;
    }
    async inferNodeLaunchPort(cwd) {
        const packageJsonPath = path.join(cwd, 'package.json');
        if (!fs.existsSync(packageJsonPath))
            return null;
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const scripts = pkg.scripts ?? {};
            const scriptText = [scripts.start, scripts.dev, scripts.serve, scripts.preview]
                .filter((value) => typeof value === 'string')
                .join(' ')
                .toLowerCase();
            const depText = JSON.stringify({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).toLowerCase();
            const explicitPortMatch = scriptText.match(/--port(?:=|\s+)(\d{2,5})/i);
            if (explicitPortMatch) {
                const parsed = Number(explicitPortMatch[1]);
                if (Number.isFinite(parsed))
                    return parsed;
            }
            // Prefer actual run scripts over dependency hints to avoid false positives
            // in monorepos (for example, a Next app with a Vite-based subpackage).
            if (scriptText.includes('next'))
                return 3000;
            if (scriptText.includes('nuxt'))
                return 3000;
            if (scriptText.includes('react-scripts'))
                return 3000;
            if (scriptText.includes('astro'))
                return 4321;
            if (scriptText.includes('vite preview'))
                return 4173;
            if (scriptText.includes('vite'))
                return 5173;
            if (scriptText.includes('webpack-dev-server'))
                return 8080;
            // Only use dependency heuristics if scripts provide no recognizable server hint.
            if (!scriptText.trim()) {
                if (depText.includes('"next"'))
                    return 3000;
                if (depText.includes('"nuxt"'))
                    return 3000;
                if (depText.includes('"astro"'))
                    return 4321;
                if (depText.includes('"vite"'))
                    return 5173;
            }
        }
        catch {
            return null;
        }
        return null;
    }
    isPortInUse(port) {
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
        await this.resolveNodePackageManager(cwd);
    }
    async resolveNodePackageManager(cwd) {
        const pm = this.detectNodePm(cwd);
        if (pm === 'npm')
            return 'npm';
        const exists = await this.commandExists(pm);
        if (exists)
            return pm;
        this.onLog(`[Warning] ${pm} not found, falling back to npm`);
        return 'npm';
    }
    async handleNodeInstallFailure(ctx, cwd, hasNpmLock) {
        const output = String(this.lastCommandOutput || '').toLowerCase();
        const hasDocker = await this.commandExists('docker');
        const guidance = this.buildNodeConflictGuidance(output, hasDocker);
        const choice = await this.resolveConflict({
            component: 'node-dependencies',
            projectType: ctx.projectType,
            message: guidance,
            installUrl: 'https://docs.npmjs.com/cli/v10/using-npm/workspaces',
        });
        if (choice === 'docker') {
            throw new DockerFallbackRequestedError('User chose Docker for Node dependency conflict.');
        }
        const retryPm = await this.resolveNodePackageManager(cwd);
        const retryCmd = retryPm === 'npm' && hasNpmLock ? 'npm ci' : `${retryPm} install`;
        this.onLog('[Info] Retrying dependency install after user-guided conflict resolution...');
        return await this.runCommand(retryCmd, cwd, ctx.projectId);
    }
    buildNodeConflictGuidance(output, hasDocker) {
        if (output.includes('eunsupportedprotocol') && output.includes('workspace:')) {
            return [
                'npm cannot install this project because it uses workspace:* dependencies.',
                'Primary suggestion: enable pnpm with corepack, then retry from the monorepo root.',
                'Command: corepack enable ; corepack prepare pnpm@latest --activate',
                hasDocker ? 'Docker is available. Use Docker to bypass the workspace/tooling conflict.' : '',
            ].filter(Boolean).join('\n');
        }
        if (output.includes('eresolve')) {
            return [
                'npm failed because of a peer dependency conflict (ERESOLVE).',
                'Primary suggestion: align the conflicting package versions, then retry.',
                'Example: eslint 9 is incompatible with @typescript-eslint/parser 6.x; either downgrade eslint or upgrade the parser/plugin pair.',
                hasDocker ? 'Docker is available. Use Docker to bypass the local dependency-tree conflict.' : '',
            ].filter(Boolean).join('\n');
        }
        if (hasDocker) {
            return [
                'Dependency installation failed.',
                'Primary suggestion: use Docker to bypass the local Node/package-manager conflict.',
                'If you prefer local install, fix the package manager or dependency tree, then retry.',
            ].join('\n');
        }
        return [
            'Dependency installation failed.',
            'Primary suggestion: inspect the install log, fix the first reported issue, then retry.',
        ].join('\n');
    }
    async handlePhpInstallFailure(ctx, cwd) {
        const output = String(this.lastCommandOutput || '').toLowerCase();
        const hasDocker = await this.commandExists('docker');
        const guidance = this.buildPhpConflictGuidance(output, hasDocker);
        const choice = await this.resolveConflict({
            component: 'php-dependencies',
            projectType: ctx.projectType,
            message: guidance,
            installUrl: 'https://getcomposer.org/doc/',
        });
        if (choice === 'docker') {
            throw new DockerFallbackRequestedError('User chose Docker for PHP dependency conflict.');
        }
        this.onLog('[Info] Retrying composer install after user-guided conflict resolution...');
        return await this.runCommand('composer install', cwd, ctx.projectId);
    }
    buildPhpConflictGuidance(output, hasDocker) {
        if (output.includes('your php version')
            && output.includes('does not satisfy that requirement')) {
            return [
                'Composer failed because the project dependencies require a newer PHP version than the current runtime.',
                'Primary suggestion: upgrade your PHP runtime/container to the version required by composer.lock (commonly PHP 8.1+).',
                'Then run: composer install',
                hasDocker ? 'Docker is available. Use Docker with a PHP 8.1/8.2 image to bypass local PHP mismatch.' : '',
            ].filter(Boolean).join('\n');
        }
        if (output.includes('failed opening required') && output.includes('vendor/autoload.php')) {
            return [
                'Application failed because vendor/autoload.php is missing (dependencies not installed).',
                'Primary suggestion: run composer install in the project root, then relaunch.',
                hasDocker ? 'Docker is available. You can run composer install inside the app container and retry.' : '',
            ].filter(Boolean).join('\n');
        }
        if (output.includes('your requirements could not be resolved')) {
            return [
                'Composer could not resolve dependency constraints.',
                'Primary suggestion: inspect the first reported package conflict and align version constraints, then retry composer install.',
                hasDocker ? 'Docker is available. Use Docker if your local PHP/extensions differ from project requirements.' : '',
            ].filter(Boolean).join('\n');
        }
        return [
            'Composer install failed.',
            'Primary suggestion: inspect the first composer error, apply the fix, then retry.',
            hasDocker ? 'Docker is available. Use Docker to bypass local PHP/runtime differences.' : '',
        ].filter(Boolean).join('\n');
    }
    async resolveJavaBuildTool(cwd) {
        if (fs.existsSync(path.join(cwd, 'pom.xml')) && await this.commandExists('mvn'))
            return 'maven';
        const hasGradleFile = fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'));
        if (hasGradleFile && (fs.existsSync(path.join(cwd, 'gradlew')) || fs.existsSync(path.join(cwd, 'gradlew.bat')) || await this.commandExists('gradle')))
            return 'gradle';
        return null;
    }
    async resolveJavaBuildToolForDocker(cwd) {
        const pom = await this.findFileRecursive(cwd, 'pom.xml', 3);
        if (pom)
            return 'maven';
        const gradle = await this.findFileRecursive(cwd, 'build.gradle', 3) || await this.findFileRecursive(cwd, 'build.gradle.kts', 3);
        if (gradle)
            return 'gradle';
        return null;
    }
    gradleWrapper(cwd) {
        if (process.platform === 'win32' && fs.existsSync(path.join(cwd, 'gradlew.bat')))
            return 'gradlew.bat';
        if (fs.existsSync(path.join(cwd, 'gradlew')))
            return './gradlew';
        return 'gradle';
    }
    async getGradleVersion(cwd) {
        const wrapperVersion = this.getGradleVersionFromWrapper(cwd);
        if (wrapperVersion)
            return wrapperVersion;
        const output = await this.execAndCapture(`${this.gradleWrapper(cwd)} --version`, cwd);
        if (!output)
            return null;
        const match = output.match(/Gradle\s+(\d+(?:\.\d+){0,2})/i);
        return match ? match[1] : null;
    }
    getGradleVersionFromWrapper(cwd) {
        const wrapperPropsPath = path.join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties');
        if (!fs.existsSync(wrapperPropsPath))
            return null;
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
        if (!gradleVersion || !javaVersion)
            return false;
        const gradleMajor = parseInt(gradleVersion.split('.')[0], 10);
        const javaMajor = parseInt(javaVersion.split('.')[0], 10);
        if (Number.isNaN(gradleMajor) || Number.isNaN(javaMajor))
            return false;
        if (javaMajor >= 17 && gradleMajor < 7)
            return true;
        if (javaMajor >= 21 && gradleMajor < 8)
            return true;
        return false;
    }
    findPhpEntry(cwd) {
        for (const f of ['index.php', 'public/index.php', 'public_html/index.php', 'src/index.php', 'app/index.php', 'www/index.php']) {
            if (fs.existsSync(path.join(cwd, f)))
                return f;
        }
        const rootPhp = fs.readdirSync(cwd).find(f => f.endsWith('.php'));
        return rootPhp ?? 'index.php';
    }
    findGoMain(cwd) {
        if (fs.existsSync(path.join(cwd, 'main.go')))
            return 'main.go';
        const cmdDir = path.join(cwd, 'cmd');
        if (fs.existsSync(cmdDir)) {
            const subdirs = fs.readdirSync(cmdDir, { withFileTypes: true }).filter(e => e.isDirectory());
            if (subdirs.length > 0)
                return `./cmd/${subdirs[0].name}`;
        }
        return null;
    }
    async fileContains(cwd, file, text) {
        const fullPath = path.join(cwd, file);
        if (!fs.existsSync(fullPath))
            return false;
        return fs.readFileSync(fullPath, 'utf8').includes(text);
    }
    async shouldSkipCraPreflight(cwd, cmd) {
        if (!cmd.includes('npm start') && !cmd.includes('react-scripts start'))
            return false;
        const packageJsonPath = path.join(cwd, 'package.json');
        if (!fs.existsSync(packageJsonPath))
            return false;
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
            return Boolean(String(pkg.scripts?.start ?? '').includes('react-scripts') || deps['react-scripts']);
        }
        catch {
            return false;
        }
    }
    async shouldEnableLegacyOpenSsl(cwd, cmd) {
        const packageJsonPath = path.join(cwd, 'package.json');
        if (!fs.existsSync(packageJsonPath))
            return false;
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
            const usesReactScripts = String(pkg.scripts?.start ?? '').includes('react-scripts') || Boolean(deps['react-scripts']);
            const usesWebpack4 = /^4\./.test(String(deps.webpack ?? ''));
            const launchesFrontendDev = /npm\s+start|react-scripts\s+start|webpack-dev-server/.test(cmd);
            return launchesFrontendDev && (usesReactScripts || usesWebpack4);
        }
        catch {
            return false;
        }
    }
    async findFileRecursive(cwd, filename, maxDepth = 3, currentDepth = 0) {
        if (currentDepth > maxDepth)
            return null;
        if (fs.existsSync(path.join(cwd, filename)))
            return filename;
        try {
            const entries = fs.readdirSync(cwd, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    const result = await this.findFileRecursive(path.join(cwd, entry.name), filename, maxDepth, currentDepth + 1);
                    if (result)
                        return path.join(entry.name, result).replace(/\\/g, '/');
                }
            }
        }
        catch { }
        return null;
    }
    /**
     * Find a file, first checking in the src folder, then recursively in subdirectories.
     * If not found and user callback is available, asks user to specify the file location.
     */
    async findFileWithSrcFallback(cwd, filename, ctx) {
        // Check in src folder first
        const srcPath = path.join(cwd, 'src', filename);
        if (fs.existsSync(srcPath)) {
            return `src/${filename}`;
        }
        // Try recursive search in other folders
        const found = await this.findFileRecursive(cwd, filename);
        if (found) {
            return found;
        }
        // File not found, ask user to specify location
        if (ctx && this.onConflictResolution) {
            this.onLog(`[File] Could not find ${filename} in src folder or subdirectories.`);
            const choice = await this.resolveConflict({
                component: `Python entry point (${filename})`,
                projectType: ctx.projectType,
                message: `Could not automatically locate ${filename}. You can specify its location (e.g., src/${filename}, services/${filename}, or just ${filename} if in project root).`,
                allowFileInput: true,
            });
            if (typeof choice === 'object' && choice.action === 'specifyFile' && choice.value) {
                const specifiedPath = choice.value.trim();
                // Verify the specified file exists
                if (fs.existsSync(path.join(cwd, specifiedPath))) {
                    this.onLog(`[File] Using user-specified file: ${specifiedPath}`);
                    return specifiedPath;
                }
                else {
                    this.onLog(`[File] Specified file not found at: ${specifiedPath}`);
                    throw new Error(`Specified file not found: ${specifiedPath}`);
                }
            }
        }
        return null;
    }
    normalizeSpecifiedPythonFile(specifiedFile) {
        return specifiedFile.trim().replace(/^['"]|['"]$/g, '');
    }
    async promptUserToAddPythonEntryPoint(ctx, useVenv, errorMessage) {
        this.onLog('[Launch] Python entry file is missing. Waiting for user to provide a location.');
        let lastValidationError = errorMessage;
        while (true) {
            const basePrompt = 'Python entry file was not found in src or subdirectories. Enter a valid entry file path such as src/main.py, app.py, or manage.py, then choose "I Fixed It, Retry".';
            const choice = await this.resolveConflict({
                component: 'python-entrypoint',
                projectType: ctx.projectType,
                message: lastValidationError ? `${basePrompt} Last input error: ${lastValidationError}` : basePrompt,
                installUrl: undefined,
                allowFileInput: true,
            });
            if (choice === 'docker') {
                throw new DockerFallbackRequestedError('User chose Docker while fixing missing Python entry point.');
            }
            if (typeof choice === 'object' && choice.action === 'specifyFile') {
                try {
                    const runCommand = await this.resolveRunCommand(ctx, useVenv, choice.value);
                    this.onLog(`[Launch] Using user-specified Python entry file: ${this.normalizeSpecifiedPythonFile(choice.value)}`);
                    return runCommand;
                }
                catch (verifyErr) {
                    lastValidationError = String(verifyErr?.message ?? errorMessage);
                    this.onLog(`[Launch] Entry-point check failed: ${lastValidationError}`, 'warning');
                    continue;
                }
            }
            lastValidationError = errorMessage;
        }
    }
    detectNodePm(cwd) {
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')))
            return 'pnpm';
        if (fs.existsSync(path.join(cwd, 'yarn.lock')))
            return 'yarn';
        return 'npm';
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
        return new Promise(resolve => {
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
        return new Promise(resolve => {
            cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
                const output = (stdout || '').trim();
                const errorOutput = (stderr || err?.message || '').trim();
                if (err) {
                    resolve({ ok: false, output, errorOutput });
                    return;
                }
                const combinedOutput = `${output}\n${errorOutput}`;
                const hasDockerError = /Error response from daemon|Bind for|port.*already allocated/i.test(combinedOutput);
                resolve({ ok: !hasDockerError, output, errorOutput: hasDockerError ? combinedOutput : '' });
            });
        });
    }
    async resolveConflict(info) {
        const missingRuntimePattern = /(not\s+installed|not\s+found|missing|unavailable)/i;
        if (this.troubleshootMode === 'auto') {
            if (info.allowFileInput) {
                this.onLog('[Auto] Could not infer a file path automatically; falling back to manual handling.');
                return 'manual';
            }
            const hasDocker = await this.commandExists('docker');
            if (hasDocker) {
                this.onLog(`[Auto] Resolving ${info.component} conflict with Docker.`);
                return 'docker';
            }
            this.onLog(`[Auto] Docker is unavailable, so ${info.component} will be retried manually.`);
            return 'manual';
        }
        if (this.onRuntimeMissing && info.installUrl && missingRuntimePattern.test(info.message)) {
            await this.onRuntimeMissing({ tool: info.component, installUrl: info.installUrl, projectType: info.projectType, message: info.message });
        }
        this.onLog('[Paused] Installation is waiting for your conflict resolution choice in the extension panel.');
        if (this.onConflictResolution)
            return await this.onConflictResolution(info);
        return 'manual';
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
        if (ctx.projectType === 'php')
            return fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer:2' : 'php:8.2-cli';
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildToolForDocker(cwd);
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
            const pm = this.detectNodePm(cwd);
            const rawRunCmd = this.resolveNodeRunCommandForDocker(ctx, cwd, pm);
            const runCmd = this.normalizeNodeRunCommandForPackageManager(rawRunCmd, pm);
            const authEnvBootstrap = this.buildNodeDockerAuthEnvBootstrap(cwd, port, runCmd);
            if (pm === 'pnpm') {
                const install = 'corepack enable && corepack prepare pnpm@latest --activate && pnpm install';
                return `${install} && ${authEnvBootstrap}${runCmd}`;
            }
            if (pm === 'yarn') {
                const install = 'corepack enable && corepack prepare yarn@stable --activate && yarn install';
                return `${install} && ${authEnvBootstrap}${runCmd}`;
            }
            const install = fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'npm ci' : 'npm install';
            return `${install} && ${authEnvBootstrap}${runCmd}`;
        }
        if (ctx.projectType === 'python') {
            const install = fs.existsSync(path.join(cwd, 'requirements.txt')) ? 'pip install -r requirements.txt && ' : '';
            const runCmd = (await this.resolveRunCommand(ctx, false)).replace(/^"?[A-Za-z]:[^\s"]*python(?:\.exe)?"?\s+/i, 'python ');
            return `${install}${runCmd}`;
        }
        if (ctx.projectType === 'php') {
            const composerInstall = fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer install && ' : '';
            if (fs.existsSync(path.join(cwd, 'artisan')))
                return `${composerInstall}php artisan serve --host=0.0.0.0 --port=${port}`;
            if (fs.existsSync(path.join(cwd, 'public', 'index.php')))
                return `${composerInstall}php -S 0.0.0.0:${port} -t public public/index.php`;
            if (fs.existsSync(path.join(cwd, 'index.php')))
                return `${composerInstall}php -S 0.0.0.0:${port} -t . index.php`;
            const entry = this.findPhpEntry(cwd);
            return `${composerInstall}php -S 0.0.0.0:${port} -t ${path.dirname(entry) === '.' ? '.' : path.dirname(entry)} ${entry}`;
        }
        if (ctx.projectType === 'java') {
            const tool = await this.resolveJavaBuildToolForDocker(cwd);
            if (!tool || tool === 'maven')
                return `mvn spring-boot:run -q -Dspring-boot.run.arguments=--server.port=${port}`;
            const hasSpring = await this.fileContains(cwd, 'build.gradle', 'spring-boot') || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot');
            return hasSpring ? `gradle bootRun --no-daemon --args='--server.port=${port}'` : 'gradle run --no-daemon';
        }
        if (ctx.projectType === 'ruby') {
            if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
                const rails = fs.existsSync(path.join(cwd, 'config', 'application.rb'));
                return rails ? `bundle install && bundle exec rails server -b 0.0.0.0 -p ${port}` : `bundle install && bundle exec ruby ${this.findRubyEntry(cwd)}`;
            }
            return `ruby ${this.findRubyEntry(cwd)}`;
        }
        if (ctx.projectType === 'go') {
            const mainFile = this.findGoMain(cwd);
            return mainFile ? `go run ${mainFile}` : 'go run .';
        }
        return 'sleep infinity';
    }
    resolveNodeRunCommandForDocker(ctx, cwd, pm) {
        const packageJsonPath = path.join(cwd, 'package.json');
        const scripts = fs.existsSync(packageJsonPath)
            ? (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).scripts ?? {})
            : {};
        const normalizedRunCommand = (ctx.runCommand ?? '').trim();
        if (normalizedRunCommand.length > 0) {
            const scriptMatch = normalizedRunCommand.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)$/i);
            if (!scriptMatch) {
                return normalizedRunCommand;
            }
            const scriptName = scriptMatch[1];
            if (scripts[scriptName]) {
                return `${pm} run ${scriptName}`;
            }
            this.onLog(`[Warning] Backend run command "${normalizedRunCommand}" references missing script "${scriptName}". Falling back.`);
        }
        if (scripts.start)
            return `${pm} start`;
        if (scripts.dev)
            return `${pm} run dev`;
        if (scripts.serve)
            return `${pm} run serve`;
        if (scripts.preview)
            return `${pm} run preview`;
        return `${pm} run dev`;
    }
    buildNodeDockerAuthEnvBootstrap(cwd, port, runCmd) {
        if (!this.isLikelyNextAuthProject(cwd, runCmd)) {
            return '';
        }
        return [
            'if [ -z "$AUTH_SECRET" ]; then export AUTH_SECRET="project-assistant-dev-secret"; fi',
            'if [ -z "$NEXTAUTH_SECRET" ]; then export NEXTAUTH_SECRET="$AUTH_SECRET"; fi',
            `if [ -z "$NEXTAUTH_URL" ]; then export NEXTAUTH_URL="http://localhost:${port}"; fi`,
        ].join(' && ') + ' && ';
    }
    isLikelyNextAuthProject(cwd, runCmd) {
        const normalizedCmd = (runCmd || '').toLowerCase();
        if (normalizedCmd.includes('next')) {
            return true;
        }
        const packageJsonPath = path.join(cwd, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return false;
        }
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const combinedText = JSON.stringify({
                name: pkg.name,
                dependencies: pkg.dependencies ?? {},
                devDependencies: pkg.devDependencies ?? {},
            }).toLowerCase();
            return (combinedText.includes('next-auth')
                || combinedText.includes('@auth/core')
                || combinedText.includes('@auth/'));
        }
        catch {
            return false;
        }
    }
    normalizeNodeRunCommandForPackageManager(cmd, pm) {
        const trimmed = (cmd || '').trim();
        if (!trimmed)
            return trimmed;
        if (pm === 'pnpm') {
            return trimmed
                .replace(/^npm\s+run\s+/i, 'pnpm run ')
                .replace(/^npm\s+/i, 'pnpm ')
                .replace(/^yarn\s+run\s+/i, 'pnpm run ')
                .replace(/^yarn\s+/i, 'pnpm ');
        }
        if (pm === 'yarn') {
            return trimmed
                .replace(/^npm\s+run\s+/i, 'yarn ')
                .replace(/^npm\s+/i, 'yarn ')
                .replace(/^pnpm\s+run\s+/i, 'yarn ')
                .replace(/^pnpm\s+/i, 'yarn ');
        }
        return trimmed
            .replace(/^pnpm\s+run\s+/i, 'npm run ')
            .replace(/^pnpm\s+/i, 'npm ')
            .replace(/^yarn\s+run\s+/i, 'npm run ')
            .replace(/^yarn\s+/i, 'npm ');
    }
    findRubyEntry(cwd) {
        for (const f of ['app.rb', 'main.rb', 'server.rb']) {
            if (fs.existsSync(path.join(cwd, f)))
                return f;
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
            const commandOutput = [];
            const proc = cp.spawn(cmd, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
            proc.stdout?.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => {
                const msg = l.trim();
                commandOutput.push(msg);
                this.onLog(msg);
            }));
            proc.stderr?.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => {
                const msg = l.trim();
                commandOutput.push(msg);
                this.onLog(msg, 'stderr');
            }));
            proc.on('close', code => {
                this.lastCommandOutput = commandOutput.join('\n');
                resolve(code === 0);
            });
            proc.on('error', err => {
                this.lastCommandOutput = `${commandOutput.join('\n')}\n${err.message}`;
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
    shouldRequireHttpReadiness(projectType) {
        return ['nodejs', 'python', 'php', 'ruby', 'go', 'java'].includes(projectType);
    }
    getDockerHttpReadinessTimeoutMs(projectType) {
        if (projectType === 'nodejs') {
            // Monorepos can spend several minutes on first pnpm install before app boot.
            return 8 * 60_000;
        }
        if (projectType === 'python') {
            // Older Django apps can take longer to import settings, run startup hooks, and warm caches.
            return 4 * 60_000;
        }
        if (projectType === 'java') {
            return 4 * 60_000;
        }
        return 60_000;
    }
    waitForHttpReady(port, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const http = __webpack_require__(7);
            const probe = () => {
                if (Date.now() - start > timeoutMs) {
                    resolve(false);
                    return;
                }
                const req = http.get({
                    host: '127.0.0.1',
                    port,
                    path: '/',
                    timeout: 1500,
                }, (res) => {
                    res.resume();
                    resolve(true);
                });
                req.on('error', () => setTimeout(probe, 1000));
                req.on('timeout', () => {
                    req.destroy();
                    setTimeout(probe, 1000);
                });
            };
            probe();
        });
    }
    async isPortAvailable(port) {
        const hasActiveListener = (await this.canConnectToPort(port, '127.0.0.1')) || (await this.canConnectToPort(port, '::1'));
        if (hasActiveListener)
            return false;
        return (await this.canBindPort(port, '0.0.0.0')) || (await this.canBindPort(port, '::'));
    }
    canConnectToPort(port, host) {
        return new Promise(resolve => {
            const net = __webpack_require__(13);
            const socket = new net.Socket();
            let resolved = false;
            const finish = (v) => { if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(v);
            } };
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
            const finish = (v) => { if (!resolved) {
                resolved = true;
                resolve(v);
            } };
            server.once('error', () => finish(false));
            server.once('listening', () => { server.close(() => finish(true)); });
            server.listen(port, host);
        });
    }
    async findAvailablePort(startPort, maxAttempts = 50) {
        for (let i = 0; i < maxAttempts; i++) {
            const candidate = startPort + i;
            if (await this.isPortAvailable(candidate))
                return candidate;
        }
        return null;
    }
    async reportProgress(projectId, progress, step) {
        this.onLog(`[${progress}%] ${step}`);
        try {
            await this.apiClient.post(`/api/projects/${projectId}/install-progress`, { progress, step });
        }
        catch (err) {
            if (err?.response?.status === 401)
                this.onLog('[Warning] Session expired — progress will not sync to dashboard', 'stderr');
        }
    }
    async reportComplete(projectId, success, port, error) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await this.publicApiClient.post(`/api/projects/${projectId}/install-complete`, { success, port, error });
                return;
            }
            catch (err) {
                if (attempt === 3)
                    this.onLog(`[Warning] Could not report completion to backend after ${attempt} attempts`, 'stderr');
                else
                    await new Promise(r => setTimeout(r, attempt * 1000));
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
    _showTroubleshootActions = false;
    _showFileInput = false;
    _installInProgress = false;
    _isAuthenticated = false;
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
        this._showTroubleshootActions = false;
        this._postActionState();
    }
    setTroubleshootModeAction(message) {
        this._actionMessage = message;
        this._installGuideUrl = undefined;
        this._showConflictActions = false;
        this._showTroubleshootActions = true;
        this._showFileInput = false;
        this._postActionState();
    }
    setConflictAction(message, installGuideUrl, showFileInput = false) {
        this._actionMessage = message;
        this._installGuideUrl = installGuideUrl;
        this._showConflictActions = !showFileInput;
        this._showTroubleshootActions = false;
        this._showFileInput = showFileInput;
        this._postActionState();
    }
    setInstallInProgress(active) {
        this._installInProgress = active;
        this._postActionState();
    }
    setAuthenticated(isAuthenticated) {
        this._isAuthenticated = isAuthenticated;
        this._postActionState();
    }
    clearInstallAction() {
        this._actionMessage = undefined;
        this._installGuideUrl = undefined;
        this._showConflictActions = false;
        this._showTroubleshootActions = false;
        this._showFileInput = false;
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
            showTroubleshootActions: this._showTroubleshootActions,
            showFileInput: this._showFileInput,
            installInProgress: this._installInProgress,
            isAuthenticated: this._isAuthenticated,
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
            align-items: flex-start;
          }

          .toolbar-stack {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          #analyze-btn {
            background: color-mix(in srgb, var(--accent) 82%, #000 18%);
            border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
            color: var(--vscode-button-foreground);
            font-weight: 600;
          }

          #analyze-btn:hover {
            background: color-mix(in srgb, var(--accent) 88%, #000 12%);
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

          body[data-authenticated="false"] #sign-out-btn { display: none; }
          body[data-authenticated="true"] #sign-in-btn { display: none; }

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
      <body data-authenticated="false">
        <div class="header">
          <div class="title">
            <button id="analyze-btn" type="button">Analyse</button>
            <h1>Console</h1>
            <p>Authentication, install, and runtime logs shown here.</p>
          </div>
          <div class="toolbar">
            <div class="toolbar-stack">
              <button id="clear-btn" type="button">Clear</button>
              <button id="cancel-install-btn" type="button" disabled>Cancel</button>
            </div>
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
              <div id="troubleshoot-row" class="action-row" style="display:none;">
                <button id="auto-troubleshoot-btn" type="button">Auto troubleshoot</button>
                <button id="guided-troubleshoot-btn" type="button">Guided troubleshoot</button>
              </div>
              <div id="file-input-row" class="action-row" style="display:none;">
                <input id="file-input" type="text" placeholder="Enter Python entry file (e.g., src/main.py, app.py, or services/app.py)" style="flex: 1; padding: 6px;">
                <button id="submit-file-btn" type="button">Submit</button>
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
          const autoTroubleshootBtn = document.getElementById('auto-troubleshoot-btn');
          const guidedTroubleshootBtn = document.getElementById('guided-troubleshoot-btn');
          const troubleshootRow = document.getElementById('troubleshoot-row');
          const fileInputRow = document.getElementById('file-input-row');
          const fileInput = document.getElementById('file-input');
          const submitFileBtn = document.getElementById('submit-file-btn');
          const analyzeBtn = document.getElementById('analyze-btn');
          const clearBtn = document.getElementById('clear-btn');
          const cancelInstallBtn = document.getElementById('cancel-install-btn');
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

          analyzeBtn.addEventListener('click', () => {
            if (analyzeBtn.disabled) {
              return;
            }
            vscode.postMessage({ type: 'uiAction', action: 'analyzeWorkspace' });
          });

          clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
          });

          cancelInstallBtn.addEventListener('click', () => {
            if (cancelInstallBtn.disabled) {
              return;
            }
            vscode.postMessage({ type: 'uiAction', action: 'cancelInstall' });
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

          autoTroubleshootBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'chooseAutoTroubleshoot' });
          });

          guidedTroubleshootBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'chooseGuidedTroubleshoot' });
          });

          submitFileBtn.addEventListener('click', () => {
            const filename = fileInput.value.trim();
            if (filename.length === 0) {
              fileInput.focus();
              return;
            }
            actionText.textContent = 'Submitting specified file...';
            vscode.postMessage({ type: 'uiAction', action: 'specifyFile', payload: filename });
            fileInput.value = '';
          });

          fileInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitFileBtn.click();
            }
          });

          signInBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'login' });
          });

          signOutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'uiAction', action: 'logout' });
          });

          window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
              case 'snapshot':
                entries = message.entries || [];
                render();
                break;
              case 'append':
                if (message.entry) {
                  entries.push(message.entry);
                  if (entries.length > 400) {
                    entries.splice(0, entries.length - 400);
                  }
                  render();
                }
                break;
              case 'clear':
                entries = [];
                render();
                break;
              case 'actionState':
                actionText.textContent = message.message || '';
                installGuideUrl = message.installGuideUrl;
                actionCard.style.display = message.message ? 'block' : 'none';
                actions.classList.toggle('visible', !!message.message);
                installGuideBtn.style.display = message.installGuideUrl ? 'block' : 'none';
                useDockerBtn.style.display = message.showConflictActions ? 'block' : 'none';
                retryConflictBtn.style.display = message.showConflictActions ? 'block' : 'none';
                troubleshootRow.style.display = message.showTroubleshootActions ? 'flex' : 'none';
                fileInputRow.style.display = message.showFileInput ? 'flex' : 'none';
                cancelInstallBtn.disabled = !message.installInProgress;
                document.body.dataset.authenticated = String(!!message.isAuthenticated);
                scrollToLatest();
                break;
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
