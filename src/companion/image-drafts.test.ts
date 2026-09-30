import { expect, it } from 'vitest'
import { imageIntakeError, type CompanionImageDraft } from '../../frontend/src/lib/companion/client/image-drafts'

it('validates image additions atomically without touching existing drafts', () => {
  const limits = { mediaTypes: ['image/png'] as const, maxImagesPerMessage: 2, maxImageBytes: 10, maxMessageImageBytes: 15 }
  const file = (name: string, size: number, type = 'image/png') => new File(['x'.repeat(size)], name, { type })
  const existing: CompanionImageDraft[] = [{ id: 'fixture', file: file('old.png', 8), previewUrl: 'blob:fixture-only' }]
  expect(imageIntakeError(existing, [], undefined)).toBeUndefined() // cancelled chooser
  expect(imageIntakeError(existing, [file('new.png', 1)], undefined)?.key).toBe('image.unavailable')
  expect(imageIntakeError(existing, [file('bad.txt', 1, 'text/plain')], limits)?.key).toBe('image.types')
  expect(imageIntakeError(existing, [file('big.png', 11)], limits)?.key).toBe('image.tooLarge')
  expect(imageIntakeError(existing, [file('a.png', 1), file('b.png', 1)], limits)?.key).toBe('image.countLimit')
  expect(imageIntakeError(existing, [file('new.png', 8)], limits)?.key).toBe('image.totalTooLarge')
  expect(imageIntakeError(existing, [file('new.png', 7)], limits)).toBeUndefined()
  expect(existing.map(draft => draft.file.name)).toEqual(['old.png'])
})
