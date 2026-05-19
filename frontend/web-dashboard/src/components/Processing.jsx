import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../api/client'
import '../styles/Processing.css'

function Processing({ gitUrl, cloneDir, onBack, onVSCodeNotFound, onError }) {
  const { t } = useTranslation()
  const [completed, setCompleted] = useState(false)
  const [showSuccessPopup, setShowSuccessPopup] = useState(false)
  const [error, setError] = useState(null)
  const [isCancelling, setIsCancelling] = useState(false)
  const [taskProgress, setTaskProgress] = useState(0)
  const [taskMessage, setTaskMessage] = useState('Queued...')

  const taskIdRef = useRef(
    (window.crypto?.randomUUID
      ? `task_${window.crypto.randomUUID()}`
      : `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)
  )

  useEffect(() => {
    let stopped = false
    let finished = false
    let createFailed = false
    let notFoundCount = 0
    let pollInterval = null
    let errorCount = 0
    const maxErrors = 10
    const taskId = taskIdRef.current
    const startTime = Date.now()
    const maxDuration = 10 * 60 * 1000

    console.log('[Processing] Component mounted with:', { gitUrl, cloneDir, taskId })

    const completeFromTaskStatus = (status) => {
      if (finished || stopped) return
      finished = true
      if (pollInterval) clearInterval(pollInterval)

      if ((status.stage || '').toLowerCase() === 'failed' || status.error) {
        setError(status.error || t('processing.projectCreationFailed'))
        return
      }

      setCompleted(true)
      setShowSuccessPopup(true)

      if (status.host_path) {
        fetch('http://localhost:6009/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: status.host_path, project_id: status.project_id }),
        }).catch(() => {
          if (onVSCodeNotFound) onVSCodeNotFound()
        })
      }
    }

    const applyTaskStatus = (status) => {
      const numericProgress = Number(status?.progress)
      if (!Number.isNaN(numericProgress)) {
        setTaskProgress(Math.max(0, Math.min(100, numericProgress)))
        console.log('[Processing] Progress update:', numericProgress)
      }
      if (status?.message) {
        setTaskMessage(status.message)
      }

      if (status.error) {
        setError(status.error)
      }

      if (status.done) {
        completeFromTaskStatus(status)
      }
    }

    const pollTask = async () => {
      if (finished || stopped) return
      
      // Safety: stop if too long (10+ minutes)
      if (Date.now() - startTime > maxDuration) {
        finished = true
        if (pollInterval) clearInterval(pollInterval)
        console.log('[Processing] Polling exceeded 10 minute timeout')
        setError(t('processing.taskTookTooLong'))
        return
      }
      
      try {
        const status = await projectsApi.getTaskStatus(taskId)
        if (stopped || finished) return
        errorCount = 0  // Reset error count on success
        notFoundCount = 0
        applyTaskStatus(status)
      } catch (err) {
        if (stopped || finished) return
        
        errorCount++
        const statusCode = err?.response?.status
        const errMsg = err?.response?.data?.detail || err?.message || String(err)
        
        console.log('[Processing] Poll error:', { errorCount, statusCode, errMsg })
        
        // Check for auth errors more robustly
        if (statusCode === 401 || statusCode === 403 || errMsg?.includes('invalid') || errMsg?.includes('expired')) {
          finished = true
          if (pollInterval) clearInterval(pollInterval)
          console.log('[Processing] Auth error detected, stopping poll:', { statusCode, errMsg })
          setError(t('processing.sessionExpired'))
          return
        }
        
        // Handle 404 (Not Found) with retries (backend might be slow to write to Redis)
        if (statusCode === 404) {
          notFoundCount += 1
          if (notFoundCount >= 15) { // Wait ~10 seconds (15 * 700ms)
            finished = true
            if (pollInterval) clearInterval(pollInterval)
            setError(t('processing.taskNotFound'))
          }
          return
        }

        // Stop after too many other errors (likely broken connection)
        if (errorCount >= maxErrors) {
          finished = true
          if (pollInterval) clearInterval(pollInterval)
          console.log('[Processing] Too many poll errors, stopping')
          setError(`${t('processing.pollingFailed')} ${errMsg}`)
          return
        }
        
        if (!finished) {
          console.error('[Processing] Task polling error:', { statusCode, errMsg, err })
        }
      }
    }

    const startHandle = setTimeout(() => {
      if (stopped) return

      pollInterval = setInterval(pollTask, 700)

      void pollTask()

      const createPayload = { source: { type: 'git', url: gitUrl, clone_dir: cloneDir || undefined }, task_id: taskId }
      console.log('[Processing] Calling projectsApi.create with:', createPayload)
      
      projectsApi
        .create(createPayload)
        .then(result => {
          console.log('[Processing] projectsApi.create succeeded:', result)
          if (stopped || finished) return
          completeFromTaskStatus({
            done: true,
            stage: 'launching',
            host_path: result?.host_path,
            project_id: result?.project_id,
          })
        })
        .catch(err => {
          if (stopped) return
          createFailed = true
          const statusCode = err?.response?.status
          const detail = err?.response?.data?.detail || err?.message || String(err)
          console.error('[Processing] Project create request failed:', { statusCode, detail, err })
          
          if (statusCode === 401 || statusCode === 403 || detail?.includes('invalid') || detail?.includes('expired')) {
            finished = true
            if (pollInterval) clearInterval(pollInterval)
            setError(t('processing.sessionExpired'))
            return
          }

          // Check for repo-not-found error ("is not found!")
          if (detail && detail.includes('is not found!')) {
            console.log('[Processing] Detected repo-not-found error, routing back to CodeStart')
            finished = true
            if (pollInterval) clearInterval(pollInterval)
            if (onError) {
              // Call onError to route back to CodeStart with error message
              onError(detail)
              onBack()
            }
            return
          }
          
          if (detail && !finished) {
            setError(`${t('processing.projectRequestFailed')} ${detail}`)
            if (pollInterval) clearInterval(pollInterval)
          }
        })
    }, 0)

    return () => {
      stopped = true
      clearTimeout(startHandle)
      if (pollInterval) clearInterval(pollInterval)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = async () => {
    if (isCancelling || completed) return
    setIsCancelling(true)
    try {
      await projectsApi.cancelTask(taskIdRef.current)
      onBack()
    } catch (err) {
      setError(err?.response?.data?.detail || t('processing.couldNotCancelTask'))
      setIsCancelling(false)
    }
  }

  return (
    <div className="processing-container">
      <header className="processing-header">
        <div className="logo">
          <svg className="logo-icon-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="48" fill="none" stroke="#fff" strokeWidth="2"/>
            <rect x="25" y="20" width="50" height="35" rx="2" fill="none" stroke="#fff" strokeWidth="2"/>
            <rect x="28" y="23" width="44" height="29" fill="none" stroke="#fff" strokeWidth="1.5"/>
            <circle cx="33" cy="28" r="2.5" fill="#fff"/>
            <circle cx="33" cy="33" r="2.5" fill="#fff"/>
            <circle cx="33" cy="38" r="2.5" fill="#fff"/>
            <line x1="36" y1="28" x2="44" y2="28" stroke="#fff" strokeWidth="1.5"/>
            <line x1="36" y1="33" x2="44" y2="33" stroke="#fff" strokeWidth="1.5"/>
            <line x1="36" y1="38" x2="44" y2="38" stroke="#fff" strokeWidth="1.5"/>
            <rect x="46" y="35" width="3" height="10" fill="#fff"/>
            <rect x="51" y="31" width="3" height="14" fill="#fff"/>
            <rect x="56" y="27" width="3" height="18" fill="#fff"/>
            <rect x="61" y="24" width="3" height="21" fill="#fff"/>
            <path d="M20 58C20 58 20 60 22 60H78C80 60 80 58 80 58M28 60H72C72 63 70 65 67 65H33C30 65 28 63 28 60" fill="none" stroke="#fff" strokeWidth="2"/>
          </svg>
          <span className="logo-text"> </span>
        </div>
      </header>

      <main className="processing-main">
        <div className="processing-box">
          <h1 className="processing-title">{t('processing.gettingEverythingReady')}</h1>
          <p className="processing-repo">{gitUrl}</p>

          {!completed && !error && (
            <>
              <p className="in-progress-blink">{t('processing.inProgress')}</p>
              <p className="processing-repo">{t('processing.progress')}: {taskProgress.toFixed(1)}%</p>
              <p className="processing-repo">{taskMessage}</p>
              <button className="processing-cancel-btn" onClick={handleCancel} disabled={isCancelling}>
                {isCancelling ? t('processing.cancelling') : t('processing.cancel')}
              </button>
            </>
          )}

          {completed && (
            <p className="completion-text">
              {t('processing.openingInVsCode')}
            </p>
          )}

          {error && (
            <div className="error-text">
              <p>{t('processing.errorPrefix')} {error}</p>
              <button onClick={onBack}>{t('processing.goBack')}</button>
            </div>
          )}
        </div>
      </main>

      {showSuccessPopup && (
        <div className="processing-popup-overlay" role="dialog" aria-modal="true" aria-labelledby="success-popup-title">
          <div className="processing-popup-card">
            <h2 id="success-popup-title" className="processing-popup-title">{t('processing.openSuccess')}</h2>
            <p className="processing-popup-message">{t('processing.openSuccessMessage')}</p>
            <button
              className="processing-popup-btn"
              onClick={() => {
                setShowSuccessPopup(false)
                onBack()
              }}
            >
              {t('processing.backHome')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default Processing
