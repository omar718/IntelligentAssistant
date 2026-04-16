import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import '../styles/Auth.css'
import { authApi } from '../api/client'
import CodeStart from './CodeStart'

const PASSWORD_RULE_ERROR = 'Password must contain at least one capital letter, 8+ characters, and a number.'

function ResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [user] = useState(() => {
    const saved = localStorage.getItem('user')
    return saved ? JSON.parse(saved) : null
  })
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)


  useEffect(() => {
    const tokenParam = searchParams.get('token')
    if (!tokenParam) {
      setError('Invalid reset link. No token provided.')
    } else {
      setToken(tokenParam)
    }
  }, [searchParams])

  const handleResetPassword = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    // Client-side validation
    if (!password) {
      setError('Password is required')
      setLoading(false)
      return
    }

    const isPasswordStrong = password.length >= 8 && /[A-Z]/.test(password) && /\d/.test(password)
    if (!isPasswordStrong) {
      setError(PASSWORD_RULE_ERROR)
      setLoading(false)
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      setLoading(false)
      return
    }

    try {
      await authApi.resetPassword({
        token,
        password,
        confirm_password: confirmPassword,
      })
      setSuccess(true)
      // Redirect to home after 2 seconds
      setTimeout(() => {
        navigate('/?auth=login', { replace: true })
      }, 2000)
    } catch (err) {
      const detail = err?.response?.data?.detail
      if (typeof detail === 'string') {
        setError(detail)
      } else if (Array.isArray(detail)) {
        const firstMessage = detail[0]?.msg
        setError(typeof firstMessage === 'string' ? firstMessage : 'Failed to reset password. Please try again.')
      } else {
        setError('Failed to reset password. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <>
        <CodeStart
          onAnalyze={() => {}}
          onNavigate={() => {}}
          user={user}
          onLogin={() => {}}
          onLogout={() => {}}
        />
        <div className="auth-modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
          <div className="auth-card" style={{ maxWidth: '500px', width: '100%', margin: '0 20px' }}>
            <svg 
              className="auth-verification-icon" 
              viewBox="0 0 24 24" 
              fill="currentColor"
              style={{ color: '#ef4444', fontSize: '4rem', marginBottom: '1rem' }}
            >
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
            </svg>
            <h1 className="auth-title" style={{ color: '#ef4444' }}>Invalid Reset Link</h1>
            <p className="auth-subtitle">{error}</p>
            <button 
              className="auth-button"
              onClick={() => navigate('/', { replace: true })}
              style={{ marginTop: '2rem' }}
            >
              Back to Home
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <CodeStart
        onAnalyze={() => {}}
        onNavigate={() => {}}
        user={user}
        onLogin={() => {}}
        onLogout={() => {}}
      />
      <div className="auth-modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
        <div className="auth-card" style={{ maxWidth: '500px', width: '100%', margin: '0 20px' }}>
          {success ? (
            <>
              <svg 
                className="auth-verification-icon" 
                viewBox="0 0 24 24" 
                fill="currentColor"
                style={{ color: '#10b981', fontSize: '4rem', margin: '0 auto 1rem', display: 'block' }}
              >
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
              </svg>
              <h1 className="auth-title" style={{ color: '#10b981' }}>Password Reset Successful!</h1>
              <p className="auth-subtitle">
                Your password has been successfully updated. You can now log in with your new password.
              </p>
              <p className="auth-verification-note">
                Redirecting you to the home page...
              </p>
            </>
          ) : (
            <>
              <h1 className="auth-title">Reset Your Password</h1>
              <p className="auth-subtitle">
                Enter a new password for your account
              </p>

              <form onSubmit={handleResetPassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '2rem' }}>
                <div className="auth-field">
                  <label className="auth-label" htmlFor="reset-password">New Password</label>
                  <div className="password-wrapper">
                    <input
                      id="reset-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="New password"
                      className="auth-input"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      required
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
                </div>

                <div className="auth-field">
                  <label className="auth-label" htmlFor="reset-confirm-password">Confirm New Password</label>
                  <div className="password-wrapper">
                    <input
                      id="reset-confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      placeholder="Confirm password"
                      className="auth-input"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={loading}
                      required
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

                {error && <p className="auth-error" style={{ color: '#ef4444', fontSize: '0.875rem', margin: '0.5rem 0' }}>{error}</p>}

                <button
                  type="submit"
                  className="auth-button"
                  disabled={loading}
                  style={{
                    opacity: loading ? 0.6 : 1,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    marginTop: '1rem',
                  }}
                >
                  {loading ? 'Resetting...' : 'Reset Password'}
                </button>
              </form>

              <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                <p className="auth-switch-text">
                  Remember your password?{' '}
                  <span 
                    className="auth-switch-link" 
                    onClick={() => navigate('/', { replace: true })}
                    style={{ cursor: 'pointer' }}
                  >
                    Go back home
                  </span>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export default ResetPassword
