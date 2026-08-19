import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'
import { SETTINGS_SECTIONS } from './sections-def'

export function SettingsNav() {
  return (
    <nav className="flex flex-none flex-col gap-0.5 md:w-[190px]">
      {SETTINGS_SECTIONS.map((section) => (
        <NavLink
          key={section.key}
          to={`/settings/${section.key}`}
          className={({ isActive }) =>
            cn(
              'rounded-lg px-3 py-2 text-left text-[13.5px] text-muted hover:bg-raised hover:text-text',
              isActive && 'bg-sage-dim font-medium text-sage',
            )
          }
        >
          {section.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** One settings section: a heading, a one-line explanation, and a panel of rows. */
export function SettingsSection({
  title,
  lede,
  children,
}: {
  title: string
  lede: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="font-serif text-[23px] font-normal">{title}</h2>
      <p className="mt-1 mb-4 text-[13px] text-faint">{lede}</p>
      <div className="flex flex-col divide-y divide-line-soft rounded-2xl border border-line bg-surface px-5">
        {children}
      </div>
    </section>
  )
}

/** One row of a panel: a label + hint on the left, a control on the right. */
export function OptionRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4 py-[13px]">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{label}</div>
        {hint && (
          <div className="mt-0.5 truncate text-[11.5px] text-faint">{hint}</div>
        )}
      </div>
      {children && (
        <div className="flex flex-none items-center gap-2">{children}</div>
      )}
    </div>
  )
}

/** The mock's `.toggle` — a pill switch, not a native checkbox, so it matches
 *  every other pill control in the app. */
export function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-[22px] w-9 flex-none rounded-full border transition-colors disabled:opacity-50',
        on ? 'border-sage bg-sage' : 'border-line bg-raised',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-[16px] rounded-full bg-ground transition-transform',
          on ? 'translate-x-[19px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export function SelectField({
  value,
  onChange,
  options,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-[31px] rounded-lg border border-line bg-raised px-2.5 text-[12.5px] text-text outline-none focus:border-sage',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Stat({
  value,
  label,
}: {
  value: React.ReactNode
  label: string
}) {
  return (
    <div>
      <b className="block font-mono text-[19px] leading-tight font-semibold">
        {value}
      </b>
      <span className="text-[11px] text-faint">{label}</span>
    </div>
  )
}
