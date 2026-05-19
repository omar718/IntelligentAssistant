import { useTranslation } from 'react-i18next'
import '../styles/VSCodeModal.css'

function VSCodeModal({ onClose }) {
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} title={t('modal.close')}>
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

        <h2 className="modal-title">{t('modal.vscodeNotFoundTitle')}</h2>
        <p className="modal-message">
          {t('modal.vscodeNotFoundMessage')}{' '}
          <a
            href="https://code.visualstudio.com/download"
            target="_blank"
            rel="noreferrer"
            className="modal-link"
          >
            {t('modal.downloadLink')}
          </a>{' '}
          {t('modal.vscodeNotFoundTail')}
        </p>

        <button className="modal-action-btn" onClick={onClose}>
          {t('modal.gotIt')}
        </button>
      </div>
    </div>
  )
}

export default VSCodeModal
