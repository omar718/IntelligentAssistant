import '../../styles/Auth.css'

function VerifyEmailNotFoundOverlay({ onBackHome }) {
  return (
    <div className="auth-modal-overlay">
      <div className="auth-card">
        <h1 className="auth-title">User Not Found</h1>
        <p className="auth-subtitle">We could not find an account for this verification link.</p>

        <div className="auth-verification-content">
          <svg className="auth-verification-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.7 0 4.88-2.18 4.88-4.88S14.7 2.24 12 2.24 7.12 4.42 7.12 7.12 9.3 12 12 12zm0 2.44c-3.25 0-9.76 1.63-9.76 4.88v2.44h19.52v-2.44c0-3.25-6.51-4.88-9.76-4.88z" />
          </svg>
          <p className="auth-verification-text">
            Please sign up again or contact support if this keeps happening.
          </p>
        </div>

        <button type="button" className="auth-button" onClick={onBackHome}>
          Back to Home
        </button>
      </div>
    </div>
  )
}

export default VerifyEmailNotFoundOverlay
