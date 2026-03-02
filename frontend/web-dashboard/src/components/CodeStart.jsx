import { useState } from 'react'
import '../styles/CodeStart.css'

function CodeStart({ onAnalyze }) {
  const [gitUrl, setGitUrl] = useState('')
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)

  const handleAnalyze = async () => {
    if (!gitUrl.trim()) {
      setError('please paste the URL from your GIT repository!')
      return
    }
    setError('')
    setPicking(true)
    try {
      const res = await fetch('http://localhost:6009/pick-folder')
      if (res.status === 204) {
        // User cancelled the picker
        setPicking(false)
        return
      }
      const data = await res.json()
      setPicking(false)
      onAnalyze(gitUrl, data.path || undefined)
    } catch {
      setPicking(false)
      setError(
        'Could not open folder picker — make sure the VS Code extension is running (press F5 in VS Code), then try again.'
      )
    }
  }

  return (
    <div className="codestart-container">
      <header className="codestart-header">
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

      <main className="codestart-main">
        <h1 className="codestart-title">
          Install and Launch your web project in seconds.
        </h1>
        <p className="codestart-subtitle">
          The intelligent assistant analyzes, configures the dependencies and automatically launches the project 
        </p>

        <div className="codestart-content">
          {/* Git Import Section */}
          <div className="codestart-section git-section">
            <div className="section-header">
              <h2 className="section-title">Import from GitHub</h2>
              <button 
                className="git-icon-button"
                onClick={() => window.open('https://github.com', '_blank')}
                title="Visit GitHub"
              >
                <svg className="git-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v 3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
              </button>
            </div>
            <div className="git-input-wrapper">
              <input
                type="text"
                className="git-input"
                placeholder="https://github.com/username/repo.git"
                value={gitUrl}
                onChange={(e) => {
                  setGitUrl(e.target.value)
                  setError('')
                }}
                onKeyPress={(e) => e.key === 'Enter' && handleAnalyze()}
              />
            </div>
            {error && <p className="error-message">{error}</p>}
            <button className="analyze-button" onClick={handleAnalyze} disabled={picking}>
              {picking ? 'Waiting for folder selection...' : 'Launch'}
            </button>
          </div>

          {/* Archive Upload Section */}
          
        </div>
      </main>
    </div>
  )
}

export default CodeStart
