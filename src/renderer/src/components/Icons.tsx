type IconProps = { className?: string }

export function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M8.5 11.5 14.5 16 8.5 20.5"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M16.5 20.5h7" stroke="var(--accent-ink)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16.5 20 20.5" />
    </svg>
  )
}

export function IconPlus({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconEdit({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4l11-11-4-4L4 16v4Z" />
      <path d="m13 7 4 4" />
    </svg>
  )
}

export function IconTrash({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14" />
      <path d="M9 7V5h6v2" />
      <path d="M8 7l1 13h6l1-13" />
    </svg>
  )
}

export function IconExternal({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 7H5v12h12v-3" />
      <path d="M11 13 19 5" />
      <path d="M13 5h6v6" />
    </svg>
  )
}

export function IconClose({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7l10 10M17 7 7 17" />
    </svg>
  )
}

export function IconKey({ className }: IconProps) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="14" r="3.2" />
      <path d="M11 14h9l-2 2 2 2" />
    </svg>
  )
}
