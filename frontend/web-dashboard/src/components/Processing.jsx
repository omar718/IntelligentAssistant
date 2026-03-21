import { useState, useEffect, useRef } from 'react'
import { projectsApi } from '../api/client'
import '../styles/Processing.css'

function Processing({ gitUrl, cloneDir, onBack }) {
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState(null)
  const [isCancelling, setIsCancelling] = useState(false)

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
    const taskId = taskIdRef.current

    const completeFromTaskStatus = (status) => {
      if (finished || stopped) return
      finished = true
      if (pollInterval) clearInterval(pollInterval)

      if ((status.stage || '').toLowerCase() === 'failed' || status.error) {
        setError(status.error || 'Project creation failed.')
        return
      }

      setCompleted(true)

      if (status.host_path) {
        const normalizedPath = status.host_path.replace(/\\/g, '/')
        fetch('http://localhost:6009/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: status.host_path }),
        }).catch(() => {
          window.location.href = `vscode://file/${normalizedPath}`
        })
      }

      setTimeout(onBack, 2500)
    }

    const applyTaskStatus = (status) => {
      if (status.error) {
        setError(status.error)
      }

      if (status.done) {
        completeFromTaskStatus(status)
      }
    }

    const pollTask = async () => {
      try {
        const status = await projectsApi.getTaskStatus(taskId)
        if (stopped) return
        notFoundCount = 0
        applyTaskStatus(status)
      } catch (err) {
        if (stopped) return
        if (err?.response?.status === 404) {
          notFoundCount += 1
          if (createFailed && notFoundCount >= 20) {
            if (pollInterval) clearInterval(pollInterval)
            setError('Task status not found after project start.')
          }
          return
        }
        if (!finished) {
          console.error('Task polling failed:', err)
        }
      }
    }

    const startHandle = setTimeout(() => {
      if (stopped) return

      pollInterval = setInterval(pollTask, 700)

      void pollTask()

      projectsApi
        .create({ source: { type: 'git', url: gitUrl, clone_dir: cloneDir || undefined }, task_id: taskId })
        .then(result => {
          if (stopped || finished) return
          completeFromTaskStatus({ done: true, stage: 'launching', host_path: result?.host_path })
        })
        .catch(err => {
          if (stopped) return
          createFailed = true
          console.warn('Project create request failed, continuing with task polling:', err)
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
      setError(err?.response?.data?.detail || 'Could not cancel task.')
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
          <h1 className="processing-title">Getting everything ready...</h1>
          <p className="processing-repo">{gitUrl}</p>

          {!completed && !error && (
            <>
              <p className="in-progress-blink">IN PROGRESS</p>
              <button className="processing-cancel-btn" onClick={handleCancel} disabled={isCancelling}>
                {isCancelling ? 'Cancelling...' : 'Cancel'}
              </button>
            </>
          )}

          {completed && (
            <p className="completion-text">
              Opening in VS code...
            </p>
          )}

          {error && (
            <div className="error-text">
              <p>Error: {error}</p>
              <button onClick={onBack}>Go back</button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default Processing
