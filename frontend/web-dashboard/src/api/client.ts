import axios from 'axios';

// In dev, Vite proxies /api and /auth → http://localhost:8000
// In production, set VITE_API_URL to your deployed backend URL.
const api = axios.create({
  baseURL: (import.meta as any).env.VITE_API_URL || '',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

let refreshTokenPromise: Promise<string> | null = null
let refreshSessionPromise: Promise<any> | null = null

function refreshSession() {
  if (!refreshSessionPromise) {
    refreshSessionPromise = api.post('/auth/refresh').then(r => {
      if (r.data.access_token) setToken(r.data.access_token);
      return r.data;
    }).finally(() => {
      refreshSessionPromise = null
    })
  }
  return refreshSessionPromise
}

// ── Token helpers ──────────────────────────────────────────────────────────────
// After login, we store the JWT token in localStorage so it persists on refresh.

function getToken(): string | null {
  return localStorage.getItem('access_token');
}

function setToken(token: string): void {
  localStorage.setItem('access_token', token);
}

function clearToken(): void {
  localStorage.removeItem('access_token');
}

// ── Request interceptor ────────────────────────────────────────────────────────
// Automatically attach the JWT token to every request if it exists.
// This means you don't have to manually add the token in every API call.

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Auth API ───────────────────────────────────────────────────────────────────

export const authApi = {
  // Create a new account
  register: (data: { name: string; email: string; password: string; confirm_password: string }) =>
    api.post('/auth/register', data).then(r => r.data),

  // Log in — saves the token automatically
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data).then(r => {
      if (r.data.access_token) setToken(r.data.access_token);
      return r.data;
    }),

  // Log out — removes the token
  logout: () =>
    api.post('/auth/logout').then(r => {
      clearToken();
      return r.data;
    }),

  // Refresh the token (call this when the token expires)
  refresh: () => refreshSession(),

  // Verify email after registration
  verifyEmail: (token: string) =>
    api.get(`/auth/verify/${token}`).then(r => r.data),

  // Send forgot password email
  forgotPassword: (email: string) =>
    api.post('/auth/forgot-password', { email }).then(r => r.data),

  // Reset password using the token from the email
  resetPassword: (data: { token: string; password: string; confirm_password: string }) =>
    api.post('/auth/reset-password', data).then(r => r.data),
};

// ── Projects API ───────────────────────────────────────────────────────────────

export const projectsApi = {
  // Launch a new project from a GitHub URL
  create: (data: { source: { type: string; url?: string; path?: string; clone_dir?: string }; task_id?: string }) =>
    api.post('/api/projects', data).then(r => r.data),
  

  // Get a single project by ID
  get: (id: string) =>
    api.get(`/api/projects/${id}`).then(r => r.data),

  // Get live status for a project creation task
  getTaskStatus: (taskId: string) =>
    api.get(`/api/projects/tasks/${taskId}`).then(r => r.data),

  // Request cancellation for a running project creation task
  cancelTask: (taskId: string) =>
    api.post(`/api/projects/tasks/${taskId}/cancel`).then(r => r.data),
};

// ── User API ───────────────────────────────────────────────────────────────────

export const userApi = {
  // Get the currently logged-in user's profile
  getMe: () =>
    api.get('/api/users/me').then(r => r.data),

  // Get the list of projects for the logged-in user
  getMyProjects: () =>
    api.get('/api/users/me/projects').then(r => r.data),

  // Get the stats for the logged-in user
  getMyStats: () =>
    api.get('/api/users/me/stats').then(r => r.data),
};

// ── Health check ───────────────────────────────────────────────────────────────

export const healthApi = {
  check: () =>
    api.get('/health').then(r => r.data),
};

// ── Admin API ───────────────────────────────────────────────────────────────────

export const adminApi = {
  // ── Analytics ───────────────────────────────────────────────────────────────
  
  // Get Analytics
  getAnalytics: (dateFrom?: string, dateTo?: string) =>
    api.get('/admin/analytics', { params: { date_from: dateFrom, date_to: dateTo } }).then(r => r.data),
  
  // Export Analytics
  exportAnalytics: () =>
    api.get('/admin/analytics/export', { responseType: 'blob' }).then(r => r.data),

  // ── Audit Logs ─────────────────────────────────────────────────────────────
  
  // List all audit logs
  listAuditLogs: (params?: { limit?: number; offset?: number; user_id?: string }) =>
    api.get('/admin/audit-logs', { params }).then(r => r.data),

  // ── User Management ────────────────────────────────────────────────────────
  
  // List all users (replaces MOCK_USERS)
  listUsers: (params?: { 
    email?: string; 
    role?: 'user' | 'admin' | 'all'; 
    is_active?: boolean; 
    limit?: number; 
    offset?: number 
  }) =>
    api.get('/admin/users', { params }).then(r => r.data),

  // Get single user by ID
  getUser: (userId: string) =>
    api.get(`/admin/users/${userId}`).then(r => r.data),

  // Patch/Update user (activate/deactivate, change role, etc.)
  patchUser: (userId: string, data: { 
    is_active?: boolean; 
    role?: string; 
    name?: string;
    reason?: string;
  }) =>
    api.patch(`/admin/users/${userId}`, data).then(r => r.data),

  // Get audit logs for specific user
  getUserAuditLogs: (userId: string, params?: { limit?: number; offset?: number }) =>
    api.get(`/admin/users/${userId}/audit-logs`, { params }).then(r => r.data),

  // Delete user
  deleteUser: (userId: string, reason: string) =>
    api.request({
      method: 'delete',
      url: `/admin/users/${userId}`,
      data: { reason }
    }).then(r => r.data),

  // List all projects
  listProjects: () =>
    api.get('/admin/projects').then(r => r.data),
};

// Response interceptor
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config || {};
    const requestUrl = String(originalRequest.url || '')

    // If the error is 401 and it's NOT a login/refresh attempt
    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !requestUrl.includes('/auth/')
    ) {
      originalRequest._retry = true;

      try {
        console.log('[API] 401 detected on', requestUrl, '- attempting refresh')
        
        if (!refreshTokenPromise) {
          refreshTokenPromise = authApi
            .refresh()
            .then((data) => {
              console.log('[API] Token refreshed successfully')
              return data.access_token as string
            })
            .catch((refreshErr) => {
              console.error('[API] Refresh failed:', {
                status: refreshErr?.response?.status,
                detail: refreshErr?.response?.data?.detail,
                message: refreshErr?.message
              })
              // Clear auth state on refresh failure
              clearToken();
              localStorage.removeItem('user');
              throw refreshErr
            })
            .finally(() => {
              refreshTokenPromise = null
            })
        }

        const newAccessToken = await refreshTokenPromise
        originalRequest.headers = originalRequest.headers || {}
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`
        console.log('[API] Retrying original request to', requestUrl)

        return api(originalRequest);
      } catch (refreshErr) {
        const message = (refreshErr as any)?.message || (refreshErr as any)?.response?.data?.detail || 'Unknown refresh error'
        console.error('[API] Token refresh failed completely, logging out', message);
        clearToken();
        localStorage.removeItem('user');
        if (window.location.pathname !== '/') {
          window.location.href = '/';
        }
        return Promise.reject(refreshErr);
      }
    }
    return Promise.reject(error);
  }
);