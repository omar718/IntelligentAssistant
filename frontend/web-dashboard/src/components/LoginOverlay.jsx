import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authApi, userApi } from '../api/client'
import '../styles/Auth.css'

function LoginOverlay({ onNavigate, onClose, onLogin }) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [emptyFields, setEmptyFields] = useState({})
  const [showPassword, setShowPassword] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()

    const empty = {}
    if (!email.trim()) empty.email = true
    if (!password.trim()) empty.password = true

    if (Object.keys(empty).length > 0) {
      setEmptyFields(empty)
      setError(t('auth.pleaseFillInAllFields'))
      return
    }

    setEmptyFields({})
    setError('')
    setLoading(true)

    try {
      // Step 1: Login and save token
      await authApi.login({ email, password })

      // Step 2: Fetch the user's profile
      const profile = await userApi.getMe()

      // Step 3: Pass the profile up to App.jsx
      onLogin(profile)

      // Step 4: Close the modal
      onClose()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : t('auth.loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>

        <button className="auth-modal-close" onClick={onClose} title={t('auth.close')}>
          &times;
        </button>

        <h1 className="auth-title">{t('auth.loginTitle')}</h1>
        <p className="auth-subtitle">{t('auth.loginSubtitle')}</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="login-email">{t('auth.emailLabel')}</label>
            <input
              id="login-email"
              type="email"
              className={`auth-input ${emptyFields.email ? 'auth-input-error' : ''}`}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmptyFields({}); setError('') }}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="login-password">{t('auth.passwordLabel')}</label>
            <div className="password-wrapper">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                className={`auth-input ${emptyFields.password ? 'auth-input-error' : ''}`}
                placeholder="••••••••"
                value={password}
                autoComplete="new-password"
                onChange={(e) => { setPassword(e.target.value); setEmptyFields({}); setError('') }}
              />
              <button
                type="button"
                className="eye-btn"
                onClick={() => setShowPassword(prev => !prev)}
                tabIndex="-1"
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.47 18.47 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
            <span 
              className="auth-forgot-password" 
              onClick={() => onNavigate('forgot-password-modal')}
            >
              {t('auth.forgotPassword')}
            </span>
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-button" disabled={loading}>
            {loading ? t('auth.loggingIn') : t('auth.loginTitle')}
          </button>
        </form>

        <p className="auth-switch-text">
          {t('auth.dontHaveAccount')}{' '}
          <span className="auth-switch-link" onClick={() => onNavigate('signup-modal')}>
            {t('auth.signUp')}
          </span>
        </p>

      </div>
    </div>
  )
}

export default LoginOverlay