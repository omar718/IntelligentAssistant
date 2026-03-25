"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAvailableModels = getAvailableModels;
exports.selectModel = selectModel;
exports.sendChatRequest = sendChatRequest;
const vscode = __importStar(require("vscode"));
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
//# sourceMappingURL=llmService.js.map