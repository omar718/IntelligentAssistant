import { useState } from 'react'
import { authApi } from '../api/client'
import '../styles/Auth.css'

function EmailVerificationOverlay({ email, onNavigate, onClose, onVerified }) {
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
      setError(typeof detail === 'string' ? detail : 'Failed to resend link. Please try again.')
    } finally {
      setResendLoading(false)
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>

        <button className="auth-modal-close" onClick={onClose} title="Close">
          &times;
        </button>

        <h1 className="auth-title">Verify Your Email</h1>
        <p className="auth-subtitle">
          We've sent a verification link to <strong>{email}</strong>. 
        </p>

        <div className="auth-verification-content">
          <svg className="auth-verification-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
          </svg>
          <p className="auth-verification-text">
            Click the link in your email to verify your account and activate your login.
          </p>
          <p className="auth-verification-note">
            The link will expire in 24 hours.
          </p>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <div className="auth-verify-actions">
          <p className="auth-verify-text">
            Didn't receive the link?{' '}
            <span 
              className="auth-switch-link" 
              onClick={handleResendLink}
              style={{ cursor: resendLoading ? 'not-allowed' : 'pointer', opacity: resendLoading ? 0.6 : 1 }}
            >
              {resendLoading ? 'Sending...' : 'Resend it'}
            </span>
          </p>
          {linkSent && <p className="auth-success-text">Link sent! Check your email.</p>}
        </div>

        <p className="auth-switch-text">
          Wrong email?{' '}
          <span className="auth-switch-link" onClick={() => onNavigate('signup-modal')}>
            Sign up again
          </span>
        </p>

      </div>
    </div>
  )
}

export default EmailVerificationOverlay
