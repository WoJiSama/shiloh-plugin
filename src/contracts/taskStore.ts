/** Raw storage boundary only; lease and job-state policies remain with their existing owner. */
export interface TaskWriteOptions {
  NX?: boolean
  EX?: number
  PX?: number
}
export interface TaskStore {
  getRaw(key: string): Promise<unknown>
  setRaw(key: string, value: string, options?: TaskWriteOptions): Promise<unknown>
  delRaw(key: string): Promise<unknown>
}
