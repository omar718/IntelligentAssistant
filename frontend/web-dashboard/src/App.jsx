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
  const [cloneDir, setCloneDir] = useState('')

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
      {currentPage === 'home' ? (
        <CodeStart onAnalyze={handleAnalyze} />
      ) : (
        <Processing gitUrl={gitUrl} cloneDir={cloneDir} onBack={handleBack} />
      )}
    </>
  )
}

export default App
