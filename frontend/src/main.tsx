import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The archive is a single-user, single-writer store on local disk. Data
      // does not change behind the user's back, so refetching on every window
      // focus is pure cost -- and on a 3,839-card list, a visible one.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})

// Vite's BASE_URL is '/' since the cut-over (vite.config.ts), and was '/next/'
// during the overlap. Deriving the router's basename from it means the flip is
// one line in one file, and deep links keep working on both sides of it.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
