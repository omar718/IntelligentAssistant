import '../../styles/Auth.css'

function VerifyEmailInvalidLinkOverlay({ onBackHome }) {
  return (
    <div className="auth-modal-overlay">
      <div className="auth-card">
        <h1 className="auth-title">Invalid or Expired Link</h1>
        <p className="auth-subtitle">This verification link is not valid anymore.</p>

        <div className="auth-verification-content">
          <svg className="auth-verification-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
          </svg>
          <p className="auth-verification-text">
            Request a new verification email and try again.
          </p>
        </div>

        <button type="button" className="auth-button" onClick={onBackHome}>
          Back to Home
        </button>
      </div>
    </div>
  )
}

export default VerifyEmailInvalidLinkOverlay
