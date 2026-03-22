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
exports.refinePrompt = refinePrompt;
const vscode = __importStar(require("vscode"));
const llmService_1 = require("./llmService");
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
//# sourceMappingURL=promptRefiner.js.map