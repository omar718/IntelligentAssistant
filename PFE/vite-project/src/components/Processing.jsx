import { useState, useEffect } from 'react'
import '../styles/Processing.css'

function Processing({ gitUrl, onBack }) {
  const [progress, setProgress] = useState(0)
  const [step, setStep] = useState(0)
  const [completed, setCompleted] = useState(false)

  const steps = [
    'Clonage du dépôt...',
    'Analyse du projecte...',
    'Ouverture dans VS Code...'
  ]

  useEffect(() => {
    if (progress >= 100) {
      setCompleted(true)
      // Simulate opening VS Code after completion
      setTimeout(() => {
        // In a real application, you would use electron or a backend API
        // to open VS Code with the project
        window.open('vscode://file/path/to/project', '_blank')
        onBack()
      }, 2000)
      return
    }

    const interval = setInterval(() => {
      setProgress(prev => {
        const next = prev + Math.random() * 30
        if (next >= 100) {
          setStep(steps.length - 1)
          return 100
        }
        // Update step based on progress
        const newStep = Math.floor((next / 100) * steps.length)
        setStep(Math.min(newStep, steps.length - 1))
        return next
      })
    }, 800)

    return () => clearInterval(interval)
  }, [progress, onBack])

  return (
    <div className="processing-container">
      <header className="processing-header">
        <div className="logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">CodeStart AI</span>
        </div>
      </header>

      <main className="processing-main">
        <div className="processing-box">
          <h1 className="processing-title">En cours de traitement</h1>
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
              Ouverture de VS Code...
            </p>
          )}
        </div>
      </main>
    </div>
  )
}

export default Processing
