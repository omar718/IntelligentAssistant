import * as vscode from 'vscode';

type LogLevel = 'info' | 'warning' | 'error' | 'success';
type UiAction =
  | 'login'
  | 'logout'
  | 'openInstallGuide'
  | 'chooseDocker'
  | 'retryConflict';

interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
}

export class ApiOutputViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'projectAssistant.apiOutput';

  private _view?: vscode.WebviewView;
  private readonly _entries: LogEntry[] = [];
  private _nextId = 1;
  private _installGuideUrl: string | undefined;
  private _actionMessage: string | undefined;
  private _showConflictActions = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _onUiAction?: (action: UiAction, payload?: string) => void,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: any) => {
      switch (message?.type) {
        case 'clear':
          this.clear();
          break;
        case 'uiAction':
          if (typeof message.action === 'string') {
            this._onUiAction?.(message.action as UiAction, message.payload);
          }
          break;
      }
    });

    this._postSnapshot();
    this._postActionState();
  }

  appendLine(message: string, level: LogLevel = 'info'): void {
    const entry: LogEntry = {
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

  clear(): void {
    this._entries.length = 0;
    this._view?.webview.postMessage({ type: 'clear' });
  }

  setInstallAction(message: string, installGuideUrl?: string): void {
    this._actionMessage = message;
    this._installGuideUrl = installGuideUrl;
    this._showConflictActions = false;
    this._postActionState();
  }

  setConflictAction(message: string, installGuideUrl?: string): void {
    this._actionMessage = message;
    this._installGuideUrl = installGuideUrl;
    this._showConflictActions = true;
    this._postActionState();
  }

  clearInstallAction(): void {
    this._actionMessage = undefined;
    this._installGuideUrl = undefined;
    this._showConflictActions = false;
    this._postActionState();
  }

  private _postSnapshot(): void {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({ type: 'snapshot', entries: this._entries });
  }

  private _postActionState(): void {
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

  private _getHtml(webview: vscode.Webview): string {
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