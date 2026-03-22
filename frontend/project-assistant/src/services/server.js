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
exports.registerOpenFolderCallback = registerOpenFolderCallback;
exports.registerPickFolderCallback = registerPickFolderCallback;
exports.isServerRunning = isServerRunning;
exports.startServer = startServer;
exports.stopServer = stopServer;
const http = __importStar(require("http"));
const llmService_1 = require("./llmService");
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
//# sourceMappingURL=server.js.map