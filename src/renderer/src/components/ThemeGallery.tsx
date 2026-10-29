import { useEffect, useRef, useState } from 'react'
import { THEMES, resolveTheme, terminalTheme, type ThemeChoice } from '@shared/theme'
import { previewTheme, savedChoice, setTheme } from '../lib/theme'

const SWATCHES = ['#7ee0c6', '#a78bfa', '#60b8ff', '#f5b85a', '#f58ab0', '#9be15d', '#ff8a65']

function Mini({ choice }: { choice: ThemeChoice }): React.JSX.Element {
  const t = resolveTheme(choice)
  const term = terminalTheme(t)
  return (
    <div className="theme-mini" aria-hidden="true">
      <div className="theme-mini-side" style={{ background: t.raised }}>
        <i className="on" style={{ background: t.accent, width: '80%' }} />
        <i style={{ background: t.dim, width: '65%' }} />
        <i style={{ background: t.dim, width: '72%' }} />
        <i style={{ background: t.dim, width: '50%' }} />
      </div>
      <div className="theme-mini-term" style={{ background: term.background, color: term.foreground }}>
        <div><span style={{ color: t.accent }}>deploy@prod</span>:~$ uptime</div>
        <div style={{ color: term.brightBlack }}>up 12 days, load 0.42</div>
        <div><span style={{ color: term.yellow }}>WARN</span> <span style={{ color: term.blue }}>disk 71%</span></div>
        <div><span style={{ color: t.accent }}>❯</span><span style={{ background: t.accent, marginLeft: 3 }}>&nbsp;</span></div>
      </div>
    </div>
  )
}

export default function ThemeGallery({ onClose }: { onClose: () => void }): React.JSX.Element {
  const initial = useRef(savedChoice())
  const [choice, setChoice] = useState<ThemeChoice>(initial.current)
  const committed = useRef(false)

  useEffect(() => () => {
    if (!committed.current) previewTheme(null)
  }, [])

  const pick = (next: ThemeChoice): void => {
    setChoice(next)
    setTheme(next)
  }
  const accent = resolveTheme(choice).accent

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal theme-gallery" role="dialog" aria-modal="true" aria-label="Appearance" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Appearance</h2>
        <p>Hover a theme to preview it. Click to apply.</p>
        <div className="theme-grid" onMouseLeave={() => previewTheme(null)}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-card${choice.id === t.id ? ' selected' : ''}`}
              onMouseEnter={() => previewTheme({ id: t.id, accent: choice.id === t.id ? choice.accent : undefined })}
              onFocus={() => previewTheme({ id: t.id })}
              onClick={() => pick({ id: t.id })}
            >
              <Mini choice={{ id: t.id, accent: choice.id === t.id ? choice.accent : undefined }} />
              <span className="theme-card-label">
                {t.name}
                <span className="theme-dot" style={{ background: choice.id === t.id ? accent : t.accent }} />
              </span>
            </button>
          ))}
        </div>
        <div className="theme-custom">
          <span>Accent</span>
          <div className="theme-swatches">
            {SWATCHES.map((c) => (
              <button key={c} type="button" title={c} className={accent === c ? 'on' : ''} style={{ background: c }} onClick={() => pick({ id: choice.id, accent: c })} />
            ))}
          </div>
          <input type="color" value={accent} aria-label="Custom accent color" onChange={(e) => pick({ id: choice.id, accent: e.target.value })} />
          <button type="button" className="text-button" onClick={() => pick({ id: choice.id })}>Reset</button>
        </div>
        <div className="theme-actions">
          <button type="button" className="btn btn-primary" onClick={() => { committed.current = true; onClose() }}>Done</button>
        </div>
      </div>
    </div>
  )
}
