import {createTorrentListCard} from '../dist/backend/modules/media/infrastructure/torrentListCard.js'
import {getSharedBrowser,scheduleSharedBrowserClose} from './sharedBrowser.js'
export {buildTorrentListCardData} from '../dist/backend/modules/media/infrastructure/torrentListCard.js'
const runtime=createTorrentListCard({cwd:process.cwd(),getSharedBrowser,scheduleSharedBrowserClose})
export const renderTorrentListCard=runtime.renderTorrentListCard
export const deleteTorrentCard=runtime.deleteTorrentCard
