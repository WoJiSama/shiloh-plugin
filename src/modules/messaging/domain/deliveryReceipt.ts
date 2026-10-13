import type { DeliveryReceipt } from '../../../contracts/delivery.js'

export function normalizeDeliveryReceipt(value: unknown): DeliveryReceipt {
  if (value === false) return { state: 'failed', code: null }
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return { state: 'unknown' }
  const status = 'status' in value ? value.status : undefined
  const code = 'retcode' in value ? value.retcode : undefined
  if (status === 'failed' || (code != null && Number(code) !== 0)) return { state: 'failed', code: code == null ? null : String(code) }
  const data = 'data' in value && value.data && typeof value.data === 'object' ? value.data : value
  const id = 'message_id' in data ? data.message_id : undefined
  if ((typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0)) return { state: 'sent', messageId: String(id) }
  return { state: 'unknown' }
}
