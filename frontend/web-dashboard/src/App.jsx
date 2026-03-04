import { useState } from 'react'
import CodeStart from './components/CodeStart'
import Processing from './components/Processing'
import ProjectsList from './components/ProjectsList'
import VSCodeModal from './components/VSCodeModal'
import Login from './components/Login'
import Signup from './components/Signup'

function App() {
  const [currentPage, setCurrentPage] = useState('home') // 'home' | 'processing' | 'projects' | 'login' | 'signup'
  const [gitUrl, setGitUrl] = useState('')
  const [showVSCodeModal, setShowVSCodeModal] = useState(false)

  const handleAnalyze = (url) => {
    setGitUrl(url)
    setCurrentPage('processing')
  }

  const handleBack = () => {
    setCurrentPage('home')
    setGitUrl('')
  }

  return (
    <>
      {currentPage === 'home' && (
        <CodeStart onAnalyze={handleAnalyze} onNavigate={setCurrentPage} />
      )}
      {currentPage === 'processing' && (
        <Processing
          gitUrl={gitUrl}
          onBack={handleBack}
          onVSCodeNotFound={() => setShowVSCodeModal(true)}
        />
      )}
      {currentPage === 'projects' && (
        <ProjectsList onBack={() => setCurrentPage('home')} />
      )}
      {currentPage === 'login' && (
        <Login onNavigate={setCurrentPage} />
      )}
      {currentPage === 'signup' && (
        <Signup onNavigate={setCurrentPage} />
      )}

      {showVSCodeModal && (
        <VSCodeModal onClose={() => setShowVSCodeModal(false)} />
      )}
    </>
  )
}

export default App
