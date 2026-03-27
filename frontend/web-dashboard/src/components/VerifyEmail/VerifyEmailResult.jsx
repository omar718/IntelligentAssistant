import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { authApi } from '../../api/client'
import CodeStart from '../CodeStart'
import VerifyEmailSuccessOverlay from './VerifyEmailSuccessOverlay'
import VerifyEmailInvalidLinkOverlay from './VerifyEmailInvalidLinkOverlay'
import VerifyEmailNotFoundOverlay from './VerifyEmailNotFoundOverlay'

function VerifyEmailResult() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [statusCode, setStatusCode] = useState(null)
  const [user] = useState(() => {
    const saved = localStorage.getItem('user')
    return saved ? JSON.parse(saved) : null
  })

  useEffect(() => {
    let mounted = true

    const verify = async () => {
      const token = searchParams.get('token')
      if (!token) {
        if (mounted) setStatusCode(400)
        return
      }

      try {
        await authApi.verifyEmail(token)
        if (mounted) setStatusCode(200)
      } catch (err) {
        const code = err?.response?.status
        if (!mounted) return

        if (code === 404) {
          setStatusCode(404)
          return
        }

        if (code === 400) {
          setStatusCode(400)
          return
        }

        setStatusCode(400)
      }
    }

    void verify()
    return () => {
      mounted = false
    }
  }, [searchParams])

  return (
    <>
      <CodeStart
        onAnalyze={() => {}}
        onNavigate={() => {}}
        user={user}
        onLogin={() => {}}
        onLogout={() => {}}
      />

      {statusCode === 200 && <VerifyEmailSuccessOverlay onGoLogin={() => navigate('/?auth=login')} />}
      {statusCode === 404 && <VerifyEmailNotFoundOverlay onBackHome={() => navigate('/')} />}
      {statusCode === 400 && <VerifyEmailInvalidLinkOverlay onBackHome={() => navigate('/')} />}

      {statusCode === null && (
        <div className="auth-modal-overlay">
          <div className="auth-card">
            <h1 className="auth-title">Verifying...</h1>
            <p className="auth-subtitle">Please wait while we verify your email link.</p>
          </div>
        </div>
      )}
    </>
  )
}

export default VerifyEmailResult
