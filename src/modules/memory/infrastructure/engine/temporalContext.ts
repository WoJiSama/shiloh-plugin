/** Memory dates use an explicit calendar instead of the machine's current timezone. */
export const MEMORY_TIME_ZONE = 'Asia/Shanghai'

export function finiteTimestamp(value:unknown):number|undefined {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? value : undefined
}

function dateParts(at:number) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:MEMORY_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(at)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type,part.value]))
}

export function memoryDate(at:number) {
  const parts = dateParts(at)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function describeMemoryTime(at:number) {
  const parts = dateParts(at)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${MEMORY_TIME_ZONE}`
}

/** Date-only events are anchored at local noon; a fact never invents an exact appointment time. */
export function parseEventDate(value:unknown):number|undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const at = Date.parse(`${value}T12:00:00+08:00`)
  return Number.isFinite(at) && memoryDate(at) === value ? at : undefined
}
