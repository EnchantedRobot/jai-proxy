import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'
import { TOOLS_SECTIONS } from './sections-def'

/**
 * The Tags/Duplicates switcher. Horizontal pills rather than Settings'
 * vertical sidebar (`SettingsNav`) -- two items don't need a sidebar's worth
 * of width, and the pill style already matches the TopBar's own tab group.
 */
export function ToolsNav() {
  return (
    <nav className="mx-auto flex max-w-[1320px] px-5 pt-4">
      <div className="flex gap-[3px] rounded-full border border-line bg-raised p-[3px]">
        {TOOLS_SECTIONS.map((section) => (
          <NavLink
            key={section.key}
            to={`/tools/${section.key}`}
            className={({ isActive }) =>
              cn(
                'rounded-full px-4 py-1.5 text-[13px] font-medium text-muted hover:text-text',
                isActive && 'bg-text font-semibold text-[#121416]',
              )
            }
          >
            {section.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
