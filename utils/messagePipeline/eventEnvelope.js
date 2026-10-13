import { createEventEnvelope as createTypedEnvelope } from '../../dist/backend/modules/messaging/infrastructure/eventEnvelope.js'
export { envelopeToRuntimeEvent, isEnvelopeFromBot } from '../../dist/backend/modules/messaging/infrastructure/eventEnvelope.js'
export function createEventEnvelope(event = {}, postType = '') { return createTypedEnvelope(event, postType, globalThis.Bot?.uin) }
