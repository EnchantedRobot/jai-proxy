import { useEffect, useState } from 'react'
import { Outlet } from 'react-router'
import { SearchOverlay } from './SearchOverlay'
import { TopBar } from './TopBar'
import { Toaster } from './ui/Toaster'

/**
 * The frame every route renders inside: the fixed top bar, one scroll
 * container beneath it, and the ⌘K overlay.
 *
 * The scrolling belongs to this element rather than to the document because the
 * top bar is fixed and the section bar under it is `sticky top-0` — a sticky
 * header needs a scroll container it is actually inside of.
 */
export function AppShell() {
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <TopBar onSearch={() => setSearchOpen(true)} />
      <div className="absolute inset-0 top-[60px] overflow-x-hidden overflow-y-auto">
        <Outlet />
      </div>
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
      <Toaster />
    </>
  )
}
