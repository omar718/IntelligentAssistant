import * as vscode from 'vscode';

interface ModelInfo {
  id: string;
  name: string;
  family: string;
}

let cachedModels: ModelInfo[] | null = null;

export async function getAvailableModels(): Promise<ModelInfo[]> {
  if (cachedModels) {
    return cachedModels;
  }

  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    cachedModels = models.map((m: vscode.LanguageModelChat) => ({
      id: m.id,
      name: m.name ?? 'Unknown',
      family: m.family ?? 'unknown',
    }));
    return cachedModels;
  } catch (error) {
    console.error('Error fetching models:', error);
    return [];
  }
}

export async function selectModel(modelId?: string): Promise<vscode.LanguageModelChat> {
  let targetModel: vscode.LanguageModelChat | undefined;

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

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function sendChatRequest(
  history: ChatMessage[],
  modelId?: string,
  systemPrompt?: string
): Promise<string> {
  try {
    const targetModel = await selectModel(modelId);

    const messages: vscode.LanguageModelChatMessage[] = [];
    if (systemPrompt) {
      messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
    }

    messages.push(
      ...history.map((msg) =>
        msg.role === 'user'
          ? vscode.LanguageModelChatMessage.User(msg.content)
          : vscode.LanguageModelChatMessage.Assistant(msg.content)
      )
    );

    const chatResponse = await targetModel.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token
    );
    let rawResponse = '';

    for await (const fragment of chatResponse.text) {
      rawResponse += fragment;
    }

    return rawResponse;
  } catch (error) {
    console.error('Error in sendChatRequest:', error);
    throw error;
  }
}
