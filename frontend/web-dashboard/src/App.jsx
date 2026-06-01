import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './App.css'
import CodeStart from './components/CodeStart'
import Processing from './components/Processing'
import ProjectsList from './components/ProjectsList'
import AdminPanel from './components/AdminPanel'
import SettingsPage from './components/SettingsPage'
import VSCodeModal from './components/VSCodeModal'
import ResetPassword from './components/ResetPassword'
import VerifyEmailResult from './components/VerifyEmail/VerifyEmailResult'
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
function MainApp({ user, onLogin, onLogout, onUserUpdate, theme, onToggleTheme }) {
  const [currentPage, setCurrentPage] = useState('home')
  const [gitUrl, setGitUrl] = useState('')
  const [cloneDir, setCloneDir] = useState('')
  const [showVSCodeModal, setShowVSCodeModal] = useState(false)
  const [projectError, setProjectError] = useState(null)
  const [successPopup, setSuccessPopup] = useState(null)

  const handleAnalyze = (url, dir) => {
    console.log('[App] handleAnalyze called with:', { url, dir })
    setGitUrl(url)
    setCloneDir(dir || '')
    setProjectError(null) // Clear any previous error
    console.log('[App] State updated, navigating to processing page')
    setCurrentPage('processing')
  }

  const handleBack = () => {
    setCurrentPage('home')
    setGitUrl('')
    setCloneDir('')
    setProjectError(null)
  }

  const handleProcessingSuccess = ({ title, message } = {}) => {
    setSuccessPopup({
      title: title || 'Project ready',
      message: message || 'Your project has been cloned and processed successfully.',
    })
    setCurrentPage('home')
    setProjectError(null)
  }

  const closeSuccessPopup = () => {
    setSuccessPopup(null)
  }

  const handleProcessingError = (error) => {
    console.log('[App] Repo-not-found error, returning to home with error:', error)
    setProjectError(error)
    setCurrentPage('home')
  }

  return (
    <div className="app-shell">
      <>
      {currentPage === 'home' && (
        <CodeStart
          onAnalyze={handleAnalyze}
          onNavigate={setCurrentPage}
          user={user}
          onLogin={onLogin}
          onLogout={onLogout}
          theme={theme}
          onToggleTheme={onToggleTheme}
          projectError={projectError}
          onClearProjectError={() => setProjectError(null)}
        />
      )}
      {currentPage === 'processing' && (
        <Processing
          gitUrl={gitUrl}
          cloneDir={cloneDir}
          onBack={handleBack}
          onSuccess={handleProcessingSuccess}
          onVSCodeNotFound={() => setShowVSCodeModal(true)}
          onError={handleProcessingError}
        />
      )}
      {currentPage === 'projects' && (
        <ProjectsList onBack={() => setCurrentPage('home')} />
      )}

      {currentPage === 'settings' && (
        <SettingsPage
          user={user}
          onBack={() => setCurrentPage('home')}
          onUserUpdate={onUserUpdate}
        />
      )}

      {showVSCodeModal && (
        <VSCodeModal onClose={() => setShowVSCodeModal(false)} />
      )}

      {successPopup && (
        <div className="app-success-popup-overlay" role="dialog" aria-modal="true" aria-labelledby="project-ready-title">
          <div className="app-success-popup-card">
            <button className="app-success-popup-close" onClick={closeSuccessPopup} aria-label="Close success message">
              &times;
            </button>
            <h2 className="app-success-popup-title" id="project-ready-title">{successPopup.title}</h2>
            <p className="app-success-popup-message">{successPopup.message}</p>
          </div>
        </div>
      )}
      </>
    </div>
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────
function App() {
  // Load user from localStorage so it survives page refreshes and URL navigation
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('user')
    return saved ? JSON.parse(saved) : null
  })
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

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

  const toggleTheme = () => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Password reset page — accessible without authentication */}
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmailResult />} />

        {/* Main website */}
        <Route
          path="/*"
          element={
            <MainApp
              user={user}
              onLogin={handleLogin}
              onLogout={handleLogout}
              onUserUpdate={handleLogin}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />

        {/* Admin panel — protected, only accessible to ADMIN role */}
        <Route
          path="/admin"
          element={
            <AdminRoute user={user}>
              <AdminPanel
                onBack={() => window.history.back()}
                theme={theme}
                onToggleTheme={toggleTheme}
              />
            </AdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App