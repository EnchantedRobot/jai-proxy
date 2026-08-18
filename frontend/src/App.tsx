import { Route, Routes } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { CharactersPage } from '@/pages/CharactersPage'
import { CharacterDetailPage } from '@/pages/CharacterDetailPage'
import { TagsPage } from '@/pages/TagsPage'

/**
 * The route table (docs/UI_REWRITE_PLAN.md §4.1). `/discover` and `/settings`
 * arrive with the stages that build them — Stage 1 is Characters and Favorites;
 * Stage 2 adds the detail route; Stage 4 adds the Tags consolidation editor.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<CharactersPage />} />
        <Route path="/favorites" element={<CharactersPage favorites />} />
        <Route path="/characters/:id" element={<CharacterDetailPage />} />
        <Route path="/tags" element={<TagsPage />} />
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
