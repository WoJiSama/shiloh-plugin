import { sendForwardBatches } from '../../src/modules/messaging/domain/forwardBatches.js'
import { collectPluginExports, type PluginExport } from '../../src/modules/platform/domain/pluginExportLoader.js'

const options = { makeForward: (batch: number[]) => ({ batch }), send: (_payload: { batch: number[] }) => true }
void sendForwardBatches([1, 2], options)
// @ts-expect-error nodes must be an array
void sendForwardBatches(5, options)
// @ts-expect-error makeForward callback is required
void sendForwardBatches([1], { send: () => true })
// @ts-expect-error send callback is required
void sendForwardBatches([1], { makeForward: (batch: number[]) => batch })
// @ts-expect-error payload passed to send must match makeForward result
void sendForwardBatches<number, string>([1], { makeForward: () => 'payload', send: (_payload: number) => true })
// @ts-expect-error progress arguments are numbers
void sendForwardBatches([1], { ...options, onProgress: (_sent: string) => {} })
// @ts-expect-error strict optional callback cannot explicitly be undefined
void sendForwardBatches([1], { ...options, onProgress: undefined })

const discovered: PluginExport[] = collectPluginExports({})
void discovered
// @ts-expect-error discovery returns named records, not raw constructors
const constructors: Array<new () => object> = collectPluginExports({})
void constructors
