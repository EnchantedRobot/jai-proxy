import { Route, Routes } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { CharactersPage } from '@/pages/CharactersPage'
import { CharacterDetailPage } from '@/pages/CharacterDetailPage'
import { TagsPage } from '@/pages/TagsPage'
import { DiscoverPage } from '@/pages/DiscoverPage'
import { DiscoverPreviewPage } from '@/pages/DiscoverPreviewPage'
import { SettingsPage } from '@/pages/SettingsPage'

/**
 * The route table (docs/UI_REWRITE_PLAN.md §4.1) — every stage's route now
 * present: Stage 1 is Characters and Favorites, Stage 2 adds the detail
 * route, Stage 4 adds Tags, Stage 5 adds Discover, Stage 6 adds Settings.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<CharactersPage />} />
        <Route path="/favorites" element={<CharactersPage favorites />} />
        <Route path="/characters/:id" element={<CharacterDetailPage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        {/* A provider card, read before it is kept. Deep-linkable like the
            archive's own detail route, and carrying the Discover query string
            so prev/next steps through the grid it was opened from. */}
        <Route
          path="/discover/:provider/:id"
          element={<DiscoverPreviewPage />}
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<NotYet />} />
      </Route>
    </Routes>
  )
}

function NotYet() {
  return (
    <p className="py-24 text-center text-faint">
      Not built yet — this arrives in a later stage of the rewrite.
    </p>
  )
}
