import { useState, useEffect } from 'react'
import { userApi, healthApi } from '../api/client'
import TechBadge from './TechBadge'
import '../styles/Admin.css'

// ── Mock users — replace with real API once backend adds the endpoints ─────────
const MOCK_USERS = [
  { id: 'user_1', name: 'Aziz Hadj', email: 'hadjhassenmohamedaziz8@gmail.com', role: 'admin',  is_active: true,  created_at: '2026-03-16T00:59:36Z' },
  { id: 'user_2', name: 'John Doe',  email: 'john@example.com',                  role: 'user',   is_active: true,  created_at: '2026-03-10T10:00:00Z' },
  { id: 'user_3', name: 'Jane Smith',email: 'jane@example.com',                  role: 'user',   is_active: false, created_at: '2026-03-08T08:30:00Z' },
  { id: 'user_4', name: 'Test User', email: 'user@example.com',                  role: 'user',   is_active: true,  created_at: '2026-03-01T12:00:00Z' },
]

// ── Logo ───────────────────────────────────────────────────────────────────────
function Logo() {
  return (
    <div className="logo">
      <svg className="logo-icon-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="48" fill="none" stroke="#fff" strokeWidth="2"/>
        <rect x="25" y="20" width="50" height="35" rx="2" fill="none" stroke="#fff" strokeWidth="2"/>
        <rect x="28" y="23" width="44" height="29" fill="none" stroke="#fff" strokeWidth="1.5"/>
        <circle cx="33" cy="28" r="2.5" fill="#fff"/>
        <circle cx="33" cy="33" r="2.5" fill="#fff"/>
        <circle cx="33" cy="38" r="2.5" fill="#fff"/>
        <line x1="36" y1="28" x2="44" y2="28" stroke="#fff" strokeWidth="1.5"/>
        <line x1="36" y1="33" x2="44" y2="33" stroke="#fff" strokeWidth="1.5"/>
        <line x1="36" y1="38" x2="44" y2="38" stroke="#fff" strokeWidth="1.5"/>
        <rect x="46" y="35" width="3" height="10" fill="#fff"/>
        <rect x="51" y="31" width="3" height="14" fill="#fff"/>
        <rect x="56" y="27" width="3" height="18" fill="#fff"/>
        <rect x="61" y="24" width="3" height="21" fill="#fff"/>
        <path d="M20 58C20 58 20 60 22 60H78C80 60 80 58 80 58M28 60H72C72 63 70 65 67 65H33C30 65 28 63 28 60" fill="none" stroke="#fff" strokeWidth="2"/>
      </svg>
    </div>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, accent }) {
  return (
    <div className="admin-stat-card" style={{ '--accent': accent }}>
      <div className="admin-stat-icon">{icon}</div>
      <div className="admin-stat-value">{value ?? '—'}</div>
      <div className="admin-stat-label">{label}</div>
    </div>
  )
}

// ── Health indicator ───────────────────────────────────────────────────────────
function HealthStatus({ health, loading }) {
  if (loading) return <div className="admin-health-badge loading">Checking...</div>
  if (!health)  return <div className="admin-health-badge offline">Offline</div>
  return <div className="admin-health-badge online">Online</div>
}

// ── Delete confirm modal ───────────────────────────────────────────────────────
function DeleteUserModal({ user, onCancel, onConfirm }) {
  return (
    <div className="delete-modal-overlay" onClick={onCancel}>
      <div className="delete-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="delete-modal-icon">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </div>
        <h2 className="delete-modal-title">Delete user?</h2>
        <p className="delete-modal-message">
          Are you sure you want to delete <strong>{user.name}</strong>?<br/>
          This action cannot be undone.
        </p>
        <div className="delete-modal-actions">
          <button className="delete-modal-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="delete-modal-btn confirm" onClick={() => onConfirm(user.id)}>Delete</button>
        </div>
      </div>
    </div>
  )
}

// ── Main Admin Panel ───────────────────────────────────────────────────────────
function AdminPanel({ onBack }) {
  const [projects, setProjects]   = useState([])
  const [stats, setStats]         = useState(null)
  const [health, setHealth]       = useState(null)
  const [users, setUsers]         = useState(MOCK_USERS)
  const [activeTab, setActiveTab] = useState('overview')
  const [userToDelete, setUserToDelete] = useState(null)

  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingStats, setLoadingStats]       = useState(true)
  const [loadingHealth, setLoadingHealth]     = useState(true)

  // ── Fetch all data on mount ──────────────────────────────────────────────────
  useEffect(() => {
    userApi.getMyProjects()
      .then(data => setProjects(data.items || []))
      .catch(() => setProjects([]))
      .finally(() => setLoadingProjects(false))

    userApi.getMyStats()
      .then(data => setStats(data))
      .catch(() => setStats(null))
      .finally(() => setLoadingStats(false))

    healthApi.check()
      .then(data => setHealth(data))
      .catch(() => setHealth(null))
      .finally(() => setLoadingHealth(false))
  }, [])

  // ── User actions ─────────────────────────────────────────────────────────────

  // Toggle active/inactive
  const handleToggleActive = (id) => {
    // TODO: call API once backend adds PATCH /api/admin/users/{id}
    setUsers(prev => prev.map(u => u.id === id ? { ...u, is_active: !u.is_active } : u))
  }

  // Toggle role between admin and user
  const handleToggleRole = (id) => {
    // TODO: call API once backend adds PATCH /api/admin/users/{id}
    setUsers(prev => prev.map(u =>
      u.id === id ? { ...u, role: u.role === 'admin' ? 'user' : 'admin' } : u
    ))
  }

  // Delete user
  const handleDeleteConfirm = (id) => {
    // TODO: call API once backend adds DELETE /api/admin/users/{id}
    setUsers(prev => prev.filter(u => u.id !== id))
    setUserToDelete(null)
  }

  return (
    <div className="admin-container">

      {/* ── Header ── */}
      <header className="admin-header">
        <button className="admin-back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
          Back
        </button>
        <Logo />
        <div className="admin-header-right">
          <span className="admin-badge">Admin</span>
          <HealthStatus health={health} loading={loadingHealth} />
        </div>
      </header>

      {/* ── Page title ── */}
      <div className="admin-title-row">
        <h1 className="admin-title">Admin Panel</h1>
        <p className="admin-subtitle">Monitor projects, users, stats and system health</p>
      </div>

      {/* ── Tabs ── */}
      <div className="admin-tabs">
        {['overview', 'projects', 'users', 'health'].map(tab => (
          <button
            key={tab}
            className={`admin-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <main className="admin-main">

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="admin-section">
            <h2 className="admin-section-title">Overview</h2>
            {loadingStats ? (
              <p className="admin-loading">Loading stats...</p>
            ) : (
              <div className="admin-stats-grid">
                <StatCard
                  label="Total Projects"
                  value={stats?.total_projects ?? projects.length}
                  accent="#4ade80"
                  icon={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h8v8H3zm0 10h8v8H3zM13 3h8v8h-8zm0 10h8v8h-8z"/></svg>}
                />
                <StatCard
                  label="Total Users"
                  value={users.length}
                  accent="#60a5fa"
                  icon={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>}
                />
                <StatCard
                  label="Active Users"
                  value={users.filter(u => u.is_active).length}
                  accent="#f472b6"
                  icon={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>}
                />
                <StatCard
                  label="System Status"
                  value={loadingHealth ? 'Checking...' : health ? 'Healthy' : 'Down'}
                  accent={health ? '#4ade80' : '#f87171'}
                  icon={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>}
                />
              </div>
            )}
          </div>
        )}

        {/* PROJECTS TAB */}
        {activeTab === 'projects' && (
          <div className="admin-section">
            <div className="admin-section-header">
              <h2 className="admin-section-title">All Projects</h2>
              <span className="admin-count">{projects.length} total</span>
            </div>
            {loadingProjects ? (
              <p className="admin-loading">Loading projects...</p>
            ) : projects.length === 0 ? (
              <div className="admin-empty">
                <svg viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                  <rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                  <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                  <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
                <p>No projects found</p>
              </div>
            ) : (
              <div className="admin-projects-table">
                <div className="admin-table-header">
                  <span>Project</span>
                  <span>Runtime</span>
                  <span>Status</span>
                  <span>Date</span>
                </div>
                {projects.map((p, i) => (
                  <div className="admin-table-row" key={p.id || i}>
                    <span className="admin-table-name">
                      <svg viewBox="0 0 24 24" fill="currentColor" className="admin-gh-icon">
                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.79-.26.79-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.19.7.8.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/>
                      </svg>
                      {p.name || '—'}
                    </span>
                    <span><TechBadge name={p.type} /></span>
                    <span>{p.status || '—'}</span>
                    <span className="admin-table-date">
                      {p.created_at ? new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* USERS TAB */}
        {activeTab === 'users' && (
          <div className="admin-section">
            <div className="admin-section-header">
              <h2 className="admin-section-title">All Users</h2>
              <span className="admin-count">{users.length} total</span>
            </div>
            <div className="admin-projects-table">
              <div className="admin-table-header admin-users-header">
                <span>User</span>
                <span>Role</span>
                <span>Status</span>
                <span>Joined</span>
                <span>Actions</span>
              </div>
              {users.map((u) => (
                <div className="admin-table-row admin-users-row" key={u.id}>
                  {/* Name + email */}
                  <div className="admin-user-info">
                    <div className="admin-user-avatar">
                      {u.name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <div>
                      <div className="admin-user-name">{u.name}</div>
                      <div className="admin-user-email">{u.email}</div>
                    </div>
                  </div>

                  {/* Role badge */}
                  <span className={`admin-role-badge ${u.role === 'admin' ? 'admin-role-badge--admin' : ''}`}>
                    {u.role}
                  </span>

                  {/* Active/inactive badge */}
                  <span className={`admin-status-badge ${u.is_active ? 'active' : 'inactive'}`}>
                    {u.is_active ? 'Active' : 'Inactive'}
                  </span>

                  {/* Join date */}
                  <span className="admin-table-date">
                    {new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>

                  {/* Action buttons */}
                  <div className="admin-user-actions">
                    {/* Toggle active */}
                    <button
                      className={`admin-action-btn ${u.is_active ? 'deactivate' : 'activate'}`}
                      title={u.is_active ? 'Deactivate' : 'Activate'}
                      onClick={() => handleToggleActive(u.id)}
                    >
                      {u.is_active ? (
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
                        </svg>
                      )}
                    </button>

                    {/* Toggle role */}
                    <button
                      className="admin-action-btn role"
                      title={u.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
                      onClick={() => handleToggleRole(u.id)}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
                      </svg>
                    </button>

                    {/* Delete */}
                    <button
                      className="admin-action-btn delete"
                      title="Delete user"
                      onClick={() => setUserToDelete(u)}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* HEALTH TAB */}
        {activeTab === 'health' && (
          <div className="admin-section">
            <h2 className="admin-section-title">System Health</h2>
            {loadingHealth ? (
              <p className="admin-loading">Checking system health...</p>
            ) : (
              <div className="admin-health-panel">
                <div className={`admin-health-status-card ${health ? 'online' : 'offline'}`}>
                  <div className="admin-health-status-icon">
                    {health ? (
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                      </svg>
                    )}
                  </div>
                  <div>
                    <div className="admin-health-status-title">
                      {health ? 'All Systems Operational' : 'Backend Unreachable'}
                    </div>
                    <div className="admin-health-status-sub">
                      {health ? 'Backend is running normally' : 'Could not connect to the backend server'}
                    </div>
                  </div>
                </div>

                {health && typeof health === 'object' && (
                  <div className="admin-health-details">
                    {Object.entries(health).map(([key, val]) => (
                      <div className="admin-health-row" key={key}>
                        <span className="admin-health-key">{key}</span>
                        <span className="admin-health-val">{String(val)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  className="admin-refresh-btn"
                  onClick={() => {
                    setLoadingHealth(true)
                    healthApi.check()
                      .then(data => setHealth(data))
                      .catch(() => setHealth(null))
                      .finally(() => setLoadingHealth(false))
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                  </svg>
                  Refresh
                </button>
              </div>
            )}
          </div>
        )}

      </main>

      {/* ── Delete user modal ── */}
      {userToDelete && (
        <DeleteUserModal
          user={userToDelete}
          onCancel={() => setUserToDelete(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}

    </div>
  )
}

export default AdminPanel