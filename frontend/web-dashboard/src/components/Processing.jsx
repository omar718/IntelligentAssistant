import { useState, useEffect, useRef } from 'react'
import { projectsApi } from '../api/client'
import '../styles/Processing.css'

function Processing({ gitUrl, cloneDir, onBack }) {
  const [progress, setProgress] = useState(0)
  const [step, setStep] = useState(0)
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState(null)
  const called = useRef(false)

  const steps = [
    'Cloning repository...',
    'Analyzing project...',
    'Launching VS Code...',
  ]

  useEffect(() => {
    if (called.current) return
    called.current = true

    // Animate progress while the API request is in flight.
    // Cap at 90 % so the bar only hits 100 % on real success.
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 90) return prev
        const next = prev + Math.random() * 8
        const capped = Math.min(next, 90)
        const newStep = Math.min(Math.floor((capped / 100) * steps.length), steps.length - 2)
        setStep(newStep)
        return capped
      })
    }, 600)

    projectsApi
      .create({ source: { type: 'git', url: gitUrl, clone_dir: cloneDir || undefined } })
      .then(result => {
        clearInterval(interval)
        setStep(steps.length - 1)
        setProgress(100)
        setCompleted(true)
        // Open the cloned project in a new VS Code window.
        // Primary: ask the VS Code extension's local server to open the folder —
        // this uses the real extension API which supports forceNewWindow.
        // Fallback: vscode://file/ URI (opens in the current window).
        if (result.host_path) {
          const normalizedPath = result.host_path.replace(/\\/g, '/')
          fetch('http://localhost:6009/open-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: result.host_path }),
          }).catch(() => {
            // Extension server not running — fall back to URI scheme
            window.location.href = `vscode://file/${normalizedPath}`
          })
        }
        setTimeout(onBack, 2500)
      })
      .catch(err => {
        clearInterval(interval)
        setError(err?.response?.data?.detail || err.message || 'Something went wrong.')
      })

    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

          <div className="processing-steps">
            {steps.map((stepText, index) => (
              <div
                key={index}
                className={`step ${index <= step ? 'active' : ''} ${
                  index < step ? 'completed' : ''
                }`}
              >
                <div className="step-indicator">
                  {index < step ? (
                    <span className="checkmark">✓</span>
                  ) : (
                    <span className="step-number">{index + 1}</span>
                  )}
                </div>
                <span className="step-text">{stepText}</span>
              </div>
            ))}
          </div>

          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
          <p className="progress-text">{Math.floor(progress)}%</p>

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
