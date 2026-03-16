import { useState, useRef, useEffect } from 'react'
import '../styles/CodeStart.css'
import LoginOverlay from './LoginOverlay'
import SignupOverlay from './SignupOverlay'
import { authApi } from '../api/client'

// ── Reusable info overlay ──────────────────────────────────────────────────────
function InfoOverlay({ title, message, primaryLabel, onPrimary, linkLabel, onLink, onClose }) {
  return (
    <div className="login-overlay" onClick={onClose}>
      <div className="login-overlay-card" onClick={(e) => e.stopPropagation()}>
        <button className="login-overlay-close" onClick={onClose}>&times;</button>
        <h2 className="login-overlay-title">{title}</h2>
        <p className="login-overlay-message">{message}</p>
        <button className="login-overlay-button" onClick={onPrimary}>{primaryLabel}</button>
        <p className="login-overlay-signup-text">
          {linkLabel.prefix}{' '}
          <span className="login-overlay-signup-link" onClick={onLink}>
            {linkLabel.action}
          </span>
        </p>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
function CodeStart({ onAnalyze, onNavigate, user, onLogin, onLogout }) {
  const [gitUrl, setGitUrl] = useState('')
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [infoOverlay, setInfoOverlay] = useState(null)
  const [activeModal, setActiveModal] = useState(null)

  const sidebarRef = useRef(null)
  const userMenuRef = useRef(null)

  // Close sidebar/user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target)) setSidebarOpen(false)
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const isValidGitHubUrl = (url) => {
    const pattern = /^https?:\/\/(www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?\/?$/
    return pattern.test(url.trim())
  }

  const handleLaunch = () => {
    if (!gitUrl.trim()) {
      setError('Please enter a GitHub repository URL.')
      return
    }
    if (!isValidGitHubUrl(gitUrl)) {
      setError('Please enter a valid GitHub repository URL (e.g. https://github.com/username/repo).')
      return
    }
    setError('')
    if (user) {
      handleAnalyze()
    } else {
      setInfoOverlay('no-account')
    }
  }

  const handleAnalyze = async () => {
    if (!gitUrl.trim()) return
    setError('')
    setPicking(true)
    try {
      const res = await fetch('http://localhost:6009/pick-folder')
      if (res.status === 204) { setPicking(false); return }
      const data = await res.json()
      setPicking(false)
      onAnalyze(gitUrl, data.path || undefined)
    } catch {
      setPicking(false)
      setError('Could not open folder picker — make sure the VS Code extension is running (press F5 in VS Code), then try again.')
    }
  }

  const handleLogout = async () => {
    try { await authApi.logout() } catch {}
    setUserMenuOpen(false)
    onLogout()
  }

  const getInitials = (name) => {
    if (!name) return '?'
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  // Navigate from sidebar and close it
  const sidebarNavigate = (page) => {
    setSidebarOpen(false)
    onNavigate(page)
  }

  return (
    <div className={`codestart-container ${sidebarOpen ? 'sidebar-active' : ''}`}>

      {/* ── Sidebar (YouTube-style) ── */}
      <div ref={sidebarRef}>
        {/* Hamburger button — always visible top left */}
        {!sidebarOpen && (
          <button
          className="hamburger-btn"
          onClick={() => setSidebarOpen(prev => !prev)}
          title="Menu"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>
            </svg>
            </button>
            )}
        {/* Sliding sidebar panel */}
        <div className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
          {/* Sidebar header with hamburger + logo */}
          <div className="sidebar-header">
            <button
              className="hamburger-btn"
              onClick={() => setSidebarOpen(false)}
              title="Close menu"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>
              </svg>
            </button>
            <span className="sidebar-logo-text">DevLauncher</span>
          </div>

          {/* Sidebar items */}
          <nav className="sidebar-nav">
            <button className="sidebar-item sidebar-item--active" onClick={() => setSidebarOpen(false)}>
              <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
              <span>Launch Project</span>
            </button>

            <button className="sidebar-item" onClick={() => sidebarNavigate('projects')}>
              <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
              </svg>
              <span>Projects</span>
            </button>
            
            <button className="sidebar-item sidebar-item--active" onClick={() => setSidebarOpen(false)}>
              {/* ... Launch Project ... */}
              </button>
              <button className="sidebar-item" onClick={() => sidebarNavigate('projects')}>
                {/* ... Projects ... */}
                </button>
                <button className="sidebar-item" onClick={() => sidebarNavigate('admin')}>
                  {/* ... Admin Panel ... */}
                  </button>
                  {user ? (
                    <button className="sidebar-item logout-item" onClick={() => { setSidebarOpen(false); handleLogout() }}>
                      <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                        <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
                        </svg>
                        <span>Log Out</span>
                        </button>
                        ) : (
                        <button className="sidebar-item" onClick={() => { setSidebarOpen(false); setInfoOverlay('welcome') }}>
                          <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                            <path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/>
                            </svg>
                            <span>Log In</span>
                            </button>
                          )}
          </nav>
        </div>
      </div>

      {/* ── Header ── */}
      <header className="codestart-header">
        {/* Empty left space (hamburger is positioned fixed) */}
        <div style={{ width: '40px' }} />

        {/* ── User icon or Log In button – top right ── */}
        {user ? (
          <div className="user-menu" ref={userMenuRef}>
            <button
              className="user-avatar-button"
              onClick={() => setUserMenuOpen((prev) => !prev)}
              title={user.name || user.email}
            >
              <span className="user-initials">{getInitials(user.name)}</span>
              <svg viewBox="0 0 24 24" fill="currentColor" className={`chevron-icon ${userMenuOpen ? 'open' : ''}`}>
                <path d="M7 10l5 5 5-5z"/>
              </svg>
            </button>

            {userMenuOpen && (
              <div className="user-dropdown">
                <div className="user-dropdown-info">
                  <span className="user-dropdown-name">{user.name || 'User'}</span>
                  <span className="user-dropdown-email">{user.email}</span>
                </div>
                <div className="user-dropdown-divider" />
                <button className="dropdown-item logout-item" onClick={handleLogout}>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="dropdown-icon">
                    <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
                  </svg>
                  Log Out
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            className="login-header-button"
            onClick={() => setInfoOverlay('welcome')}
            title="Login"
          >
            Log In
          </button>
        )}

        {/* Logo */}
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
          <span className="logo-text"> </span>
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="codestart-main">
        <h1 className="codestart-title">
          Install and Launch your web project in seconds.
        </h1>
        <p className="codestart-subtitle">
          The intelligent assistant analyzes, configures the dependencies and automatically launches the project
        </p>

        <div className="codestart-content">
          <div className="codestart-section git-section">
            <div className="section-header">
              <h2 className="section-title">Import from GitHub</h2>
              <button
                className="git-icon-button"
                onClick={() => window.open('https://github.com', '_blank')}
                title="Visit GitHub"
              >
                <svg className="git-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
              </button>
            </div>
            <div className="git-input-wrapper">
              <input
                type="text"
                className="git-input"
                placeholder="https://github.com/username/repo.git"
                value={gitUrl}
                onChange={(e) => { setGitUrl(e.target.value); setError('') }}
                onKeyPress={(e) => e.key === 'Enter' && handleLaunch()}
              />
            </div>
            {error && <p className="error-message">{error}</p>}
            <button className="analyze-button" onClick={handleLaunch} disabled={picking}>
              {picking ? 'Opening...' : 'Launch'}
            </button>
          </div>
        </div>
      </main>

      {/* ── Overlays ── */}
      {infoOverlay === 'no-account' && (
        <InfoOverlay
          title="Oops!"
          message="It seems that you don't have an account yet. Please sign up to launch your project."
          primaryLabel="Sign Up"
          onPrimary={() => { setInfoOverlay(null); setActiveModal('signup-modal') }}
          linkLabel={{ prefix: 'Already have an account?', action: 'Log In' }}
          onLink={() => { setInfoOverlay(null); setActiveModal('login-modal') }}
          onClose={() => setInfoOverlay(null)}
        />
      )}

      {infoOverlay === 'welcome' && (
        <InfoOverlay
          title="Welcome!"
          message="Welcome to your favourite web project launcher. For the best experience please log in to your account."
          primaryLabel="Log In"
          onPrimary={() => { setInfoOverlay(null); setActiveModal('login-modal') }}
          linkLabel={{ prefix: "Don't have an account yet?", action: 'Sign Up' }}
          onLink={() => { setInfoOverlay(null); setActiveModal('signup-modal') }}
          onClose={() => setInfoOverlay(null)}
        />
      )}

      {/* ── Auth modals ── */}
      {activeModal === 'login-modal' && (
        <LoginOverlay
          onClose={() => setActiveModal(null)}
          onLogin={onLogin}
          onNavigate={(page) => {
            if (page === 'signup-modal') setActiveModal('signup-modal')
            else { setActiveModal(null); onNavigate(page) }
          }}
        />
      )}

      {activeModal === 'signup-modal' && (
        <SignupOverlay
          onClose={() => setActiveModal(null)}
          onNavigate={(page) => {
            if (page === 'login-modal') setActiveModal('login-modal')
            else { setActiveModal(null); onNavigate(page) }
          }}
        />
      )}

    </div>
  )
}

export default CodeStart