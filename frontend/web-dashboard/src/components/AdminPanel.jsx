import { useState, useEffect } from 'react'
import { userApi, healthApi, adminApi } from '../api/client'
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import TechBadge from './TechBadge'
import Toast from './Toast'
import '../styles/Admin.css'

function formatDate(value) {
  if (!value) return '—'
  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
  const normalized = hasTimezone ? value : `${value}Z`
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

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

// ── DAU Chart ──────────────────────────────────────────────────────────────
function DauChart({ data, selectedDate, onDateClick }) {
  const handleClick = (dataPoint) => {
    onDateClick(dataPoint.date)
  }

  // Custom dot component for highlighting selected date
  const CustomDot = (props) => {
    const { cx, cy, payload } = props
    const isSelected = selectedDate === payload.date
    const radius = isSelected ? 7 : 5
    const fill = isSelected ? '#22c55e' : '#4ade80'

    return (
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill={fill}
        opacity={0.8}
        cursor="pointer"
        onClick={() => onDateClick(payload.date)}
      />
    )
  }

  return (
    <div className="admin-dau-chart-container">
      <h3 className="admin-chart-title">Daily Active Users</h3>
      {data && data.length > 0 ? (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#444" />
            <XAxis 
              dataKey="date" 
              stroke="#999"
              tick={{ fontSize: 12 }}
            />
            <YAxis 
              stroke="#999"
              tick={{ fontSize: 12 }}
            />
            <Tooltip 
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #444',
                borderRadius: '6px',
                color: '#fff'
              }}
              formatter={(value) => [value, 'Active Users']}
            />
            <Legend wrapperStyle={{ color: '#999' }} />
            <Line 
              type="monotone" 
              dataKey="active_users" 
              stroke="#4ade80" 
              strokeWidth={2}
              dot={<CustomDot />}
              activeDot={{ r: 8 }}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="admin-loading" style={{ padding: '2rem', textAlign: 'center' }}>
          No DAU data available
        </p>
      )}
      {selectedDate && (
        <div className="admin-chart-filter-info">
          <p>
            Selected date: <strong>{selectedDate}</strong>
            <button
              className="admin-chart-clear-btn"
              onClick={() => onDateClick(null)}
              title="Clear filter"
            >
              ✕
            </button>
          </p>
        </div>
      )}
    </div>
  )
}

// ── Stack Distribution Chart ───────────────────────────────────────────────────
function StackDistributionChart({ data }) {
  // Process data: top 6 stacks + "Other" for rest
  const COLORS = ['#4ade80', '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#6b7280']
  
  if (!data || data.length === 0) {
    return (
      <div style={{ 
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid rgba(255, 255, 255, 0.07)',
        borderRadius: '12px',
        padding: '1.5rem',
        margin: '1rem 0',
        textAlign: 'center'
      }}>
        <h3 style={{ color: '#e8e8f0', marginBottom: '1rem', fontSize: '1.1rem', fontWeight: 600 }}>
          Stack Distribution
        </h3>
        <p style={{ color: '#999', padding: '2rem' }}>No stack data available</p>
      </div>
    )
  }

  // Take top 6, group rest as "Other"
  const top6 = data.slice(0, 6)
  const rest = data.slice(6)
  const otherCount = rest.reduce((sum, item) => sum + item.count, 0)
  const otherPercentage = rest.reduce((sum, item) => sum + item.percentage, 0)
  
  const chartData = [
    ...top6,
    ...(otherCount > 0 ? [{ stack: 'Other', count: otherCount, percentage: otherPercentage }] : [])
  ]

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload || payload.length === 0) return null
    const data = payload[0].payload
    return (
      <div style={{
        background: '#1a1a1a',
        border: '1px solid #4ade80',
        borderRadius: '6px',
        padding: '0.5rem 1rem',
        color: '#fff'
      }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{data.stack}</p>
        <p style={{ margin: '0.25rem 0', color: '#4ade80', fontSize: '0.9rem' }}>
          {data.count} items · {data.percentage.toFixed(1)}%
        </p>
      </div>
    )
  }

  return (
    <div style={{ 
      background: 'rgba(255, 255, 255, 0.03)',
      border: '1px solid rgba(255, 255, 255, 0.07)',
      borderRadius: '12px',
      padding: '1rem',
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <h3 style={{ color: '#e8e8f0', marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600 }}>
        Stack Distribution
      </h3>
      
      <ResponsiveContainer width="100%" height={250}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="45%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={2}
            dataKey="count"
            label={({ stack, percentage }) => `${stack}`}
          >
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
        </PieChart>
      </ResponsiveContainer>

      <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
        {chartData.map((item, idx) => (
          <div key={item.stack} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.375rem',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '4px',
            fontSize: '0.8rem'
          }}>
            <div style={{
              width: '10px',
              height: '10px',
              borderRadius: '2px',
              background: COLORS[idx % COLORS.length]
            }} />
            <span style={{ color: '#e8e8f0' }}>
              {item.stack}: <strong style={{ color: '#4ade80' }}>{item.count}</strong> ({item.percentage.toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>
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
  const [reason, setReason] = useState('')

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
        
        <div className="delete-modal-reason-section">
          <label className="delete-modal-reason-label">
            Reason for deletion <span className="delete-modal-required">*</span>
          </label>
          <textarea
            className="delete-modal-reason-input"
            placeholder="Enter reason for deleting this user..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows="3"
          />
        </div>

        <div className="delete-modal-actions">
          <button className="delete-modal-btn cancel" onClick={onCancel}>Cancel</button>
          <button 
            className="delete-modal-btn confirm" 
            onClick={() => onConfirm(user.id, reason)}
            disabled={!reason.trim()}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Toggle user status modal ───────────────────────────────────────────────────
function ToggleUserStatusModal({ user, onCancel, onConfirm }) {
  const [reason, setReason] = useState('')
  const isActivating = !user.is_active
  return (
    <div className="delete-modal-overlay" onClick={onCancel}>
      <div className="delete-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className={`delete-modal-icon ${isActivating ? 'activate' : 'deactivate'}`}>
          <svg viewBox="0 0 24 24" fill="currentColor">
            {isActivating ? (
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
            ) : (
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/>
            )}
          </svg>
        </div>
        <h2 className="delete-modal-title">
          {isActivating ? 'Activate user?' : 'Deactivate user?'}
        </h2>
        <p className="delete-modal-message">
          Are you sure you want to <strong>{isActivating ? 'activate' : 'deactivate'}</strong> <strong>{user.name}</strong>?<br/>
          {isActivating ? 'They will be able to access their account.' : 'They will not be able to access their account.'}
        </p>

        {!isActivating && (
          <div className="delete-modal-reason-section">
            <label className="delete-modal-reason-label">
              Reason for deactivation <span className="delete-modal-required">*</span>
            </label>
            <textarea
              className="delete-modal-reason-input"
              placeholder="Enter reason for deactivating this user..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows="3"
            />
          </div>
        )}

        <div className="delete-modal-actions">
          <button className="delete-modal-btn cancel" onClick={onCancel}>Cancel</button>
          <button 
            className={`delete-modal-btn confirm ${isActivating ? 'activate' : 'deactivate'}`} 
            onClick={() => onConfirm(user.id, reason)}
            disabled={!isActivating && !reason.trim()}
          >
            {isActivating ? 'Activate' : 'Deactivate'}
          </button>
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
  const [users, setUsers]         = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [selectedDauDate, setSelectedDauDate] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [userToDelete, setUserToDelete] = useState(null)
  const [userToToggleStatus, setUserToToggleStatus] = useState(null)
  const [emailSearch, setEmailSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [filteredUsers, setFilteredUsers] = useState([])
  const [currentPage, setCurrentPage] = useState(1)

  const USERS_PER_PAGE = 10

  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingStats, setLoadingStats]       = useState(true)
  const [loadingHealth, setLoadingHealth]     = useState(true)
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingAnalytics, setLoadingAnalytics] = useState(true)
  const [toast, setToast]                     = useState({ message: '', type: '' })

  // ── Toast helper ─────────────────────────────────────────────────────────
  const showToast = (message, type = 'success') => {
    setToast({ message, type })
  }

  // ── Fetch projects from API ─────────────────────────────────────────────────────
  const fetchProjects = () => {
    setLoadingProjects(true)
    console.log('[AdminPanel] Fetching projects from API...')
    adminApi.listProjects()
      .then(data => {
        console.log('[AdminPanel] ============ PROJECTS API RESPONSE ============')
        console.log('[AdminPanel] Full response:', JSON.stringify(data, null, 2))
        console.log('[AdminPanel] Response type:', typeof data)
        console.log('[AdminPanel] Response.items type:', Array.isArray(data?.items) ? 'ARRAY' : typeof data?.items)
        
        const projectList = data.items || []
        console.log('[AdminPanel] Total projects to display:', projectList.length)
        if (projectList.length > 0) {
          console.log('[AdminPanel] First project:', projectList[0])
          projectList.forEach((p, idx) => {
            console.log(`  ${idx + 1}. ${p.name} (${p.type}) - Status: ${p.status}, Created: ${p.created_at}`)
          })
        }
        
        setProjects(projectList)
      })
      .catch((err) => {
        console.error('[AdminPanel] ============ PROJECTS API ERROR ============')
        console.error('[AdminPanel] Failed to fetch projects:', {
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message
        })
        showToast('Failed to load projects', 'error')
        setProjects([])
      })
      .finally(() => setLoadingProjects(false))
  }

  // ── Fetch users from API ─────────────────────────────────────────────────────
  const fetchUsers = () => {
    setLoadingUsers(true)
    console.log('[AdminPanel] Fetching users from API with NO filters...')
    adminApi.listUsers()
      .then(data => {
        console.log('[AdminPanel] ============ RAW API RESPONSE ============')
        console.log('[AdminPanel] Full response:', JSON.stringify(data, null, 2))
        console.log('[AdminPanel] Response type:', Array.isArray(data) ? 'ARRAY' : typeof data)
        
        // Handle both array and object with items property
        const userList = Array.isArray(data) ? data : (data?.items || [])
        console.log('[AdminPanel] ============ PARSED USER LIST ============')
        console.log('[AdminPanel] Total users returned:', userList.length)
        
        if (userList.length > 0) {
          console.log('[AdminPanel] First user:', userList[0])
          console.log('[AdminPanel] User fields:')
          Object.keys(userList[0]).forEach(key => {
            console.log(`  - ${key}: ${JSON.stringify(userList[0][key])}`)
          })
          
          // Show breakdown by verification status
          const verified = userList.filter(u => u.is_verified).length
          const unverified = userList.filter(u => !u.is_verified).length
          const active = userList.filter(u => u.is_active).length
          const inactive = userList.filter(u => !u.is_active).length
          
          console.log('[AdminPanel] ============ USER BREAKDOWN ============')
          console.log(`[AdminPanel] Verified: ${verified}, Unverified: ${unverified}`)
          console.log(`[AdminPanel] Active: ${active}, Inactive: ${inactive}`)
          console.log('[AdminPanel] All users:')
          userList.forEach((u, idx) => {
            console.log(`  ${idx + 1}. ${u.name || 'NO NAME'} (${u.email}) - Verified: ${u.is_verified}, Active: ${u.is_active}`)
          })
        }
        
        setUsers(userList)
        setFilteredUsers(userList)
      })
      .catch((err) => {
        console.error('[AdminPanel] ============ API ERROR ============')
        console.error('[AdminPanel] Failed to fetch users:', {
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message
        })
        showToast('Failed to load users', 'error')
        setUsers([])
        setFilteredUsers([])
      })
      .finally(() => setLoadingUsers(false))
  }

  // ── Fetch all data on mount ──────────────────────────────────────────────────
  useEffect(() => {
    // Fetch projects
    fetchProjects()

    // Fetch current user stats
    console.log('[AdminPanel] Fetching user stats from API...')
    userApi.getMyStats()
      .then(data => {
        console.log('[AdminPanel] ============ USER STATS RESPONSE ============')
        console.log('[AdminPanel] Stats:', JSON.stringify(data, null, 2))
        setStats(data)
      })
      .catch((err) => {
        console.error('[AdminPanel] Failed to fetch stats:', err?.message)
        setStats(null)
      })
      .finally(() => setLoadingStats(false))

    healthApi.check()
      .then(data => setHealth(data))
      .catch(() => setHealth(null))
      .finally(() => setLoadingHealth(false))

    // Fetch analytics
    console.log('[AdminPanel] Fetching analytics from API...')
    const today = new Date()
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
    const dateFrom = thirtyDaysAgo.toISOString().split('T')[0]
    const dateTo = today.toISOString().split('T')[0]
    
    adminApi.getAnalytics(dateFrom, dateTo)
      .then(data => {
        console.log('[AdminPanel] ============ ANALYTICS RESPONSE ============')
        console.log('[AdminPanel] Full Analytics:', JSON.stringify(data, null, 2))
        console.log(`[AdminPanel] DAU points: ${data.dau?.length || 0}`)
        setAnalytics(data)
      })
      .catch((err) => {
        console.error('[AdminPanel] Failed to fetch analytics:', {
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message
        })
        setAnalytics(null)
      })
      .finally(() => setLoadingAnalytics(false))

    // Fetch real users
    fetchUsers()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debounced email search ──────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      let filtered = users

      // Filter by email
      const query = emailSearch.toLowerCase().trim()
      if (query) {
        filtered = filtered.filter(u => u.email.toLowerCase().includes(query))
      }

      // Filter by role
      if (roleFilter !== 'all') {
        filtered = filtered.filter(u => u.role === roleFilter)
      }

      // Filter by status
      if (statusFilter !== 'all') {
        const isActive = statusFilter === 'active'
        filtered = filtered.filter(u => u.is_active === isActive)
      }

      setFilteredUsers(filtered)
    }, 300)

    return () => clearTimeout(timer)
  }, [emailSearch, roleFilter, statusFilter, users])

  // ── Reset pagination when filters change ─────────────────────────────────────
  useEffect(() => {
    setCurrentPage(1)
  }, [emailSearch, roleFilter, statusFilter])

  // ── Calculate pagination ─────────────────────────────────────────────────────
  const totalPages = Math.ceil(filteredUsers.length / USERS_PER_PAGE)
  const startIndex = (currentPage - 1) * USERS_PER_PAGE
  const endIndex = startIndex + USERS_PER_PAGE
  const usersOnCurrentPage = filteredUsers.slice(startIndex, endIndex)

  // ── User actions ─────────────────────────────────────────────────────────────

  // Toggle active/inactive (show confirmation modal)
  const handleToggleActive = (user) => {
    setUserToToggleStatus(user)
  }

  // Confirm toggle active/inactive
  const handleToggleStatusConfirm = async (id, reason) => {
    try {
      const user = users.find(u => u.id === id)
      if (!user) {
        showToast('User not found', 'error')
        return
      }
      
      const isActivating = !user.is_active
      const userName = user.name // Store name before state changes
      
      await adminApi.patchUser(id, { 
        is_active: isActivating,
        reason 
      })
      
      // Refresh the list after successful update
      await fetchUsers()
      
      showToast(
        `User ${userName} ${isActivating ? 'activated' : 'deactivated'} successfully`,
        'success'
      )
    } catch (err) {
      console.error('Toggle status error:', err)
      showToast('Failed to update user status', 'error')
    } finally {
      setUserToToggleStatus(null)
    }
  }

  // Delete user
  const handleDeleteConfirm = async (id, reason) => {
    try {
      const user = users.find(u => u.id === id)
      if (!user) {
        showToast('User not found', 'error')
        return
      }
      
      const userName = user.name // Store name before deletion
      
      await adminApi.deleteUser(id, reason)
      await fetchUsers()
      
      showToast(`User ${userName} deleted successfully`, 'success')
    } catch (err) {
      console.error('Delete user error:', err)
      showToast('Failed to delete user', 'error')
    } finally {
      setUserToDelete(null)
    }
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
        {['overview', 'projects', 'users'].map(tab => (
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
              <>
                <div className="admin-stats-grid">
                  <StatCard
                    label="Total Projects"
                    value={projects.length}
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
                    label="Avg Projects / User"
                    value={users.length > 0 ? (users.reduce((sum, u) => sum + u.install_count, 0) / users.length).toFixed(1) : 0}
                    accent="#fbbf24"
                    icon={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>}
                  />
                  <StatCard
                    label="System Status"
                    value={loadingHealth ? 'Checking...' : health ? 'Healthy' : 'Down'}
                    accent={health ? '#4ade80' : '#f87171'}
                    icon={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>}
                  />
                </div>

                {/* Health Section */}
                <div style={{ marginTop: '2rem' }}>
                  <h3 className="admin-section-title" style={{ marginBottom: '1rem' }}>System Health</h3>
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

                {/* DAU Chart Section */}
                <div style={{ marginTop: '2rem' }}>
                  <h3 className="admin-section-title" style={{ marginBottom: '1rem' }}>Last 30 Days Analytics</h3>
                  {loadingAnalytics ? (
                    <p className="admin-loading">Loading analytics...</p>
                  ) : !analytics ? (
                    <p className="admin-loading" style={{ color: '#ef4444' }}>Failed to load analytics data</p>
                  ) : (
                    <div style={{ display: 'flex', gap: '1.5rem' }}>
                      {/* DAU Chart - 75% */}
                      <div style={{ flex: '0 0 75%' }}>
                        {analytics?.dau && analytics.dau.length > 0 ? (
                          <DauChart 
                            data={analytics.dau} 
                            selectedDate={selectedDauDate}
                            onDateClick={(date) => {
                              console.log('[AdminPanel] DAU date clicked:', date)
                              setSelectedDauDate(date)
                            }}
                          />
                        ) : (
                          <p className="admin-loading">No DAU data available (dau: {analytics?.dau ? `${analytics.dau.length} items` : 'undefined'})</p>
                        )}
                      </div>

                      {/* Stack Distribution Chart - 25% */}
                      <div style={{ flex: '0 0 25%' }}>
                        {analytics?.stack_distribution && analytics.stack_distribution.length > 0 ? (
                          <StackDistributionChart data={analytics.stack_distribution} />
                        ) : (
                          <p className="admin-loading">No stack distribution data available</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* PROJECTS TAB */}
        {activeTab === 'projects' && (
          <div className="admin-section">
            <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 className="admin-section-title">All Projects</h2>
              </div>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <span className="admin-count">{projects.length} total</span>
                <button
                  className="admin-refresh-btn"
                  onClick={() => {
                    console.log('[AdminPanel] Manual refresh triggered for projects')
                    fetchProjects()
                  }}
                  title="Refresh projects list"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                  </svg>
                  Refresh
                </button>
              </div>
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
                      {formatDate(p.created_at)}
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
            <div className="admin-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <h2 className="admin-section-title">All Users ({users.length} total, {filteredUsers.length} shown)</h2>
              </div>
              <div className="admin-filters-row">
                <input
                  type="text"
                  placeholder="🔍︎ Search by email..."
                  className="admin-search-input"
                  value={emailSearch}
                  onChange={(e) => setEmailSearch(e.target.value)}
                />
                <select
                  className="admin-filter-select"
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                >
                  <option value="all">All Roles</option>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                <select
                  className="admin-filter-select"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div className="admin-header-info">
                <button
                  className="admin-refresh-btn"
                  onClick={() => {
                    console.log('[AdminPanel] Manual refresh triggered')
                    fetchUsers()
                  }}
                  title="Refresh user list"
                  style={{ marginRight: '20px' }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                  </svg>
                  Refresh
                </button>
                {filteredUsers.length > 0 && totalPages > 1 && (
                  <div className="admin-pagination-controls">
                    <button
                      className="admin-pagination-btn-small"
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                      title="Previous page"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                      </svg>
                    </button>
                    <span className="admin-pagination-header">Page {currentPage} of {totalPages}</span>
                    <button
                      className="admin-pagination-btn-small"
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      title="Next page"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
            
            {/* Loading state */}
            {loadingUsers ? (
              <p className="admin-loading">Loading users...</p>
            ) : (
              <div className="admin-projects-table">
                <div className="admin-table-header admin-users-header">
                  <span>User</span>
                  <span>Role</span>
                  <span>Status</span>
                  <span>Verified</span>
                  <span>Joined</span>
                  <span>Last Login</span>
                  <span>Install Count</span>
                  <span>Actions</span>
                </div>
                {usersOnCurrentPage.map((u) => (
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

                    {/* Verified badge */}
                    <span className={`admin-status-badge ${u.is_verified ? 'verified' : 'unverified'}`}>
                      {u.is_verified ? 'Verified' : 'Unverified'}
                    </span>

                    {/* Join date */}
                    <span className="admin-table-date">
                      {formatDate(u.created_at)}
                    </span>

                    {/* Last login */}
                    <span className="admin-table-date">
                      {u.last_login ? formatDate(u.last_login) : 'Never'}
                    </span>

                    {/* Install count */}
                    <span className="admin-table-count">
                      {u.install_count}
                    </span>

                    {/* Action buttons */}
                    <div className="admin-user-actions">
                      {/* Toggle active */}
                      <button
                        className={`admin-action-btn ${u.is_active ? 'deactivate' : 'activate'}`}
                        title={u.is_active ? 'Deactivate' : 'Activate'}
                        onClick={() => handleToggleActive(u)}
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
            )}
          </div>
        )}

        {/* HEALTH TAB */}
        {activeTab === 'health' && (
          <div className="admin-section">
            <h2 className="admin-section-title">System Health</h2>
            <p className="admin-loading">Health information has been moved to the Overview tab</p>
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

      {/* ── Toggle user status modal ── */}
      {userToToggleStatus && (
        <ToggleUserStatusModal
          user={userToToggleStatus}
          onCancel={() => setUserToToggleStatus(null)}
          onConfirm={handleToggleStatusConfirm}
        />
      )}

      {/* ── Toast notification ── */}
      <Toast
        message={toast.message}
        type={toast.type}
        onClose={() => setToast({ message: '', type: '' })}
      />

    </div>
  )
}

export default AdminPanel