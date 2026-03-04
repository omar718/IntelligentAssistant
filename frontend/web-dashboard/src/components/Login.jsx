import { useState } from 'react'
import '../styles/Auth.css'

function Login({ onNavigate }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleLogin = (e) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields.')
      return
    }
    setError('')
    // TODO: call your auth API here
    console.log('Login with:', email, password)
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1 className="auth-title">Login</h1>
        <p className="auth-subtitle">Welcome back! Please login to your account.</p>

        <form className="auth-form" onSubmit={handleLogin}>
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

          <button type="submit" className="auth-button">Login</button>
        </form>

        <p className="auth-switch-text">
          You still don't have an account?{' '}
          <span className="auth-switch-link" onClick={() => onNavigate('signup')}>
            Signup
          </span>
        </p>

        <button className="auth-back-link" onClick={() => onNavigate('home')}>
          ← Back to home
        </button>
      </div>
    </div>
  )
}

export default Login
