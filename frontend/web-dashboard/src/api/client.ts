import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
});

export const projectsApi = {
  create: (data: { source: { type: string; url?: string; path?: string } }) =>
    api.post('/api/projects', data).then(r => r.data),

  get: (id: string) =>
    api.get(`/api/projects/${id}`).then(r => r.data),
};