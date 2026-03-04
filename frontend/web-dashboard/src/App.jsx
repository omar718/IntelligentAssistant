import { useState } from 'react'
import CodeStart from './components/CodeStart'
import Processing from './components/Processing'
import ProjectsList from './components/ProjectsList'
import VSCodeModal from './components/VSCodeModal'

function App() {
  const [currentPage, setCurrentPage] = useState('home') // 'home' | 'processing' | 'projects'
  const [gitUrl, setGitUrl] = useState('')
  const [showVSCodeModal, setShowVSCodeModal] = useState(false)

  const handleAnalyze = (url, dir) => {
    setGitUrl(url)
    setCloneDir(dir)
    setCurrentPage('processing')
  }

  const handleBack = () => {
    setCurrentPage('home')
    setGitUrl('')
    setCloneDir('')
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

      {showVSCodeModal && (
        <VSCodeModal onClose={() => setShowVSCodeModal(false)} />
      )}
    </>
  )
}

export default App
