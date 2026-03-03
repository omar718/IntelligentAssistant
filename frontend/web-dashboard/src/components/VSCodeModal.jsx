import '../styles/VSCodeModal.css'

function VSCodeModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>

        <div className="modal-icon-wrap">
          <svg viewBox="0 0 24 24" fill="none" className="modal-warning-icon">
            <path d="M12 2L1 21h22L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            <line x1="12" y1="9" x2="12" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <circle cx="12" cy="17.5" r="0.8" fill="currentColor"/>
          </svg>
        </div>

        <h2 className="modal-title">Oops!</h2>
        <p className="modal-message">
          The project launcher couldn't detect VS Code installed. Please install it via{' '}
          <a
            href="https://code.visualstudio.com/download"
            target="_blank"
            rel="noreferrer"
            className="modal-link"
          >
            this link
          </a>{' '}
          to benefit from our assistant.
        </p>

        <button className="modal-action-btn" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  )
}

export default VSCodeModal
