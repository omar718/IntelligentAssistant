import axios from 'axios';

// In dev, Vite proxies /api → http://localhost:8000, so use a relative base.
// In production, set VITE_API_URL to the deployed backend URL.
const api = axios.create({
  baseURL: (import.meta as any).env.VITE_API_URL || '',
});

export const projectsApi = {
  create: (data: { source: { type: string; url?: string; path?: string; clone_dir?: string } }) =>
    api.post('/api/projects', data).then(r => r.data),

  get: (id: string) =>
    api.get(`/api/projects/${id}`).then(r => r.data),
};