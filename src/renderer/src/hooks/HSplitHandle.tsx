import { useCallback, useRef } from 'react'

/** Thin vertical drag handle between horizontal panels. */
export function HSplitHandle({
  onDrag,
  title
}: {
  onDrag: (deltaX: number) => void
  title?: string
}): React.JSX.Element {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const endDrag = useCallback((el: HTMLElement, pointerId: number): void => {
    dragging.current = false
    try {
      el.releasePointerCapture(pointerId)
    } catch {
      /* already released */
    }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      className="group relative z-20 w-px shrink-0 cursor-col-resize bg-ink-line hover:bg-signal/70 active:bg-signal"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        dragging.current = true
        lastX.current = e.clientX
        e.currentTarget.setPointerCapture(e.pointerId)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const dx = e.clientX - lastX.current
        lastX.current = e.clientX
        if (dx !== 0) onDrag(dx)
      }}
      onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
    >
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" aria-hidden />
    </div>
  )
}
