import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import '../styles/Auth.css'
import { authApi } from '../api/client'

function ForgotPasswordOverlay({ onNavigate, onClose }) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!email.trim()) {
      setError(t('auth.emailRequired'))
      return
    }

    // Simple email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setError(t('auth.validEmailRequired'))
      return
    }

    setError('')
    setLoading(true)

    try {
      // TODO: Call your password reset API here
      // await authApi.requestPasswordReset({ email })
      
      // For now, just simulate the request
      await authApi.forgotPassword(email)
      
      setIsSubmitted(true)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : t('auth.failedToSendResetEmail'))
    } finally {
      setLoading(false)
    }
  }

  const handleReset = () => {
    setEmail('')
    setIsSubmitted(false)
    setError('')
  }

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>

        <button className="auth-modal-close" onClick={onClose} title={t('auth.close')}>
          &times;
        </button>

        {!isSubmitted ? (
          <>
            <h1 className="auth-title">{t('auth.forgotPasswordTitle')}</h1>
            <p className="auth-subtitle">{t('auth.forgotPasswordSubtitle')}</p>

            <form className="auth-form" onSubmit={handleSubmit}>
              <div className="auth-field">
                <label className="auth-label" htmlFor="reset-email">{t('auth.email')}</label>
                <input
                  id="reset-email"
                  type="email"
                  className="auth-input"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError('') }}
                  disabled={loading}
                />
              </div>

              {error && <p className="auth-error">{error}</p>}

              <button type="submit" className="auth-button" disabled={loading}>
                {loading ? t('auth.sending') : t('auth.sendResetLink')}
              </button>
            </form>

            <p className="auth-switch-text">
              {t('auth.rememberPassword')}{' '}
              <span className="auth-switch-link" onClick={() => onNavigate('login-modal')}>
                {t('app.login')}
              </span>
            </p>
          </>
        ) : (
          <>
            <div className="auth-success-container">
              <svg className="auth-success-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
              <h2 className="auth-success-title">{t('auth.checkYourEmail')}</h2>
              <p className="auth-success-message">{t('auth.resetEmailSent', { email })}</p>
              <p className="auth-success-note">{t('auth.resetEmailNote')}</p>
              <button 
                type="button" 
                className="auth-button" 
                onClick={handleReset}
                style={{ marginTop: '1.5rem' }}
              >
                {t('auth.sendAnotherEmail')}
              </button>
            </div>

            <p className="auth-switch-text">
              {t('auth.backTo')}{' '}
              <span className="auth-switch-link" onClick={() => onNavigate('login-modal')}>
                {t('app.login')}
              </span>
            </p>
          </>
        )}

      </div>
    </div>
  )
}

export default ForgotPasswordOverlay
