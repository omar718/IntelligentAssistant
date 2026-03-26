import '../../styles/Auth.css'

function VerifyEmailSuccessOverlay({ onGoLogin }) {
  return (
    <div className="auth-modal-overlay">
      <div className="auth-card">
        <h1 className="auth-title">Email Verified</h1>
        <p className="auth-subtitle">Your account is now active. You can sign in.</p>

        <div className="auth-verification-content">
          <svg className="auth-verification-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16.17l-3.88-3.88L3.71 13.7 9 19l12-12-1.41-1.41z" />
          </svg>
          <p className="auth-verification-text">
            Verification completed successfully.
          </p>
        </div>

        <button
          type="button"
          className="auth-button"
          onClick={onGoLogin}
          style={{ display: 'block', margin: '0.5rem auto 0' }}
        >
          Go to Login
        </button>

      </div>
    </div>
  )
}

export default VerifyEmailSuccessOverlay
