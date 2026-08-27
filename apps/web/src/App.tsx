import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/lib/auth-context'
import { ThemeProvider } from '@/lib/theme-context'
import { MemberNameProvider } from '@/lib/member-name-context'
import { LoginScreen } from '@/components/login-screen'
import { HomeScreen } from '@/components/home-screen'
import { AlbumDetailScreen } from '@/components/album-detail-screen'
import { MediaDetailScreen } from '@/components/media-detail-screen'
import { SearchScreen } from '@/components/search-screen'
import { TrashScreen } from '@/components/trash-screen'

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
      <Route path="/albums/:albumId/items/:mediaItemId" element={<MediaDetailScreen />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/trash" element={<TrashScreen />} />
    </Routes>
  )
}

function App() {
  return (
    // Outside the auth boundary: the login screen is themed too, and the
    // choice belongs to the device rather than to whoever is signed in.
    <ThemeProvider>
      <AuthProvider>
        {/* Inside the auth boundary, unlike the theme: the name belongs to
            whoever is signed in, and there is nobody to name before that. */}
        <MemberNameProvider>
          <BrowserRouter>
            <AppContent />
          </BrowserRouter>
        </MemberNameProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
