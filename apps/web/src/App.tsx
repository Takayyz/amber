import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/lib/auth-context'
import { LoginScreen } from '@/components/login-screen'
import { HomeScreen } from '@/components/home-screen'
import { AlbumDetailScreen } from '@/components/album-detail-screen'

function AppContent() {
  const { session, loading } = useAuth()

  if (loading) {
    return null
  }

  if (!session) {
    return <LoginScreen />
  }

  return (
    <Routes>
      <Route path="/" element={<HomeScreen />} />
      <Route path="/albums/:albumId" element={<AlbumDetailScreen />} />
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
