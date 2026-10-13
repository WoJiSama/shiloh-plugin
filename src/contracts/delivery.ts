/** A confirmed send, a definite rejection, and an unknown result have different retry semantics. */
export type DeliveryReceipt =
  | { state: 'sent'; messageId: string }
  | { state: 'failed'; code: string | null }
  | { state: 'unknown' }

export interface ReplyPort<Content> {
  send(content: Content, signal?: AbortSignal): Promise<DeliveryReceipt>
}
