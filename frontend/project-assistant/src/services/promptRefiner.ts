import * as vscode from 'vscode';
import { selectModel } from './llmService';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RefineResponse {
  type: string;
  text: string;
  options?: string[];
}

export async function refinePrompt(
  history: ChatMessage[],
  modelId?: string,
  systemPrompt?: string
): Promise<RefineResponse> {
  try {
    const targetModel = await selectModel(modelId);
    return await refineWithModel(targetModel, history, systemPrompt);
  } catch (error) {
    const err = error as Error;
    console.error('Error in refinePrompt:', err);
    throw new Error('Error processing request: ' + err.message);
  }
}

async function refineWithModel(
  model: vscode.LanguageModelChat,
  history: ChatMessage[],
  customSystemPrompt?: string
): Promise<RefineResponse> {
  const defaultSystemPrompt = `Analyze user requests and either ask clarifying questions or provide detailed prompts. If unclear, return JSON: {"type": "question", "text": "...", "options": [...]}. If clear, return: {"type": "refined", "text": "..."}. Include context, instructions, and expected output.`;

  const systemPrompt = customSystemPrompt || defaultSystemPrompt;

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    ...history.map((msg) =>
      msg.role === 'user'
        ? vscode.LanguageModelChatMessage.User(msg.content)
        : vscode.LanguageModelChatMessage.Assistant(msg.content)
    ),
  ];

  const chatResponse = await model.sendRequest(
    messages,
    {},
    new vscode.CancellationTokenSource().token
  );
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
    return JSON.parse(jsonString) as RefineResponse;
  } catch (e) {
    return { type: 'refined', text: rawResponse };
  }
}
