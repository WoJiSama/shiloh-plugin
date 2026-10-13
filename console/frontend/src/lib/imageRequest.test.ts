import { describe, expect, it } from 'vitest'
import { IMAGE_BODY_LIMIT, serializeImageRequest } from './imageRequest'
describe('image JSON body limit', () => {
  it('accepts a request at the server byte limit', () => {
    const images = ['a'.repeat(IMAGE_BODY_LIMIT - 15)]
    expect(new TextEncoder().encode(serializeImageRequest({ images })).byteLength).toBe(
      IMAGE_BODY_LIMIT
    )
  })
  it('counts encoded content and all reference images before sending', () => {
    expect(() =>
      serializeImageRequest({
        images: ['a'.repeat(IMAGE_BODY_LIMIT / 2), 'a'.repeat(IMAGE_BODY_LIMIT / 2)]
      })
    ).toThrow('总大小超过')
  })
})
