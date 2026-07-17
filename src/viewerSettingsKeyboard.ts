type ViewerSettingsKeyEvent = {
  readonly key: string
  readonly preventDefault: () => void
  readonly stopPropagation: () => void
}

export function handleViewerSettingsKeyDown(
  event: ViewerSettingsKeyEvent,
  open: boolean,
  cancelCapture: () => boolean,
  close: () => void
): boolean {
  if (!open || event.key !== 'Escape') return false
  event.preventDefault()
  event.stopPropagation()
  if (!cancelCapture()) close()
  return true
}
