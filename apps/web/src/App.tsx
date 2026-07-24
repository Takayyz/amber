import { AuthProvider, useAuth } from '@/lib/auth-context'
import { LoginScreen } from '@/components/login-screen'
import { HomeScreen } from '@/components/home-screen'

function AppContent() {
  const { session, loading } = useAuth()

  if (loading) {
    return null
  }

  return session ? <HomeScreen /> : <LoginScreen />
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

export default App
