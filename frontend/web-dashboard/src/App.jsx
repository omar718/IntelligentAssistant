import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import CodeStart from './components/CodeStart'
import Processing from './components/Processing'
import ProjectsList from './components/ProjectsList'
import AdminPanel from './components/AdminPanel'
import VSCodeModal from './components/VSCodeModal'
import ResetPassword from './components/ResetPassword'
import { authApi } from './api/client'

// ── Protected route — only allows users with role ADMIN ───────────────────────
function AdminRoute({ user, children }) {
  if (!user) {
    return <Navigate to="/" replace />
  }
  if (user.role?.toLowerCase() !== 'admin') {
    return <Navigate to="/" replace />
  }
  return children
}

// ── Main website pages ────────────────────────────────────────────────────────
function MainApp({ user, onLogin, onLogout }) {
  const [currentPage, setCurrentPage] = useState('home')
  const [gitUrl, setGitUrl] = useState('')
  const [cloneDir, setCloneDir] = useState('')
  const [showVSCodeModal, setShowVSCodeModal] = useState(false)

  const handleAnalyze = (url, dir) => {
    console.log('[App] handleAnalyze called with:', { url, dir })
    setGitUrl(url)
    setCloneDir(dir || '')
    console.log('[App] State updated, navigating to processing page')
    setCurrentPage('processing')
  }

  const handleBack = () => {
    setCurrentPage('home')
    setGitUrl('')
    setCloneDir('')
  }

  return (
    <>
      {currentPage === 'home' && (
        <CodeStart
          onAnalyze={handleAnalyze}
          onNavigate={setCurrentPage}
          user={user}
          onLogin={onLogin}
          onLogout={onLogout}
        />
      )}
      {currentPage === 'processing' && (
        <Processing
          gitUrl={gitUrl}
          cloneDir={cloneDir}
          onBack={handleBack}
          onVSCodeNotFound={() => setShowVSCodeModal(true)}
        />
      )}
      {currentPage === 'projects' && (
        <ProjectsList onBack={() => setCurrentPage('home')} />
      )}

      {showVSCodeModal && (
        <VSCodeModal onClose={() => setShowVSCodeModal(false)} />
      )}
    </>
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────
function App() {
  // Load user from localStorage so it survives page refreshes and URL navigation
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('user')
    return saved ? JSON.parse(saved) : null
  })

  useEffect(() => {
    let cancelled = false

    const refreshOnLoad = async () => {
      try {
        const data = await authApi.refresh()
        if (cancelled) return

        if (data?.user) {
          localStorage.setItem('user', JSON.stringify(data.user))
          setUser(data.user)
        }
      } catch {
        if (cancelled) return
        localStorage.removeItem('user')
        setUser(null)
      }
    }

    void refreshOnLoad()

    return () => {
      cancelled = true
    }
  }, [])

  // Save user to localStorage when logging in
  const handleLogin = (profile) => {
    localStorage.setItem('user', JSON.stringify(profile))
    setUser(profile)
  }

  // Remove user from localStorage when logging out
  const handleLogout = () => {
    localStorage.removeItem('user')
    setUser(null)
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Password reset page — accessible without authentication */}
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Main website */}
        <Route
          path="/*"
          element={
            <MainApp
              user={user}
              onLogin={handleLogin}
              onLogout={handleLogout}
            />
          }
        />

        {/* Admin panel — protected, only accessible to ADMIN role */}
        <Route
          path="/admin"
          element={
            <AdminRoute user={user}>
              <AdminPanel onBack={() => window.history.back()} />
            </AdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App