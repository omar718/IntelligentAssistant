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
const chatViewProvider_1 = __webpack_require__(3);
const server_1 = __webpack_require__(6);
const llmService_1 = __webpack_require__(5);
function activate(context) {
    vscode.window.showInformationMessage('Project Assistant activated');
    const outputChannel = vscode.window.createOutputChannel('Project Assistant API');
    context.subscriptions.push(outputChannel);
    const showApiInfo = (port) => {
        outputChannel.clear();
        outputChannel.appendLine(`URL: http://localhost:${port}/Mobelite/chat`);
        outputChannel.appendLine(' Method: POST');
        outputChannel.appendLine('--------------------------------------------------');
        outputChannel.appendLine('Request Body (JSON):');
        outputChannel.appendLine(JSON.stringify({
            prompt: 'Your prompt here...',
        }, null, 2));
        outputChannel.appendLine('--------------------------------------------------');
        outputChannel.appendLine('Expected Response (JSON):');
        outputChannel.appendLine(JSON.stringify({
            result: 'The refined or generated response text.',
        }, null, 2));
        outputChannel.appendLine('--------------------------------------------------');
        outputChannel.show();
    };
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.showApiInfo', (port) => {
        showApiInfo(port || 6009);
    }));
    (0, llmService_1.getAvailableModels)().catch(console.error);
    // Register the open-folder handler — opens a path in a new VS Code window
    (0, server_1.registerOpenFolderCallback)((folderPath) => {
        const uri = vscode.Uri.file(folderPath);
        vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    });
    // Register the pick-folder handler — opens native folder picker dialog
    (0, server_1.registerPickFolderCallback)(async () => {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select clone destination',
            title: 'Where should the repository be cloned?',
            defaultUri: vscode.Uri.file(os.homedir()),
        });
        if (uris && uris.length > 0) {
            return uris[0].fsPath;
        }
        return null;
    });
    // Auto-start the server on activation
    (0, server_1.startServer)(6009).then((port) => {
        outputChannel.appendLine(`Project Assistant server auto-started on port ${port}`);
    }).catch((err) => {
        if (!err.message.includes('already running')) {
            vscode.window.showWarningMessage(`Project Assistant: server could not start — ${err.message}`);
        }
    });
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.startServer', async (port, modelId) => {
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
    }));
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.stopServer', async () => {
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
    }));
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.getModels', async () => {
        const models = await (0, llmService_1.getAvailableModels)();
        return models;
    }));
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.getServerStatus', () => {
        return { running: (0, server_1.isServerRunning)() };
    }));
    const provider = new chatViewProvider_1.ChatViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatViewProvider_1.ChatViewProvider.viewType, provider, {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
    }));
    context.subscriptions.push(vscode.commands.registerCommand('project-assistant.openAssistant', () => {
        vscode.commands.executeCommand('workbench.view.extension.project-assistant-sidebar');
    }));
}
function deactivate() {
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
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ChatViewProvider = void 0;
const promptRefiner_1 = __webpack_require__(4);
class ChatViewProvider {
    _extensionUri;
    static viewType = 'project-assistant.assistant';
    _view;
    _history = [];
    _stepsFile;
    _projectInfo;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlForWebview();
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'userPrompt':
                    console.log('Project assistant received:', data.value);
                    await this.handleUserPrompt(data.value);
                    break;
                case 'uploadStepsFile':
                    this._stepsFile = data.file;
                    this._projectInfo = data.projectInfo;
                    webviewView.webview.postMessage({ type: 'stepsFileLoaded', success: true });
                    break;
                case 'clearHistory':
                    this._history = [];
                    this._saveState();
                    break;
            }
        });
    }
    _saveState() {
        if (!this._view) {
            return;
        }
        const state = {
            history: this._history,
            stepsFile: this._stepsFile,
            projectInfo: this._projectInfo,
        };
        this._view.webview.postMessage({ type: 'saveState', state: state });
    }
    _restoreState() {
        if (!this._view) {
            return;
        }
        const state = {
            history: this._history,
            stepsFile: this._stepsFile,
            projectInfo: this._projectInfo,
        };
        this._view.webview.postMessage({ type: 'restoreState', state: state });
    }
    async handleUserPrompt(prompt) {
        if (!this._view) {
            return;
        }
        this._history.push({ role: 'user', content: prompt });
        this._saveState();
        this._view.webview.postMessage({ type: 'status', value: 'Processing...' });
        try {
            const response = await (0, promptRefiner_1.refinePrompt)(this._history, undefined, undefined);
            if (response.type === 'question') {
                this._history.push({ role: 'assistant', content: response.text });
                this._saveState();
                this._view.webview.postMessage({
                    type: 'question',
                    value: response.text,
                    options: response.options || [],
                });
            }
            if (response.type === 'refined') {
                this._history.push({ role: 'assistant', content: response.text });
                this._saveState();
                this._view.webview.postMessage({
                    type: 'guidance',
                    value: response.text,
                });
            }
            if (response.type === 'guidance') {
                this._history.push({ role: 'assistant', content: response.text });
                this._saveState();
                this._view.webview.postMessage({
                    type: 'guidance',
                    value: response.text,
                });
            }
        }
        catch (error) {
            const err = error;
            this._view.webview.postMessage({ type: 'error', value: err.message });
        }
    }
    _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                :root {
                    --primary-color: #0084ff;
                    --primary-hover: #0078eb;
                    --success-color: #238636;
                    --danger-color: #f85149;
                    --bg-color: transparent;
                    --text-color: var(--vscode-foreground);
                    --border-color: var(--vscode-widget-border);
                    --input-bg: var(--vscode-input-background);
                    --input-fg: var(--vscode-input-foreground);
                }

                * { box-sizing: border-box; }

                body { 
                    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
                    padding: 0;
                    margin: 0;
                    display: flex; 
                    flex-direction: column; 
                    height: 100vh; 
                    overflow: hidden;
                    background-color: var(--vscode-editor-background);
                    color: var(--text-color);
                }

                header {
                    padding: 12px 16px;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    height: 54px;
                    flex-shrink: 0;
                }

                .header-title {
                    font-weight: 600;
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .header-right {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .icon-btn {
                    background: none;
                    border: none;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    padding: 8px;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }
                .icon-btn:hover { background: rgba(128, 128, 128, 0.1); color: var(--vscode-foreground); }
                .icon-btn svg { width: 22px; height: 22px; fill: currentColor; }

                .file-upload-section {
                    padding: 16px;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    flex-shrink: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .setup-title {
                    font-size: 15px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    margin: 0;
                }

                .setup-description {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin: 0;
                    line-height: 1.4;
                }

                .upload-area {
                    border: 2px dashed var(--vscode-panel-border);
                    border-radius: 8px;
                    padding: 24px;
                    text-align: center;
                    cursor: pointer;
                    transition: all 0.2s;
                    background: rgba(128, 128, 128, 0.05);
                }

                .upload-area:hover {
                    border-color: var(--primary-color);
                    background: rgba(0, 132, 255, 0.05);
                }

                .upload-area.dragover {
                    border-color: var(--primary-color);
                    background: rgba(0, 132, 255, 0.1);
                    transform: scale(1.01);
                }

                .upload-icon {
                    width: 32px;
                    height: 32px;
                    fill: var(--vscode-descriptionForeground);
                    margin: 0 auto 8px;
                }

                .upload-text {
                    font-size: 13px;
                    font-weight: 500;
                    margin-bottom: 4px;
                }

                .upload-hint {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }

                #steps-file-input {
                    display: none;
                }

                .file-loaded {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 12px 16px;
                    background: rgba(35, 134, 54, 0.1);
                    border: 1px solid rgba(35, 134, 54, 0.2);
                    border-radius: 6px;
                    font-size: 13px;
                    color: var(--success-color);
                }

                .file-loaded svg {
                    width: 18px;
                    height: 18px;
                    fill: currentColor;
                    flex-shrink: 0;
                }

                .analyse-btn {
                    width: 100%;
                    padding: 10px;
                    border: none;
                    border-radius: 6px;
                    background: var(--primary-color);
                    color: white;
                    font-weight: 600;
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s;
                    margin-top: 8px;
                }

                .analyse-btn:hover {
                    background: var(--primary-hover);
                    box-shadow: 0 2px 6px rgba(0, 132, 255, 0.3);
                }

                .analyse-btn:active {
                    transform: scale(0.98);
                }

                #chat-container {
                    flex: 1;
                    padding: 20px;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    scroll-behavior: smooth;
                }

                .message-wrapper {
                    display: flex;
                    flex-direction: column;
                    max-width: 85%;
                    animation: messageSlide 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
                }

                @keyframes messageSlide {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .message-wrapper.user {
                    align-self: flex-end;
                    align-items: flex-end;
                }
                .message-wrapper.assistant {
                    align-self: flex-start;
                    align-items: flex-start;
                }
                .message-wrapper.error {
                    align-self: center;
                }

                .message-bubble {
                    padding: 12px 16px;
                    font-size: 14px;
                    line-height: 1.5;
                    word-wrap: break-word;
                    position: relative;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }

                .user .message-bubble {
                    background-color: var(--primary-color);
                    color: #ffffff;
                    border-radius: 18px 18px 4px 18px;
                }

                .assistant .message-bubble {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    color: var(--vscode-editor-foreground);
                    border-radius: 18px 18px 18px 4px;
                    border: 1px solid var(--vscode-widget-border);
                }

                .error .message-bubble {
                    background-color: rgba(248, 81, 73, 0.1);
                    color: var(--danger-color);
                    border: 1px solid var(--danger-color);
                    border-radius: 12px;
                }

                .input-container {
                    padding: 16px 20px;
                    background: var(--vscode-editor-background);
                    flex-shrink: 0;
                }

                .chat-input-wrapper {
                    flex: 1;
                    background: var(--input-bg);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 24px;
                    padding: 10px 16px;
                    display: flex;
                    align-items: center;
                    transition: all 0.2s;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.05);
                }
                .chat-input-wrapper:focus-within {
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 2px rgba(0, 132, 255, 0.2);
                }

                .chat-input {
                    flex: 1;
                    background: transparent;
                    border: none;
                    color: var(--input-fg);
                    font-size: 14px;
                    padding: 0;
                    outline: none;
                }

                .send-icon-btn {
                    background: none;
                    border: none;
                    cursor: pointer;
                    color: var(--primary-color);
                    padding: 6px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0.9;
                    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
                }
                .send-icon-btn:hover { opacity: 1; transform: scale(1.1) rotate(-10deg); }
                .send-icon-btn svg { width: 22px; height: 22px; fill: currentColor; }

                ::-webkit-scrollbar { width: 6px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.3); border-radius: 3px; }

                .status-bar {
                    display: none;
                    padding: 20px;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    flex-shrink: 0;
                }

                .status-bar.active {
                    display: block;
                }

                .status-steps {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }

                .status-step {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .status-icon {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    font-weight: 600;
                    font-size: 20px;
                    color: white;
                }

                .status-step.pending .status-icon {
                    background: rgba(128, 128, 128, 0.3);
                    border: 2px solid var(--vscode-panel-border);
                }

                .status-step.active .status-icon {
                    background: var(--primary-color);
                    animation: pulse 1.5s ease-in-out infinite;
                }

                .status-step.completed .status-icon {
                    background: var(--success-color);
                }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.7; }
                }

                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }

                .status-step.active .status-icon::after {
                    content: '';
                    display: inline-block;
                    width: 16px;
                    height: 16px;
                    border: 3px solid white;
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                    position: absolute;
                }

                .status-step.active .status-icon {
                    position: relative;
                }

                .status-text {
                    font-size: 14px;
                    color: var(--vscode-foreground);
                    font-weight: 500;
                }

                .status-step.pending .status-text {
                    opacity: 0.5;
                }
            </style>
        </head>
        <body>
            <header>
                <div class="header-title">
                    <svg style="width:20px;height:20px;fill:currentColor;" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-9l-1 1H5v2h14V4z"/></svg>
                    <span>Project Assistant</span>
                </div>
                <div class="header-right">
                    <button id="new-chat-btn" class="icon-btn" title="New Chat">
                        <svg viewBox="0 0 24 24"><path d="M14.06 9.02l.92.92L5.92 19H5v-.92l9.06-9.06M17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29m-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z"/></svg>
                    </button>
                </div>
            </header>

            <div class="file-upload-section">
                <div>
                    <h2 class="setup-title">Setup your project with AI</h2>
                    <p class="setup-description">The intelligent assistant analyses the project</p>
                </div>
                <div id="upload-area" class="upload-area">
                    <svg class="upload-icon" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                    <div class="upload-text">Drop your steps file here</div>
                    <div class="upload-hint">or click to select .json or .txt</div>
                </div>
                <div id="file-loaded" style="display:none;">
                    <div class="file-loaded">
                        <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                        <span id="file-name">steps file loaded</span>
                    </div>
                    <button id="analyse-btn" class="analyse-btn">🔍 Analyse project</button>
                </div>
                <input type="file" id="steps-file-input" accept=".json,.txt" />
            </div>

            <div id="status-bar" class="status-bar">
                <div class="status-steps">
                    <div class="status-step pending" data-step="analysing">
                        <div class="status-icon">1</div>
                        <div class="status-text">Analysing</div>
                    </div>
                    <div class="status-step pending" data-step="installing">
                        <div class="status-icon">2</div>
                        <div class="status-text">Install Dependencies</div>
                    </div>
                    <div class="status-step pending" data-step="configuring">
                        <div class="status-icon">3</div>
                        <div class="status-text">Configure Environment</div>
                    </div>
                    <div class="status-step pending" data-step="running">
                        <div class="status-icon">4</div>
                        <div class="status-text">Run Application</div>
                    </div>
                </div>
            </div>

            <div id="chat-container">
                <div id="welcome-msg" style="text-align: center; margin-top: 40px; opacity: 0.4; display:flex; flex-direction:column; align-items:center; gap:10px;">
                    <svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:currentColor;"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 14H6l-2 2V4h16v12z"/></svg>
                    <span style="font-size:13px; font-weight:500;">Project Assistant</span>
                </div>
            </div>

            <div class="input-container">
                <div class="chat-input-wrapper">
                    <input type="text" id="prompt-input" class="chat-input" placeholder="Ask about project setup..." autocomplete="off" />
                    <button id="send-btn" class="send-icon-btn" title="Send">
                        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const previousState = vscode.getState() || {};
                
                const chat = document.getElementById('chat-container');
                const inp = document.getElementById('prompt-input');
                const btnSend = document.getElementById('send-btn');
                const btnNewChat = document.getElementById('new-chat-btn');
                
                const uploadArea = document.getElementById('upload-area');
                const fileInput = document.getElementById('steps-file-input');
                const fileLoaded = document.getElementById('file-loaded');
                const fileName = document.getElementById('file-name');
                const statusBar = document.getElementById('status-bar');

                let chatMessages = [];
                let currentFile = null;

                inp.focus();

                // Status bar management
                function showStatusBar() {
                    statusBar.classList.add('active');
                    resetStatusSteps();
                    updateStatusStep('analysing', 'active');
                }

                function hideStatusBar() {
                    statusBar.classList.remove('active');
                }

                function resetStatusSteps() {
                    document.querySelectorAll('.status-step').forEach(step => {
                        step.classList.remove('active', 'completed');
                        step.classList.add('pending');
                    });
                }

                function updateStatusStep(stepName, status) {
                    const steps = {
                        'analysing': 0,
                        'installing': 1,
                        'configuring': 2,
                        'running': 3
                    };

                    const stepIndex = steps[stepName];
                    const stepElements = document.querySelectorAll('.status-step');

                    // Mark previous steps as completed
                    for (let i = 0; i < stepIndex; i++) {
                        stepElements[i].classList.remove('active', 'pending');
                        stepElements[i].classList.add('completed');
                    }

                    // Update current step
                    stepElements[stepIndex].classList.remove('pending');
                    stepElements[stepIndex].classList.add(status);

                    // Mark future steps as pending
                    for (let i = stepIndex + 1; i < stepElements.length; i++) {
                        stepElements[i].classList.remove('active', 'completed');
                        stepElements[i].classList.add('pending');
                    }
                }

                // File upload handling
                uploadArea.onclick = () => fileInput.click();
                uploadArea.ondragover = (e) => {
                    e.preventDefault();
                    uploadArea.classList.add('dragover');
                };
                uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
                uploadArea.ondrop = (e) => {
                    e.preventDefault();
                    uploadArea.classList.remove('dragover');
                    handleFileSelect(e.dataTransfer.files[0]);
                };

                fileInput.onchange = (e) => {
                    handleFileSelect(e.target.files[0]);
                };

                const analyseBtn = document.getElementById('analyse-btn');
                if (analyseBtn) {
                    analyseBtn.onclick = () => {
                        if (currentFile) {
                            showStatusBar();
                            addMsg('Analysing project with file: ' + currentFile.name, 'user');
                            vscode.postMessage({ type: 'analyseProject', file: currentFile });
                        }
                    };
                }

                function handleFileSelect(file) {
                    if (!file) return;
                    if (!file.name.match(/\\.(json|txt)$/)) {
                        vscode.postMessage({ type: 'error', value: 'Please upload a .json or .txt file' });
                        return;
                    }

                    const reader = new FileReader();
                    reader.onload = (e) => {
                        try {
                            let data = e.target.result;
                            let projectInfo = null;
                            
                            if (file.name.endsWith('.json')) {
                                projectInfo = JSON.parse(data);
                            } else {
                                projectInfo = { steps: data };
                            }

                            currentFile = { name: file.name, content: data };
                            vscode.postMessage({ type: 'uploadStepsFile', file: currentFile, projectInfo: projectInfo });
                            
                            uploadArea.style.display = 'none';
                            fileLoaded.style.display = 'block';
                            fileName.textContent = file.name;
                        } catch (err) {
                            vscode.postMessage({ type: 'error', value: 'Failed to read file: ' + err.message });
                        }
                    };
                    reader.readAsText(file);
                }

                // Chat state is cleared on reload - do not restore previous messages
                // Chat messages start fresh each time

                function restoreChatMessages() {
                    const welcome = document.getElementById('welcome-msg');
                    if (welcome) welcome.remove();
                    
                    chatMessages.forEach(msg => {
                        const wrapper = document.createElement('div');
                        wrapper.className = 'message-wrapper ' + msg.type;
                        
                        const bubble = document.createElement('div');
                        bubble.className = 'message-bubble';
                        bubble.textContent = msg.text;
                        
                        wrapper.appendChild(bubble);
                        chat.appendChild(wrapper);
                    });
                    chat.scrollTop = chat.scrollHeight;
                }

                // New Chat
                btnNewChat.onclick = () => {
                   chat.innerHTML = '<div id="welcome-msg" style="text-align: center; margin-top: 40px; opacity: 0.4; display:flex; flex-direction:column; align-items:center; gap:10px;">' +
                        '<svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:currentColor;"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 14H6l-2 2V4h16v12z"/></svg>' +
                        '<span style="font-size:13px; font-weight:500;">Project Assistant</span>' +
                    '</div>';
                   chatMessages = [];
                   hideStatusBar();
                   vscode.setState({ ...vscode.getState(), chatMessages: [] });
                   vscode.postMessage({ type: 'clearHistory' });
                };

                function addMsg(text, type) {
                    const welcome = document.getElementById('welcome-msg');
                    if (welcome) welcome.remove();

                    const wrapper = document.createElement('div');
                    wrapper.className = 'message-wrapper ' + type;
                    
                    const bubble = document.createElement('div');
                    bubble.className = 'message-bubble';
                    bubble.textContent = text;
                    
                    wrapper.appendChild(bubble);
                    chat.appendChild(wrapper);
                    chat.scrollTop = chat.scrollHeight;
                    
                    chatMessages.push({ text, type });
                    vscode.setState({ 
                        ...vscode.getState(), 
                        chatMessages: chatMessages 
                    });
                }

                function sendMessage() {
                    const val = inp.value.trim();
                    if (!val) return;
                    
                    addMsg(val, 'user');
                    vscode.postMessage({ type: 'userPrompt', value: val });
                    inp.value = '';
                }

                btnSend.onclick = sendMessage;
                inp.onkeypress = (e) => { if(e.key === 'Enter') sendMessage(); };

                window.addEventListener('message', event => {
                    const msg = event.data;

                    switch (msg.type) {
                        case 'saveState':
                            if (msg.state) {
                                vscode.setState({
                                    ...vscode.getState(),
                                    stepsFile: msg.state.stepsFile,
                                    projectInfo: msg.state.projectInfo
                                });
                            }
                            break;

                        case 'guidance':
                            addMsg(msg.value, 'assistant');
                            break;

                        case 'statusUpdate':
                            if (msg.step && msg.status) {
                                updateStatusStep(msg.step, msg.status);
                            }
                            break;

                        case 'hideStatus':
                            hideStatusBar();
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
exports.ChatViewProvider = ChatViewProvider;


/***/ }),
/* 4 */
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
exports.refinePrompt = refinePrompt;
const vscode = __importStar(__webpack_require__(1));
const llmService_1 = __webpack_require__(5);
async function refinePrompt(history, modelId, systemPrompt) {
    try {
        const targetModel = await (0, llmService_1.selectModel)(modelId);
        return await refineWithModel(targetModel, history, systemPrompt);
    }
    catch (error) {
        const err = error;
        console.error('Error in refinePrompt:', err);
        throw new Error('Error processing request: ' + err.message);
    }
}
async function refineWithModel(model, history, customSystemPrompt) {
    const defaultSystemPrompt = `Analyze user requests and either ask clarifying questions or provide detailed prompts. If unclear, return JSON: {"type": "question", "text": "...", "options": [...]}. If clear, return: {"type": "refined", "text": "..."}. Include context, instructions, and expected output.`;
    const systemPrompt = customSystemPrompt || defaultSystemPrompt;
    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        ...history.map((msg) => msg.role === 'user'
            ? vscode.LanguageModelChatMessage.User(msg.content)
            : vscode.LanguageModelChatMessage.Assistant(msg.content)),
    ];
    const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let rawResponse = '';
    for await (const fragment of chatResponse.text) {
        rawResponse += fragment;
    }
    let jsonString = rawResponse.trim();
    if (jsonString.startsWith('```json')) {
        jsonString = jsonString.slice(7);
    }
    if (jsonString.startsWith('```')) {
        jsonString = jsonString.slice(3);
    }
    if (jsonString.endsWith('```')) {
        jsonString = jsonString.slice(0, -3);
    }
    try {
        return JSON.parse(jsonString);
    }
    catch (e) {
        return { type: 'refined', text: rawResponse };
    }
}


/***/ }),
/* 5 */
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
const llmService_1 = __webpack_require__(5);
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
                        if (!folderPath) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Missing "path" in request body.' }));
                            return;
                        }
                        if (_openFolderCallback) {
                            _openFolderCallback(folderPath);
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
//# sourceMappingURL=extension.js.map