import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
        credentials: 'include',  // Pass cookies and auth headers
      },
      '/auth': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
        credentials: 'include',  // Pass cookies and auth headers
      },
      '/admin/users': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
        credentials: 'include',  // Pass cookies and auth headers
      },
      '/admin/projects': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
        credentials: 'include',  // Pass cookies and auth headers
      },
      '/admin/analytics': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
        credentials: 'include',  // Pass cookies and auth headers
      },
      '/admin/audit-logs': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000,
        credentials: 'include',  // Pass cookies and auth headers
      },
    },
  },
});