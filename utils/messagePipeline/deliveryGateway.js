// Legacy bot/logging composition for typed delivery behavior.
import { createDeliveryGatewayModule } from '../../dist/backend/modules/messaging/infrastructure/deliveryGateway.js'
import { isForwardResourceFailure } from './videoThumbnail.js'
import { logDeliveryOutcome } from '../deliveryObservability.js'
const gateway = createDeliveryGatewayModule({ botRoot: () => globalThis.Bot, logger: globalThis.logger, isForwardResourceFailure, logDeliveryOutcome })
export const DeliveryError = gateway.DeliveryError
export const DeliveryGateway = gateway.DeliveryGateway
export const buildOneBotForwardNodes = gateway.buildOneBotForwardNodes
export const inlineForwardLocalFileSegment = gateway.inlineForwardLocalFileSegment
export const inlineForwardVideoSegment = gateway.inlineForwardVideoSegment
export const sendCompleteLocalFile = gateway.sendCompleteLocalFile
