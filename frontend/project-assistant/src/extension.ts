import * as vscode from 'vscode';
import * as os from 'os';
import { ChatViewProvider } from './webviews/chatViewProvider';
import {
  startServer,
  stopServer,
  isServerRunning,
  registerOpenFolderCallback,
  registerPickFolderCallback,
} from './services/server';
import { getAvailableModels } from './services/llmService';
import { AuthManager } from './authManager';
import { ProjectsTreeProvider } from './ProjectsTreeProvider';

let authManager: AuthManager;
let treeProvider: ProjectsTreeProvider;

export async function activate(context: vscode.ExtensionContext) {  // ← THIS WAS MISSING

  // ─── Output Channel ───────────────────────────────────────────────────────
  const outputChannel = vscode.window.createOutputChannel('Project Assistant API');
  context.subscriptions.push(outputChannel);

  // ─── Status Bar ───────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  // ─── Projects Tree View ───────────────────────────────────────────────────
  treeProvider = new ProjectsTreeProvider(context);
  vscode.window.registerTreeDataProvider('projectAssistant.projects', treeProvider);

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
  const onOnline = async () => {
    statusBar.text = '$(check) Assistant ready';
    statusBar.backgroundColor = undefined;
    statusBar.command = 'project-assistant.openChat';
    statusBar.show();

    if (authManager.isAuthenticated()) {
      await treeProvider.loadFromApi(authManager.getApiClient());
    } else {
      await treeProvider.clearProjects(false);
      vscode.commands.executeCommand('project-assistant.login');
    }
  };

  const onOffline = () => {
    void treeProvider.clearProjects(false);
  };

  // ─── Auth Manager ─────────────────────────────────────────────────────────
  authManager = new AuthManager(context, statusBar, onOnline, onOffline);

  // ─── Auto-Launch Logic ────────────────────────────────────────────────────
  if (!authManager.isAuthenticated()) {
    showOptionalLoginPrompt();
  }

  // ─── Folder Callbacks ─────────────────────────────────────────────────────
  registerOpenFolderCallback((folderPath: string) => {
    try {
      const uri = vscode.Uri.file(folderPath);
      void vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    } catch (err: any) {
      console.error('Error in openFolderCallback:', err);
      vscode.window.showErrorMessage(`Error opening folder: ${err?.message || 'Unknown error'}`);
    }
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
        await treeProvider.clearProjects(true);
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
    }),

    vscode.commands.registerCommand('project-assistant.openAssistant', () => {
      vscode.commands.executeCommand('workbench.view.extension.project-assistant-sidebar');
    })
  );

  // ─── Chat Webview ─────────────────────────────────────────────────────────
  const provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ─── Activate Auth ────────────────────────────────────────────────────────
  await authManager.activate();

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

export function deactivate() {
  authManager?.deactivate();
  return stopServer();
}