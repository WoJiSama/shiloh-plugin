import { onBeforeUnmount } from 'vue'
import { useDialog } from 'naive-ui'
const guards = new Map<symbol, () => boolean>()
let ask: (() => Promise<boolean>) | null = null
export function hasUnsavedChanges() {
  return [...guards.values()].some((check) => check())
}
export async function confirmLeave() {
  return (
    !hasUnsavedChanges() ||
    (ask ? await ask() : window.confirm('有未保存的修改，确定离开并放弃这些修改？'))
  )
}
export function useUnsavedGuard(check: () => boolean) {
  const id = Symbol('draft')
  guards.set(id, check)
  onBeforeUnmount(() => guards.delete(id))
}
export function installUnsavedDialog() {
  const dialog = useDialog()
  ask = () =>
    new Promise((resolve) => {
      let decided = false
      const finish = (value: boolean) => {
        if (!decided) {
          decided = true
          resolve(value)
        }
      }
      dialog.warning({
        title: '修改尚未保存',
        content: '离开后将放弃当前页面的修改。你也可以继续编辑并保存。',
        positiveText: '放弃并离开',
        negativeText: '继续编辑',
        onPositiveClick: () => finish(true),
        onNegativeClick: () => finish(false),
        onClose: () => finish(false),
        onMaskClick: () => finish(false)
      })
    })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (hasUnsavedChanges()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload)
    ask = null
  })
}
