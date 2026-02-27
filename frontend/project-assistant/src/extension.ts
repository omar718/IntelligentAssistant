import * as vscode from 'vscode';
import { ChatViewProvider } from './webviews/chatViewProvider';
import { startServer, stopServer, isServerRunning } from './services/server';
import { getAvailableModels } from './services/llmService';

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage('Project Assistant activated');

  const outputChannel = vscode.window.createOutputChannel('Project Assistant API');
  context.subscriptions.push(outputChannel);

  const showApiInfo = (port: number) => {
    outputChannel.clear();
    outputChannel.appendLine(`URL: http://localhost:${port}/Mobelite/chat`);
    outputChannel.appendLine(' Method: POST');
    outputChannel.appendLine('--------------------------------------------------');
    outputChannel.appendLine('Request Body (JSON):');
    outputChannel.appendLine(
      JSON.stringify(
        {
          prompt: 'Your prompt here...',
        },
        null,
        2
      )
    );
    outputChannel.appendLine('--------------------------------------------------');
    outputChannel.appendLine('Expected Response (JSON):');
    outputChannel.appendLine(
      JSON.stringify(
        {
          result: 'The refined or generated response text.',
        },
        null,
        2
      )
    );
    outputChannel.appendLine('--------------------------------------------------');
    outputChannel.show();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('project-assistant.showApiInfo', (port: number) => {
      showApiInfo(port || 6009);
    })
  );

  getAvailableModels().catch(console.error);
  context.subscriptions.push(
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
    )
  );

  context.subscriptions.push(
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('project-assistant.getModels', async () => {
      const models = await getAvailableModels();
      return models;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('project-assistant.getServerStatus', () => {
      return { running: isServerRunning() };
    })
  );

  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  const disposable = vscode.commands.registerCommand('project-assistant.openAssistant', () => {
    vscode.commands.executeCommand('workbench.view.extension.project-assistant-sidebar');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {
  return stopServer();
}
