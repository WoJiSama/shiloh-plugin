// Legacy host composition: file operations and named-config behavior live in TypeScript.
import _ from 'lodash'
import chokidar from 'chokidar'
import Base from './base.js'
import { createNamedConfig } from '../dist/backend/modules/config/infrastructure/namedConfig.js'
class RConfig extends Base {
 constructor(e) {
  super(e)
  Object.assign(this, createNamedConfig({
   configPath: `./plugins/${Base.pluginName}/config/`,
   watch: file => chokidar.watch(file, { ignoreInitial: true }),
   equal: _.isEqual, isEmpty: _.isEmpty,
   logger: { mark: message => globalThis.logger?.mark?.(message), error: (...args) => globalThis.logger?.error?.(...args) }
  }))
 }
}
export default new RConfig()
