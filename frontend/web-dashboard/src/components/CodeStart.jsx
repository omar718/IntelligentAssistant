import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import '../styles/CodeStart.css'
import LoginOverlay from './LoginOverlay'
import SignupOverlay from './SignupOverlay'
import ForgotPasswordOverlay from './ForgotPasswordOverlay'
import EmailVerificationOverlay from './EmailVerificationOverlay'
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
function CodeStart({ onAnalyze, onNavigate, user, onLogin, onLogout, theme, onToggleTheme, projectError, onClearProjectError }) {
  const { t } = useTranslation()
  const location = useLocation()
  const routerNavigate = useNavigate()
  const [gitUrl, setGitUrl] = useState('')
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [infoOverlay, setInfoOverlay] = useState(null)
  const [activeModal, setActiveModal] = useState(null)
  const [verificationEmail, setVerificationEmail] = useState(null)

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

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const auth = params.get('auth')

    if (auth === 'login') {
      setInfoOverlay(null)
      setActiveModal('login-modal')
      routerNavigate('/', { replace: true })
    }
  }, [location.search, routerNavigate])

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
    console.log('[CodeStart] Validating repository...', { gitUrl })
    
    try {
      // Step 1: Validate repository with backend before opening folder picker
      console.log('[CodeStart] Calling /api/projects/validate...')
      const token = localStorage.getItem('access_token')
      const validateRes = await fetch('/api/projects/validate', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify({ url: gitUrl })
      })
      
      const validateData = await validateRes.json()
      console.log('[CodeStart] Validation response:', validateData)
      
      if (!validateData.valid) {
        // Repository is invalid - show error immediately without folder picker
        console.log('[CodeStart] Repository validation failed:', validateData.error)
        setPicking(false)
        setError(validateData.error || 'Repository validation failed, Please enter an existing GitHub repository URL.')
        return
      }
      
      // Step 2: Validation passed, now open folder picker
      console.log('[CodeStart] Repository is valid, opening folder picker...', { gitUrl })
      const res = await fetch('http://localhost:6009/pick-folder')
      console.log('[CodeStart] Folder picker response status:', res.status)
      
      if (res.status === 204) {
        console.warn('[CodeStart] Folder picker returned 204; continuing with default clone directory')
        setPicking(false)
        onAnalyze(gitUrl, undefined)
        return
      }
      
      const data = await res.json()
      console.log('[CodeStart] Folder picker response data:', data)
      setPicking(false)
      
      console.log('[CodeStart] Calling onAnalyze with:', { gitUrl, path: data.path })
      onAnalyze(gitUrl, data.path || undefined)
    } catch (err) {
      console.error('[CodeStart] Error in handleAnalyze:', err)
      setPicking(false)
      setError('Could not validate repository — please try again.')
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

  const getProfileImage = () => user?.profile_picture || user?.profilePicture || ''

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
          title={t('app.menu')}
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
              title={t('app.closeMenu')}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>
              </svg>
            </button>
            <span className="sidebar-logo-text">DevLauncher</span>
          </div>

          {/* Sidebar items */}
          <nav className="sidebar-nav" aria-label="Sidebar navigation">
            <div className="sidebar-nav-main">
              <button className="sidebar-item sidebar-item--active" onClick={() => setSidebarOpen(false)}>
                <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
                <span>{t('home.launch')}</span>
              </button>

              <button className="sidebar-item" onClick={() => sidebarNavigate('projects')}>
                <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                  <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
                </svg>
                <span>{t('projects.title')}</span>
              </button>

              {user ? (
                <button className="sidebar-item logout-item" onClick={() => { setSidebarOpen(false); handleLogout() }}>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                    <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
                  </svg>
                  <span>{t('app.logout')}</span>
                </button>
              ) : (
                <button className="sidebar-item" onClick={() => { setSidebarOpen(false); setInfoOverlay('welcome') }}>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                    <path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/>
                  </svg>
                  <span>{t('app.login')}</span>
                </button>
              )}
            </div>

            <div className="sidebar-nav-bottom">
              <button className="sidebar-item" onClick={() => sidebarNavigate('settings')}>
                <svg viewBox="0 0 24 24" fill="currentColor" className="sidebar-icon">
                  <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.03 7.03 0 00-1.63-.94l-.36-2.54A.5.5 0 0013.89 2h-3.78a.5.5 0 00-.49.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.72 8.48a.5.5 0 00.12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.78c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8a3.5 3.5 0 010 7.5z"/>
                </svg>
                <span>{t('app.settings')}</span>
              </button>
            </div>
          </nav>
        </div>
      </div>

      {/* ── Header ── */}
      <header className="codestart-header">
        {/* Empty left space (hamburger is positioned fixed) */}
        <div style={{ width: '40px' }} />

        {/* ── User icon or Log In button – top right ── */}
        <div className="header-actions">
          <button
            className="header-theme-toggle"
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            <span className="header-theme-toggle-icon" aria-hidden="true">
              <svg viewBox="0 0 72 24" fill="none">
  {/* Background circle (the toggle knob) */}
  <circle
    cx={theme === 'light' ? 52 : 20}
    cy="12"
    r="8"
    fill="var(--toggle-bg)"
    opacity="0.95"
    style={{
      transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)'
    }}
  />

  {/* Sliding icon container */}
  <g
    style={{
      transform: `translate(${theme === 'light' ? 52 : 20}px, 12px)`,
      transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)'
    }}
  >
    {/* 🌞 Sun */}
    <g
      style={{
        opacity: theme === 'light' ? 1 : 0,
        transform: `scale(${theme === 'light' ? 1 : 0.6}) rotate(${theme === 'light' ? 0 : 90}deg)`,
        transformOrigin: 'center',
        transition: 'all 0.5s ease'
      }}
    >
      <circle cx="0" cy="0" r="4.3" fill="currentColor" />
      <line x1="0" y1="-7" x2="0" y2="-5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <line x1="0" y1="7" x2="0" y2="5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <line x1="-7" y1="0" x2="-5" y2="0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <line x1="7" y1="0" x2="5" y2="0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </g>

    {/* 🌙 Moon */}
    <g
      style={{
        position: 'absolute', // safe to remove if issues
        opacity: theme === 'dark' ? 1 : 0,
        transform: `scale(${theme === 'dark' ? 1 : 0.6}) rotate(${theme === 'dark' ? 0 : -90}deg)`,
        transformOrigin: 'center',
        transition: 'all 0.5s ease'
      }}
    >
      <path
        d="M 0 -7 A 7 7 0 1 0 0 7 A 4.5 7 0 1 1 0 -7 Z"
        fill="currentColor"
      />
    </g>
  </g>
</svg>
            </span>
            <span className="header-theme-toggle-label">{theme === 'dark' ? t('app.lightMode') : t('app.darkMode')}</span>
          </button>

          {user ? (
            <div className="user-menu" ref={userMenuRef}>
              <button
                className="user-avatar-button"
                onClick={() => setUserMenuOpen((prev) => !prev)}
                title={user.name || user.email}
              >
                {getProfileImage() ? (
                  <img className="user-avatar-image" src={getProfileImage()} alt={user.name || user.email || t('settings.guestUser')} />
                ) : (
                  <span className="user-initials">{getInitials(user.name)}</span>
                )}
                <svg viewBox="0 0 24 24" fill="currentColor" className={`chevron-icon ${userMenuOpen ? 'open' : ''}`}>
                  <path d="M7 10l5 5 5-5z"/>
                </svg>
              </button>

              {userMenuOpen && (
                <div className="user-dropdown">
                  <div className="user-dropdown-info">
                    <span className="user-dropdown-name">{user.name || t('settings.guestUser')}</span>
                    <span className="user-dropdown-email">{user.email}</span>
                  </div>
                  <div className="user-dropdown-divider" />
                  <button className="dropdown-item logout-item" onClick={handleLogout}>
                    <svg viewBox="0 0 24 24" fill="currentColor" className="dropdown-icon">
                      <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
                    </svg>
                    {t('app.logout')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              className="login-header-button"
              onClick={() => setInfoOverlay('welcome')}
              title={t('app.login')}
            >
              {t('app.login')}
            </button>
          )}
        </div>

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
          {t('home.title')}
        </h1>
        <p className="codestart-subtitle">
          {t('home.subtitle')}
        </p>

        <div className="codestart-content">
          <div className="codestart-section git-section">
            <div className="section-header">
              <h2 className="section-title">{t('home.importFromGitHub')}</h2>
              <button
                className="git-icon-button"
                onClick={() => window.open('https://github.com', '_blank')}
                title={t('home.visitGitHub')}
              >
                <svg className="git-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
              </button>
            </div>
            <div className="git-section-inner">
              {projectError && (
                <div className="project-error-message">
                  <p>{projectError}</p>
                  <button 
                    className="project-error-close"
                    onClick={() => {
                      onClearProjectError()
                      setGitUrl('')
                    }}
                    title={t('app.back')}
                  >
                    ✕
                  </button>
                </div>
              )}
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
            </div>
            {error && <p className="error-message">{error}</p>}
            <button className="analyze-button" onClick={handleLaunch} disabled={picking}>
              {picking ? t('home.opening') : t('home.launch')}
            </button>
          </div>
        </div>
      </main>

      {/* ── Overlays ── */}
      {infoOverlay === 'no-account' && (
        <InfoOverlay
          title={t('home.oops')}
          message={t('home.noAccount')}
          primaryLabel={t('home.signUp')}
          onPrimary={() => { setInfoOverlay(null); setActiveModal('signup-modal') }}
          linkLabel={{ prefix: t('home.alreadyHaveAccount'), action: t('app.login') }}
          onLink={() => { setInfoOverlay(null); setActiveModal('login-modal') }}
          onClose={() => { setInfoOverlay(null); void handleAnalyze() }}
        />
      )}

      {infoOverlay === 'welcome' && (
        <InfoOverlay
          title={t('home.welcome')}
          message={t('home.welcomeMessage')}
          primaryLabel={t('app.login')}
          onPrimary={() => { setInfoOverlay(null); setActiveModal('login-modal') }}
          linkLabel={{ prefix: t('home.doNotHaveAccount'), action: t('home.signUp') }}
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
            else if (page === 'forgot-password-modal') setActiveModal('forgot-password-modal')
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
          onVerificationNeeded={(email) => {
            setVerificationEmail(email)
            setActiveModal('verify-email-modal')
          }}
        />
      )}

      {activeModal === 'forgot-password-modal' && (
        <ForgotPasswordOverlay
          onClose={() => setActiveModal(null)}
          onNavigate={(page) => {
            if (page === 'login-modal') setActiveModal('login-modal')
            else { setActiveModal(null); onNavigate(page) }
          }}
        />
      )}

      {activeModal === 'verify-email-modal' && verificationEmail && (
        <EmailVerificationOverlay
          email={verificationEmail}
          onClose={() => { setActiveModal(null); setVerificationEmail(null) }}
          onVerified={() => {
            setActiveModal('login-modal')
            setVerificationEmail(null)
          }}
          onNavigate={(page) => {
            if (page === 'signup-modal') setActiveModal('signup-modal')
            else if (page === 'login-modal') setActiveModal('login-modal')
            else { setActiveModal(null); onNavigate(page) }
          }}
        />
      )}

    </div>
  )
}

export default CodeStart