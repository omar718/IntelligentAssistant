import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { userApi } from '../api/client'
import '../styles/SettingsPage.css'

function formatLastLogin(value) {
  if (!value) return 'No login activity available yet.'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No login activity available yet.'

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSessionDate(value) {
  if (!value) return 'Not available'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getInitials(name) {
  if (!name) return 'U'
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

const PASSWORD_CRITERIA_MESSAGE = 'Password must contain at least one capital letter, 8+ characters, and a number.'

function isStrongPassword(value) {
  return value.length >= 8 && /[A-Z]/.test(value) && /\d/.test(value)
}

function LanguageFlag({ language }) {
  if (language === 'french') {
    return (
      <svg className="language-choice-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect x="0" y="0" width="8" height="16" fill="#1d4ed8" />
        <rect x="8" y="0" width="8" height="16" fill="#ffffff" />
        <rect x="16" y="0" width="8" height="16" fill="#ef4444" />
      </svg>
    )
  }

  if (language === 'english') {
    return (
      <svg className="language-choice-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect x="0" y="0" width="24" height="16" fill="#ffffff" />
        <rect x="0" y="0" width="24" height="2" fill="#dc2626" />
        <rect x="0" y="4" width="24" height="2" fill="#dc2626" />
        <rect x="0" y="8" width="24" height="2" fill="#dc2626" />
        <rect x="0" y="12" width="24" height="2" fill="#dc2626" />
        <rect x="0" y="0" width="10" height="8.5" fill="#1d4ed8" />
        <circle cx="2" cy="2" r="0.5" fill="#ffffff" />
        <circle cx="4" cy="2" r="0.5" fill="#ffffff" />
        <circle cx="6" cy="2" r="0.5" fill="#ffffff" />
        <circle cx="8" cy="2" r="0.5" fill="#ffffff" />
        <circle cx="3" cy="4" r="0.5" fill="#ffffff" />
        <circle cx="5" cy="4" r="0.5" fill="#ffffff" />
        <circle cx="7" cy="4" r="0.5" fill="#ffffff" />
        <circle cx="2" cy="6" r="0.5" fill="#ffffff" />
        <circle cx="4" cy="6" r="0.5" fill="#ffffff" />
        <circle cx="6" cy="6" r="0.5" fill="#ffffff" />
        <circle cx="8" cy="6" r="0.5" fill="#ffffff" />
      </svg>
    )
  }

  if (language === 'arabic') {
    return (
      <svg className="language-choice-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect x="0" y="0" width="24" height="16" fill="#166534" />
        <rect x="6" y="7.5" width="12" height="1" fill="#ffffff" opacity="0.95" />
        <circle cx="11" cy="8" r="1" fill="#ffffff" />
      </svg>
    )
  }

  if (language === 'german') {
    return (
      <svg className="language-choice-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect x="0" y="0" width="24" height="5.33" fill="#111827" />
        <rect x="0" y="5.33" width="24" height="5.34" fill="#dc2626" />
        <rect x="0" y="10.67" width="24" height="5.33" fill="#f59e0b" />
      </svg>
    )
  }

  return null
}

function SettingsPage({ user, onBack, onUserUpdate }) {
  const { t } = useTranslation()
  const [profileImage, setProfileImage] = useState(
    user?.profile_picture || user?.profilePicture || '',
  )
  const [activeSection, setActiveSection] = useState('personal')
  const [selectedLanguage, setSelectedLanguage] = useState(() => {
    const currentLanguage = i18n.language || localStorage.getItem('language') || 'en'
    if (currentLanguage.startsWith('fr')) return 'french'
    if (currentLanguage.startsWith('ar')) return 'arabic'
    if (currentLanguage.startsWith('de')) return 'german'
    return 'english'
  })
  const [showPasswordForm, setShowPasswordForm] = useState(false)
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordMessageType, setPasswordMessageType] = useState('')
  const [passwordErrors, setPasswordErrors] = useState({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
  })
  const [uploadMessage, setUploadMessage] = useState('')
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false)
  const [sessionActionConfirmation, setSessionActionConfirmation] = useState(null)
  const [activeSessions, setActiveSessions] = useState([])
  const [isSessionsLoading, setIsSessionsLoading] = useState(false)
  const [sessionsActionLoadingId, setSessionsActionLoadingId] = useState('')
  const [sessionsError, setSessionsError] = useState('')
  const [sessionsMessage, setSessionsMessage] = useState('')

  const lastLogin = useMemo(() => {
    return formatLastLogin(user?.last_login || user?.lastLogin || user?.last_login_at)
  }, [user])

  useEffect(() => {
    const handleLanguageChange = (language) => {
      if (language.startsWith('fr')) setSelectedLanguage('french')
      else if (language.startsWith('ar')) setSelectedLanguage('arabic')
      else if (language.startsWith('de')) setSelectedLanguage('german')
      else setSelectedLanguage('english')
    }

    i18n.on('languageChanged', handleLanguageChange)
    return () => i18n.off('languageChanged', handleLanguageChange)
  }, [])

  useEffect(() => {
    setProfileImage(user?.profile_picture || user?.profilePicture || '')
  }, [user?.profile_picture, user?.profilePicture])

  useEffect(() => {
    if (!profileImage) {
      setShowRemoveConfirmation(false)
    }
  }, [profileImage])

  useEffect(() => {
    if (activeSection !== 'security') return

    let cancelled = false

    const loadSessions = async () => {
      setIsSessionsLoading(true)
      setSessionsError('')

      try {
        const result = await userApi.getActiveSessions()
        if (!cancelled) {
          setActiveSessions(Array.isArray(result) ? result : [])
        }
      } catch (error) {
        if (!cancelled) {
          const detail = error?.response?.data?.detail
          setSessionsError(typeof detail === 'string' ? detail : 'Unable to load active sessions.')
        }
      } finally {
        if (!cancelled) {
          setIsSessionsLoading(false)
        }
      }
    }

    void loadSessions()

    return () => {
      cancelled = true
    }
  }, [activeSection])

  const refreshSessions = async () => {
    setIsSessionsLoading(true)
    setSessionsError('')

    try {
      const result = await userApi.getActiveSessions()
      setActiveSessions(Array.isArray(result) ? result : [])
    } catch (error) {
      const detail = error?.response?.data?.detail
      setSessionsError(typeof detail === 'string' ? detail : 'Unable to load active sessions.')
    } finally {
      setIsSessionsLoading(false)
    }
  }

  const handleLogoutAllOtherSessions = async () => {
    setSessionsError('')
    setSessionsMessage('')
    setSessionsActionLoadingId('ALL')

    try {
      const result = await userApi.logoutAllSessionsExceptCurrent()
      setSessionsMessage(result?.message || 'Other sessions logged out.')
      await refreshSessions()
    } catch (error) {
      const detail = error?.response?.data?.detail
      setSessionsError(typeof detail === 'string' ? detail : 'Unable to log out other sessions.')
    } finally {
      setSessionsActionLoadingId('')
    }
  }

  const handleLogoutSession = async (sessionId) => {
    setSessionsError('')
    setSessionsMessage('')
    setSessionsActionLoadingId(sessionId)

    try {
      const result = await userApi.logoutSession(sessionId)
      setSessionsMessage(result?.message || 'Session logged out.')
      await refreshSessions()
    } catch (error) {
      const detail = error?.response?.data?.detail
      setSessionsError(typeof detail === 'string' ? detail : 'Unable to log out session.')
    } finally {
      setSessionsActionLoadingId('')
    }
  }

  const confirmSessionAction = async () => {
    if (!sessionActionConfirmation) return

    const action = sessionActionConfirmation
    setSessionActionConfirmation(null)

    if (action.type === 'all') {
      await handleLogoutAllOtherSessions()
      return
    }

    if (action.type === 'single' && action.sessionId) {
      await handleLogoutSession(action.sessionId)
    }
  }

  const handleImageUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadMessage('')
    setIsUploadingImage(true)

    try {
      const result = await userApi.uploadProfileImage(file)
      const nextImageUrl = result?.profile_picture || result?.user?.profile_picture || ''

      if (nextImageUrl) {
        setProfileImage(nextImageUrl)
      }

      setShowRemoveConfirmation(false)

      const nextUser = result?.user || result || {
        ...user,
        profile_picture: nextImageUrl,
      }

      if (onUserUpdate && nextUser) {
        onUserUpdate(nextUser)
      }

      setUploadMessage('Profile picture uploaded successfully.')
    } catch (error) {
      const detail = error?.response?.data?.detail
      setUploadMessage(typeof detail === 'string' ? detail : 'Unable to upload profile picture.')
    } finally {
      setIsUploadingImage(false)
      event.target.value = ''
    }
  }

  const handleRemoveProfileImage = async () => {
    setUploadMessage('')
    setIsUploadingImage(true)

    try {
      const result = await userApi.removeProfileImage()
      setProfileImage('')
      setShowRemoveConfirmation(false)

      const nextUser = result?.user || result || {
        ...user,
        profile_picture: null,
      }

      if (onUserUpdate && nextUser) {
        onUserUpdate(nextUser)
      }

      setUploadMessage('Profile picture removed successfully.')
    } catch (error) {
      const detail = error?.response?.data?.detail
      setUploadMessage(typeof detail === 'string' ? detail : 'Unable to remove profile picture.')
    } finally {
      setIsUploadingImage(false)
    }
  }

  const retriggerPasswordError = (errors, message) => {
    setPasswordErrors({
      currentPassword: false,
      newPassword: false,
      confirmPassword: false,
    })
    setPasswordMessage('')
    setPasswordMessageType('')

    requestAnimationFrame(() => {
      setPasswordErrors(errors)
      setPasswordMessageType('error')
      setPasswordMessage(message)
    })
  }

  const handlePasswordChange = async (event) => {
    event.preventDefault()

    const nextErrors = {
      currentPassword: !passwordForm.currentPassword,
      newPassword: !passwordForm.newPassword,
      confirmPassword: !passwordForm.confirmPassword,
    }

    if (nextErrors.currentPassword || nextErrors.newPassword || nextErrors.confirmPassword) {
      retriggerPasswordError(nextErrors, 'Please fill all password fields.')
      return
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      retriggerPasswordError({
        currentPassword: false,
        newPassword: true,
        confirmPassword: true,
      }, 'New password and confirmation do not match.')
      return
    }

    if (!isStrongPassword(passwordForm.newPassword)) {
      retriggerPasswordError({
        currentPassword: false,
        newPassword: true,
        confirmPassword: false,
      }, PASSWORD_CRITERIA_MESSAGE)
      return
    }

    setPasswordErrors({
      currentPassword: false,
      newPassword: false,
      confirmPassword: false,
    })
    setPasswordMessage('')
    setPasswordMessageType('')

    try {
      const result = await userApi.changePassword({
        current_password: passwordForm.currentPassword,
        new_password: passwordForm.newPassword,
        confirm_password: passwordForm.confirmPassword,
      })

      setPasswordMessageType('success')
      setPasswordMessage(result?.message || 'Password updated successfully.')
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      setPasswordErrors({
        currentPassword: false,
        newPassword: false,
        confirmPassword: false,
      })
    } catch (error) {
      const detail = error?.response?.data?.detail

      if (typeof detail === 'string') {
        if (detail.toLowerCase().includes('current password')) {
          retriggerPasswordError({
            currentPassword: true,
            newPassword: false,
            confirmPassword: false,
          }, detail)
          return
        } else if (detail.toLowerCase().includes('match')) {
          retriggerPasswordError({
            currentPassword: false,
            newPassword: true,
            confirmPassword: true,
          }, detail)
          return
        } else if (detail.toLowerCase().includes('uppercase') || detail.toLowerCase().includes('digit') || detail.toLowerCase().includes('at least 8')) {
          retriggerPasswordError({
            currentPassword: false,
            newPassword: true,
            confirmPassword: false,
          }, PASSWORD_CRITERIA_MESSAGE)
          return
        } else {
          retriggerPasswordError({
            currentPassword: false,
            newPassword: true,
            confirmPassword: false,
          }, detail)
          return
        }
      } else {
        retriggerPasswordError({
          currentPassword: false,
          newPassword: false,
          confirmPassword: false,
        }, 'Unable to update password. Please try again.')
      }
    }
  }

  const renderSection = () => {
    if (activeSection === 'personal') {
      return (
        <div className="ga-section-content">
          <h2>{t('settings.personalInfo')}</h2>
          <div className="ga-personal-wrap">
            <div className="ga-info-list">
              <div className="ga-info-item">
                <h3>{t('settings.name')}</h3>
                <p className="ga-info-value">{user?.name || t('settings.guestUser')}</p>
              </div>

              <div className="ga-info-item">
                <h3>{t('settings.email')}</h3>
                <p className="ga-info-value">{user?.email || t('settings.noEmailAvailable')}</p>
              </div>

              <div className="ga-info-item">
                <h3>{t('settings.language')}</h3>
                <p className="ga-info-value">
                  {selectedLanguage === 'french'
                    ? t('settings.french')
                    : selectedLanguage === 'arabic'
                      ? t('settings.arabic')
                      : selectedLanguage === 'german'
                        ? t('settings.german')
                      : t('settings.english')}
                </p>
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (activeSection === 'security') {
      return (
        <div className="ga-section-content">
          <h2>{t('settings.privacySecurity')}</h2>
          <div className="security-block">
            <h3>{t('settings.lastLogin')}</h3>
            <p>{lastLogin}</p>
          </div>

          <div className="security-block">
            <button
              type="button"
              className="save-password-btn"
              onClick={() => {
                setShowPasswordForm((previous) => !previous)
                setPasswordMessage('')
              }}
            >
              {showPasswordForm ? t('settings.hideChangePassword') : t('settings.changePassword')}
            </button>

            {showPasswordForm ? (
              <form className="password-form" onSubmit={handlePasswordChange}>
                <div className="password-grid">
                  <input
                    type="password"
                    placeholder="Current password"
                    className={passwordErrors.currentPassword ? 'field-error' : ''}
                    value={passwordForm.currentPassword}
                    onChange={(event) => {
                      setPasswordForm((prev) => ({ ...prev, currentPassword: event.target.value }))
                      if (passwordErrors.currentPassword) {
                        setPasswordErrors((prev) => ({ ...prev, currentPassword: false }))
                      }
                    }}
                  />
                  <input
                    type="password"
                    placeholder="New password"
                    className={passwordErrors.newPassword ? 'field-error' : ''}
                    value={passwordForm.newPassword}
                    onChange={(event) => {
                      setPasswordForm((prev) => ({ ...prev, newPassword: event.target.value }))
                      if (passwordErrors.newPassword) {
                        setPasswordErrors((prev) => ({ ...prev, newPassword: false }))
                      }
                    }}
                  />
                  <input
                    type="password"
                    placeholder="Confirm new password"
                    className={passwordErrors.confirmPassword ? 'field-error' : ''}
                    value={passwordForm.confirmPassword}
                    onChange={(event) => {
                      setPasswordForm((prev) => ({ ...prev, confirmPassword: event.target.value }))
                      if (passwordErrors.confirmPassword) {
                        setPasswordErrors((prev) => ({ ...prev, confirmPassword: false }))
                      }
                    }}
                  />
                </div>
                {passwordMessage ? <p className={`password-message ${passwordMessageType === 'error' ? 'password-message-error' : ''}`}>{passwordMessage}</p> : null}
                <button type="submit" className="save-password-btn password-submit-btn">{t('settings.updatePassword')}</button>
              </form>
            ) : null}
          </div>

          <div className="security-block">
            <div className="sessions-header-row">
              <h3>Active sessions</h3>
              <button
                type="button"
                className="upload-btn sessions-action-btn"
                disabled={isSessionsLoading || sessionsActionLoadingId === 'ALL'}
                onClick={() => setSessionActionConfirmation({ type: 'all' })}
              >
                {sessionsActionLoadingId === 'ALL' ? 'Logging out...' : 'Log out all others'}
              </button>
            </div>

            {sessionsError ? <p className="password-message password-message-error">{sessionsError}</p> : null}
            {sessionsMessage ? <p className="password-message">{sessionsMessage}</p> : null}

            {isSessionsLoading ? (
              <p>Loading sessions...</p>
            ) : activeSessions.length === 0 ? (
              <p>No active sessions found.</p>
            ) : (
              <div className="sessions-list">
                {activeSessions.map((session) => (
                  <div key={session.session_id} className="ga-info-item session-item">
                    <div className="session-item-main">
                      <p className="session-device">{session.device_info || 'Unknown device'}</p>
                      <p className="session-meta">IP: {session.ip_address || 'Unknown'}</p>
                      <p className="session-meta">Started: {formatSessionDate(session.created_at)}</p>
                      <p className="session-meta">Last activity: {formatSessionDate(session.last_activity)}</p>
                    </div>
                    <div className="session-item-actions">
                      {session.current ? <span className="session-current-badge">Current</span> : null}
                      {!session.current ? (
                        <button
                          type="button"
                          className="upload-btn sessions-logout-btn"
                          disabled={sessionsActionLoadingId === session.session_id}
                          onClick={() => setSessionActionConfirmation({
                            type: 'single',
                            sessionId: session.session_id,
                            deviceInfo: session.device_info || 'this session',
                          })}
                        >
                          {sessionsActionLoadingId === session.session_id ? 'Logging out...' : 'Log out'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )
    }

    if (activeSection === 'language') {
      return (
        <div className="ga-section-content">
          <h2>{t('settings.language')}</h2>
          <div className="language-choice-grid">
            <button
              type="button"
              className={`language-choice-btn ${selectedLanguage === 'french' ? 'language-choice-btn--active' : ''}`}
              onClick={() => {
                setSelectedLanguage('french')
                i18n.changeLanguage('fr')
              }}
            >
              <LanguageFlag language="french" />
              <span>{t('settings.french')}</span>
            </button>
            <button
              type="button"
              className={`language-choice-btn ${selectedLanguage === 'english' ? 'language-choice-btn--active' : ''}`}
              onClick={() => {
                setSelectedLanguage('english')
                i18n.changeLanguage('en')
              }}
            >
              <LanguageFlag language="english" />
              <span>{t('settings.english')}</span>
            </button>
            <button
              type="button"
              className={`language-choice-btn ${selectedLanguage === 'arabic' ? 'language-choice-btn--active' : ''}`}
              onClick={() => {
                setSelectedLanguage('arabic')
                i18n.changeLanguage('ar')
              }}
            >
              <LanguageFlag language="arabic" />
              <span>{t('settings.arabic')}</span>
            </button>
            <button
              type="button"
              className={`language-choice-btn ${selectedLanguage === 'german' ? 'language-choice-btn--active' : ''}`}
              onClick={() => {
                setSelectedLanguage('german')
                i18n.changeLanguage('de')
              }}
            >
              <LanguageFlag language="german" />
              <span>{t('settings.german')}</span>
            </button>
          </div>
        </div>
      )
    }

    return null
  }

  return (
    <div className="ga-page">
      <header className="ga-topbar">
        <div className="ga-brand-row">
          <button className="settings-back-btn" type="button" onClick={onBack}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
            </svg>
            <span>{t('app.back')}</span>
          </button>
          <h1 className="ga-brand">{t('app.account')}</h1>
        </div>
      </header>

      <main className="ga-layout">
        <aside className="ga-sidebar">
          <button className={`ga-nav-item ${activeSection === 'personal' ? 'active' : ''}`} type="button" onClick={() => setActiveSection('personal')}>
            <span className="ga-nav-dot dot-personal">&#9783;</span>
            <span>{t('settings.personalInfo')}</span>
          </button>
          <button className={`ga-nav-item ${activeSection === 'security' ? 'active' : ''}`} type="button" onClick={() => setActiveSection('security')}>
            <span className="ga-nav-dot dot-security">&#128274;</span>
            <span>{t('settings.privacySecurity')}</span>
          </button>
          <button className={`ga-nav-item ${activeSection === 'language' ? 'active' : ''}`} type="button" onClick={() => setActiveSection('language')}>
            <span className="ga-nav-dot dot-language">&#127760;</span>
            <span>{t('settings.language')}</span>
          </button>
        </aside>

        <section className="ga-main">
          <div className="ga-profile-hero">
            {profileImage ? (
              <label
                className="ga-hero-avatar-wrap"
                htmlFor="profile-upload-input"
                aria-label={t('settings.uploadProfilePic')}
                title={t('settings.uploadProfilePic')}
              >
                <img className="profile-avatar ga-hero-avatar" src={profileImage} alt="Profile" />
                <span className="ga-hero-avatar-camera" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M18 7h-1.2l-1.1-1.6A2 2 0 0 0 14 4h-4a2 2 0 0 0-1.7 1.4L7.2 7H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Zm-6 8.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Zm0-1.4A2.1 2.1 0 1 0 9.9 12 2.1 2.1 0 0 0 12 14.1ZM18 10.2a1.1 1.1 0 1 1-1.1-1.1A1.1 1.1 0 0 1 18 10.2Z" />
                  </svg>
                </span>
              </label>
            ) : (
              <div className="profile-avatar profile-avatar-fallback ga-hero-avatar">{getInitials(user?.name)}</div>
            )}
            <h2 className="ga-hero-name">{user?.name || t('settings.guestUser')}</h2>
            <p className="ga-hero-email">{user?.email || t('settings.noEmailAvailable')}</p>
          </div>

          {renderSection()}
        </section>
      </main>

      <p className="ga-bottom-note">
        {t('app.onlyYouSeeSettings')}
      </p>

      {showRemoveConfirmation ? (
        <div className="profile-remove-modal-backdrop" onClick={() => setShowRemoveConfirmation(false)}>
          <div
            className="profile-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm profile picture removal"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Remove profile picture?</h3>
            <p>This action removes your current photo. You can upload another one anytime.</p>
            <div className="profile-remove-modal-actions">
              <button
                type="button"
                className="upload-btn cancel-remove-btn"
                disabled={isUploadingImage}
                onClick={() => setShowRemoveConfirmation(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="upload-btn confirm-remove-btn"
                disabled={isUploadingImage || !profileImage}
                onClick={handleRemoveProfileImage}
              >
                Confirm remove
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sessionActionConfirmation ? (
        <div className="profile-remove-modal-backdrop" onClick={() => setSessionActionConfirmation(null)}>
          <div
            className="profile-remove-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm session logout"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>
              {sessionActionConfirmation.type === 'all'
                ? 'Log out all other sessions?'
                : 'Log out this session?'}
            </h3>
            <p>
              {sessionActionConfirmation.type === 'all'
                ? 'This will keep only your current session active on this device.'
                : `You are about to log out ${sessionActionConfirmation.deviceInfo}.`}
            </p>
            <div className="profile-remove-modal-actions">
              <button
                type="button"
                className="upload-btn cancel-remove-btn"
                onClick={() => setSessionActionConfirmation(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="upload-btn confirm-remove-btn"
                onClick={confirmSessionAction}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default SettingsPage
