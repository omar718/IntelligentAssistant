import { useState } from 'react'
import CodeStart from './components/CodeStart'
import Processing from './components/Processing'

function App() {
  const [currentPage, setCurrentPage] = useState('home') // 'home' or 'processing'
  const [gitUrl, setGitUrl] = useState('')

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
      {currentPage === 'home' ? (
        <CodeStart onAnalyze={handleAnalyze} />
      ) : (
        <Processing gitUrl={gitUrl} onBack={handleBack} />
      )}
    </>
  )
}

export default App
