import { type ImageLimits, type ImageRef, type ImageUpload, validateUpload } from '@lamplit/contracts'
import type { ConversationPhoto } from '../shared/pi-contract'

export const PI_IMAGE_LIMITS: ImageLimits = { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxImagesPerMessage: 6, maxImageBytes: 8_000_000, maxMessageImageBytes: 24_000_000 }
export const imageRef = (photo: ConversationPhoto, available = true): ImageRef => ({ attachmentId: photo.id, name: photo.name.length > 200 ? photo.name.slice(0, 199) + '…' : photo.name, mediaType: photo.mediaType as ImageRef['mediaType'], availability: available ? 'available' : 'missing' })

// Public IDs need not be native UUIDs. Bind them deterministically to this operation.
export async function nativePhotoId(operationId: string, id: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([operationId, id])))).slice(0, 16)
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function checkUpload(input: unknown, sessionId: string): ImageUpload {
  const valid = validateUpload(input, PI_IMAGE_LIMITS)
  if (valid.sessionId !== sessionId) throw new Error('Image session mismatch')
  return valid
}
