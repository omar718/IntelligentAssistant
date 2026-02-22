import { useState } from 'react'
import '../styles/CodeStart.css'

function CodeStart({ onAnalyze }) {
  const [gitUrl, setGitUrl] = useState('')
  const [dragActive, setDragActive] = useState(false)

  const handleAnalyze = () => {
    if (gitUrl.trim()) {
      onAnalyze(gitUrl)
    }
  }

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    console.log('Files dropped:', e.dataTransfer.files)
    // Add your logic here
  }

  return (
    <div className="codestart-container">
      <header className="codestart-header">
        <div className="logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">CodeStart AI</span>
        </div>
      </header>

      <main className="codestart-main">
        <h1 className="codestart-title">
          Démarrez n'importe quel projet web en secondes.
        </h1>
        <p className="codestart-subtitle">
          L'IA Analyse, Installe et Lance votre code. Plus de configurations interminable
        </p>

        <div className="codestart-content">
          {/* Git Import Section */}
          <div className="codestart-section git-section">
            <h2 className="section-title">Importer depuis Git</h2>
            <div className="git-input-wrapper">
              <svg className="git-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v 3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              <input
                type="text"
                className="git-input"
                placeholder="https://github.com/username/repo.git"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAnalyze()}
              />
            </div>
            <button className="analyze-button" onClick={handleAnalyze}>
              Analyser le dépôt
            </button>
          </div>

          {/* Archive Upload Section */}
          
        </div>
      </main>
    </div>
  )
}

export default CodeStart
