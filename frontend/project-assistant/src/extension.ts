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
      vscode.commands.executeCommand('project-assistant.login');
    }
  };

  const onOffline = () => {
    if (authManager?.isAuthenticated()) {
      treeProvider.loadFromCache();
      return;
    }

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
    const uri = vscode.Uri.file(folderPath);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  });

  registerPickFolderCallback(async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select clone destination',
      title: 'Where should the repository be cloned?',
      defaultUri: vscode.Uri.file(os.homedir()),
    });
    return uris && uris.length > 0 ? uris[0].fsPath : null;
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

    vscode.commands.registerCommand('project-assistant.login', async () => {
      const email = await vscode.window.showInputBox({
        prompt: 'Enter your email',
        placeHolder: 'you@example.com',
        ignoreFocusOut: true,
      });
      if (!email) {
        return;
      }

      const password = await vscode.window.showInputBox({
        prompt: 'Enter your password',
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) {
        return;
      }

      try {
        await authManager.login(email, password);
        await onOnline();
        vscode.window.showInformationMessage('Successfully signed in!');
      } catch (err: any) {
        const msg =
          err?.response?.status === 401
            ? 'Invalid email or password'
            : 'Login failed. Check the backend is running.';
        vscode.window.showErrorMessage(msg);
      }
    }),

    vscode.commands.registerCommand('project-assistant.logout', async () => {
      await authManager.logout();
      await treeProvider.clearProjects(true);
    }),

    vscode.commands.registerCommand('project-assistant.retryConnection', async () => {
      const online = await authManager.checkHealth();
      if (online) {
        onOnline();
      } else {
        vscode.window.showWarningMessage('Backend still offline. Is the server running?');
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