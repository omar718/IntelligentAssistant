import { useState } from 'react'
import '../styles/Auth.css'

function Signup({ onNavigate, onClose }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')

  const handleSignup = (e) => {
    e.preventDefault()
    if (!name.trim() || !email.trim() || !password.trim() || !confirmPassword.trim()) {
      setError('Please fill in all fields.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setError('')
    // TODO: call your auth API here
    console.log('Signup with:', name, email, password)
  }

  const content = (
    <div className={onClose ? 'auth-card' : 'auth-container'} onClick={onClose ? (e) => e.stopPropagation() : undefined}>
      {onClose && (
        <button className="auth-modal-close" onClick={onClose} title="Close">&times;</button>
      )}
      <h1 className="auth-title">Sign Up</h1>
      <p className="auth-subtitle">Create your account to get started.</p>

      <form className="auth-form" onSubmit={handleSignup}>
        <div className="auth-field">
          <label className="auth-label" htmlFor="signup-name">Full Name</label>
          <input
            id="signup-name"
            type="text"
            className="auth-input"
            placeholder="John Doe"
            value={name}
            onChange={(e) => { setName(e.target.value); setError('') }}
          />
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            className="auth-input"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError('') }}
          />
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            type="password"
            className="auth-input"
            placeholder="••••••••"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError('') }}
          />
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="signup-confirm">Confirm Password</label>
          <input
            id="signup-confirm"
            type="password"
            className="auth-input"
            placeholder="••••••••"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError('') }}
          />
        </div>

        {error && <p className="auth-error">{error}</p>}

        <button type="submit" className="auth-button">Sign Up</button>
      </form>

      <p className="auth-switch-text">
        Already have an account?{' '}
        <span className="auth-switch-link" onClick={() => { onClose?.(); onNavigate('login') }}>
          Login
        </span>
      </p>

      {!onClose && (
        <button className="auth-back-link" onClick={() => onNavigate('home')}>
          ← Back to home
        </button>
      )}
    </div>
  )

  if (onClose) {
    return (
      <div className="auth-modal-overlay" onClick={onClose}>
        {content}
      </div>
    )
  }

  return content
}

export default Signup
