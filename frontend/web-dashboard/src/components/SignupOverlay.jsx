import { useState } from 'react'
import { authApi } from '../api/client'
import '../styles/Auth.css'

function SignupOverlay({ onNavigate, onClose, onVerificationNeeded }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [emptyFields, setEmptyFields] = useState({})
  const [passwordFocused, setPasswordFocused] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // Password strength validation
  const hasCapitalLetter = /[A-Z]/.test(password)
  const hasAtLeastEight = password.length >= 8
  const hasNumber = /[0-9]/.test(password)
  const isPasswordStrong = hasCapitalLetter && hasAtLeastEight && hasNumber

  const handleSubmit = async (e) => {
    e.preventDefault()

    const empty = {}
    if (!name.trim()) empty.name = true
    if (!email.trim()) empty.email = true
    if (!password.trim()) empty.password = true

    // Validate password strength
    if (password.trim() && !isPasswordStrong) {
      setEmptyFields({})
      setError('Password must contain at least one capital letter, 6+ characters, and a number.')
      return
    }
    if (!confirmPassword.trim()) empty.confirmPassword = true

    if (Object.keys(empty).length > 0) {
      setEmptyFields(empty)
      setError('Please fill in all fields.')
      return
    }

    if (password !== confirmPassword) {
      setEmptyFields({})
      setError('Passwords do not match.')
      return
    }

    setEmptyFields({})
    setError('')
    setLoading(true)

    try {
      await authApi.register({ name, email, password, confirm_password: confirmPassword })
      // Registration successful — show email verification modal
      if (onVerificationNeeded) {
        onVerificationNeeded(email)
      } else {
        // Fallback to login if verification callback not provided
        onNavigate('login-modal')
      }
    } catch (err) {
      // Show the error message from the backend, or a generic one
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Registration failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>

        <button className="auth-modal-close" onClick={onClose} title="Close">
          &times;
        </button>

        <h1 className="auth-title">Sign Up</h1>
        <p className="auth-subtitle">Create your account to get started.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="signup-name">Full Name</label>
            <input
              id="signup-name"
              type="text"
              className={`auth-input ${emptyFields.name ? 'auth-input-error' : ''}`}
              placeholder="John Doe"
              value={name}
              onChange={(e) => { setName(e.target.value); setEmptyFields({}); setError('') }}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="signup-email">Email</label>
            <input
              id="signup-email"
              type="email"
              className={`auth-input ${emptyFields.email ? 'auth-input-error' : ''}`}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmptyFields({}); setError('') }}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="signup-password">Password</label>
            <div className="password-wrapper">
              <input
                id="signup-password"
                type={showPassword ? 'text' : 'password'}
                className={`auth-input ${emptyFields.password ? 'auth-input-error' : ''}`}
                placeholder="••••••••"
                value={password}
                autoComplete="new-password"
                onFocus={() => setPasswordFocused(true)}
                onBlur={() => setPasswordFocused(false)}
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
            {password && (
              <div className="auth-password-requirements">
                <div className={`auth-requirement ${hasCapitalLetter ? 'auth-requirement-met' : ''}`}>
                  <div className="auth-requirement-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <span>One capital letter (A-Z)</span>
                </div>
                <div className={`auth-requirement ${hasAtLeastEight ? 'auth-requirement-met' : ''}`}>
                  <div className="auth-requirement-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <span>At least 8 characters</span>
                </div>
                <div className={`auth-requirement ${hasNumber ? 'auth-requirement-met' : ''}`}>
                  <div className="auth-requirement-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <span>One number (0-9)</span>
                </div>
              </div>
            )}
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="signup-confirm">Confirm Password</label>
            <div className="password-wrapper">
              <input
                id="signup-confirm"
                type={showConfirmPassword ? 'text' : 'password'}
                className={`auth-input ${emptyFields.confirmPassword ? 'auth-input-error' : ''}`}
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setEmptyFields({}); setError('') }}
              />
              <button
                type="button"
                className="eye-btn"
                onClick={() => setShowConfirmPassword(prev => !prev)}
                tabIndex="-1"
              >
                {showConfirmPassword ? (
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
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-button" disabled={loading}>
            {loading ? 'Creating account...' : 'Sign Up'}
          </button>
        </form>

        <p className="auth-switch-text">
          Already have an account?{' '}
          <span className="auth-switch-link" onClick={() => onNavigate('login-modal')}>
            Login
          </span>
        </p>

      </div>
    </div>
  )
}

export default SignupOverlay
