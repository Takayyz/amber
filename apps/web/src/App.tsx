import { AuthProvider, useAuth } from '@/lib/auth-context'
import { LoginScreen } from '@/components/login-screen'
import { AuthenticatedStatus } from '@/components/authenticated-status'

function AppContent() {
  const { session, loading } = useAuth()

  if (loading) {
    return null
  }

  return session ? <AuthenticatedStatus /> : <LoginScreen />
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

export default App
