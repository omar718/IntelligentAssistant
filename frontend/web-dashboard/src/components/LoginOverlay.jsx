import { useState } from 'react'
import { authApi } from '../api/client'
import '../styles/Auth.css'

function LoginOverlay({ onNavigate, onClose }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields.')
      return
    }

    setError('')
    setLoading(true)

    try {
      await authApi.login({ email, password })
      // Login successful — close the modal
      onClose()
      onNavigate('home')
    } catch (err) {
      // Show the error message from the backend, or a generic one
      setError(err?.response?.data?.detail || 'Login failed. Please check your credentials.')
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

        <h1 className="auth-title">Log In</h1>
        <p className="auth-subtitle">Welcome back! Log in to your account.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              className="auth-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError('') }}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              className="auth-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
            />
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-button" disabled={loading}>
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        <p className="auth-switch-text">
          Don't have an account?{' '}
          <span className="auth-switch-link" onClick={() => onNavigate('signup-modal')}>
            Sign up
          </span>
        </p>

      </div>
    </div>
  )
}

export default LoginOverlay
