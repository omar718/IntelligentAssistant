import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authApi } from '../api/client'
import '../styles/Auth.css'

function EmailVerificationOverlay({ email, onNavigate, onClose, onVerified }) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resendLoading, setResendLoading] = useState(false)
  const [linkSent, setLinkSent] = useState(false)

  const handleContinueToLogin = () => {
    // User clicked the verification link in their email
    // They can now proceed to login
    if (onVerified) {
      onVerified()
    } else {
      onNavigate('login-modal')
    }
  }

  const handleResendLink = async () => {
    if (!email || resendLoading) return

    setResendLoading(true)
    setError('')
    setLinkSent(false)

    try {
      await authApi.forgotPassword(email)
      setLinkSent(true)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : t('auth.failedToResendLink'))
    } finally {
      setResendLoading(false)
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>

        <button className="auth-modal-close" onClick={onClose} title={t('auth.close')}>
          &times;
        </button>

        <h1 className="auth-title">{t('auth.verifyYourEmailTitle')}</h1>
        <p className="auth-subtitle">
          {t('auth.verificationSentTo', { email })}
        </p>

        <div className="auth-verification-content">
          <svg className="auth-verification-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
          </svg>
          <p className="auth-verification-text">{t('auth.verificationInstruction')}</p>
          <p className="auth-verification-note">{t('auth.linkExpires')}</p>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <div className="auth-verify-actions">
          <p className="auth-verify-text">
            {t('auth.didntReceiveLink')}{' '}
            <span 
              className="auth-switch-link" 
              onClick={handleResendLink}
              style={{ cursor: resendLoading ? 'not-allowed' : 'pointer', opacity: resendLoading ? 0.6 : 1 }}
            >
              {resendLoading ? t('auth.sending') : t('auth.resendIt')}
            </span>
          </p>
          {linkSent && <p className="auth-success-text">{t('auth.linkSentCheckEmail')}</p>}
        </div>

        <p className="auth-switch-text">
          {t('auth.wrongEmail')}{' '}
          <span className="auth-switch-link" onClick={() => onNavigate('signup-modal')}>
            {t('auth.signUpAgain')}
          </span>
        </p>

      </div>
    </div>
  )
}

export default EmailVerificationOverlay
