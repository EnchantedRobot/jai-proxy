import { Navigate, useParams } from 'react-router'
import { DuplicatesSection, TagsSection } from '@/components/tools/sections'
import { ToolsNav } from '@/components/tools/controls'
import {
  TOOLS_SECTIONS,
  type SectionKey,
} from '@/components/tools/sections-def'

const SECTIONS: Record<SectionKey, React.ComponentType> = {
  tags: TagsSection,
  duplicates: DuplicatesSection,
}

/**
 * Tools (`/tools/:section`) -- library-hygiene features that operate over the
 * whole archive at once rather than one card: tag consolidation (formerly its
 * own `/tags` route) and same-creator duplicate detection. Mirrors
 * `SettingsPage`'s `/settings/:section` shape exactly, minus the sidebar --
 * see `ToolsNav` for why.
 */
export function ToolsPage() {
  const { section } = useParams<{ section?: string }>()

  if (!section || !(section in SECTIONS)) {
    return <Navigate to={`/tools/${TOOLS_SECTIONS[0].key}`} replace />
  }
  const Section = SECTIONS[section as SectionKey]

  return (
    <div>
      <ToolsNav />
      <Section />
    </div>
  )
}
