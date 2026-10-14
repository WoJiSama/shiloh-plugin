import {createSmartLockPolicy} from '../dist/backend/modules/conversation/domain/smartLockPolicy.js'
import {extractValidBtihMagnetUri} from './torrentDownload.js'
const policy=createSmartLockPolicy(extractValidBtihMagnetUri)
export const isLongRunningTaskLinkRequest=policy.isLongRunningTaskLinkRequest
export const armSmartLockWatchdog=policy.armSmartLockWatchdog
export const clearSmartLockWatchdog=policy.clearSmartLockWatchdog
