import { useState } from 'react'
import '../styles/Auth.css'
import { authApi } from '../api/client'

function ForgotPasswordOverlay({ onNavigate, onClose }) {
  const [email, setEmail] = useState('')
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }

    // Simple email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address.')
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
      setError(typeof detail === 'string' ? detail : 'Failed to send reset email. Please try again.')
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

        <button className="auth-modal-close" onClick={onClose} title="Close">
          &times;
        </button>

        {!isSubmitted ? (
          <>
            <h1 className="auth-title">Reset Password</h1>
            <p className="auth-subtitle">
              Enter your email address and we'll send you a link to reset your password.
            </p>

            <form className="auth-form" onSubmit={handleSubmit}>
              <div className="auth-field">
                <label className="auth-label" htmlFor="reset-email">Email</label>
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
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>

            <p className="auth-switch-text">
              Remember your password?{' '}
              <span className="auth-switch-link" onClick={() => onNavigate('login-modal')}>
                Login
              </span>
            </p>
          </>
        ) : (
          <>
            <div className="auth-success-container">
              <svg className="auth-success-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
              <h2 className="auth-success-title">Check Your Email</h2>
              <p className="auth-success-message">
                We've sent a password reset link to <strong>{email}</strong>. 
                Please check your email and follow the link to reset your password.
              </p>
              <p className="auth-success-note">
                If you don't see the email in a few minutes, check your spam folder.
              </p>
              <button 
                type="button" 
                className="auth-button" 
                onClick={handleReset}
                style={{ marginTop: '1.5rem' }}
              >
                Send Another Email
              </button>
            </div>

            <p className="auth-switch-text">
              Back to{' '}
              <span className="auth-switch-link" onClick={() => onNavigate('login-modal')}>
                Login
              </span>
            </p>
          </>
        )}

      </div>
    </div>
  )
}

export default ForgotPasswordOverlay
