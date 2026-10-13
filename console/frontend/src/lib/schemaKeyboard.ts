import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export function useSchemaSaveShortcut(
  element: Ref<HTMLElement | null>,
  canSave: () => boolean,
  save: () => unknown,
  active = () => true
) {
  const handler = (event: KeyboardEvent) => {
    if (
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== 's' ||
      event.altKey ||
      !active() ||
      !element.value?.getClientRects().length
    )
      return
    event.preventDefault()
    if (canSave()) void save()
  }
  onMounted(() => window.addEventListener('keydown', handler))
  onBeforeUnmount(() => window.removeEventListener('keydown', handler))
}
