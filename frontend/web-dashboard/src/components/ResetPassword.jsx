import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import '../styles/Auth.css'
import { authApi } from '../api/client'

function ResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

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

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      setLoading(false)
      return
    }

    if (!/[A-Z]/.test(password)) {
      setError('Password must contain at least one uppercase letter')
      setLoading(false)
      return
    }

    if (!/\d/.test(password)) {
      setError('Password must contain at least one digit')
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
        new_password: password,
        confirm_password: confirmPassword,
      })
      setSuccess(true)
      // Redirect to home after 2 seconds
      setTimeout(() => {
        navigate('/', { replace: true })
      }, 2000)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Failed to reset password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
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
    )
  }

  return (
    <div className="auth-modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
      <div className="auth-card" style={{ maxWidth: '500px', width: '100%', margin: '0 20px' }}>
        {success ? (
          <>
            <svg 
              className="auth-verification-icon" 
              viewBox="0 0 24 24" 
              fill="currentColor"
              style={{ color: '#10b981', fontSize: '4rem', marginBottom: '1rem' }}
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
              <div>
                <input
                  type="password"
                  placeholder="New password"
                  className="auth-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '0.375rem',
                    fontSize: '1rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <input
                  type="password"
                  placeholder="Confirm password"
                  className="auth-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={loading}
                  required
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '0.375rem',
                    fontSize: '1rem',
                    boxSizing: 'border-box',
                  }}
                />
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
  )
}

export default ResetPassword
