import * as http from 'http';
import { sendChatRequest } from './llmService';

let server: http.Server | null = null;
let _openFolderCallback: ((folderPath: string, projectId?: string) => void) | null = null;
let _pickFolderCallback: (() => Promise<string | null>) | null = null;

export function registerOpenFolderCallback(cb: (folderPath: string, projectId?: string) => void) {
  _openFolderCallback = cb;
}

export function registerPickFolderCallback(cb: () => Promise<string | null>) {
  _pickFolderCallback = cb;
}

export function isServerRunning(): boolean {
  return server !== null && server !== undefined;
}

export function startServer(port: number = 6009, modelId?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      if (server.listening) {
        reject(new Error('Server is already running'));
        return;
      } else {
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
          } else {
            // User cancelled the dialog
            res.writeHead(204);
            res.end();
          }
        } catch (error) {
          const err = error as Error;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      } else if (req.method === 'POST' && req.url === '/open-folder') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const folderPath: string = data.path;
            const projectId: string | undefined = data.project_id;
            if (!folderPath) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing "path" in request body.' }));
              return;
            }
            if (_openFolderCallback) {
              _openFolderCallback(folderPath, projectId);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'open-folder handler not registered' }));
            }
          } catch (error) {
            const err = error as Error;
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      } else if (req.method === 'POST' && req.url === '/Mobelite/chat') {
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
            const responseText = await sendChatRequest(history, requestModelId, systemPrompt);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: responseText }));
          } catch (error) {
            const err = error as Error;
            console.error('Server error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    });

    server.listen(port, () => {
      console.log(`Project Assistant server is running on http://localhost:${port}`);
      resolve(port);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        server = null;
        reject(new Error(`Port ${port} is already in use. Choose a different port.`));
      } else {
        server = null;
        reject(err);
      }
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err) => {
        if (err) {
          console.error('Error stopping server:', err);
          server = null;
          reject(err);
        } else {
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
    } else {
      resolve();
    }
  });
}
