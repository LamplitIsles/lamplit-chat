import { type ChatAppearance } from '@lamplit/contracts'
import type { DisplayNames } from './display-names'

export async function readChatAppearance(bucket: R2Bucket | undefined, instanceId: string | null): Promise<ChatAppearance> {
  const prefix = instanceId ? `instances/${instanceId}/` : ''
  const namesObject = await bucket?.get(`${prefix}display-names.json`)
  const names = namesObject ? await namesObject.json<DisplayNames>() : { companionName: '', userName: '' }
  const slots = ['avatar', 'user-avatar', 'background'] as const
  const objects = bucket ? await Promise.all(slots.map(slot => bucket.head(`${prefix}ui-assets/${slot}`))) : []
  return { ...names,
    ...(objects[0] ? { companionAvatar: '/api/ui-assets/avatar' } : {}),
    ...(objects[1] ? { userAvatar: '/api/ui-assets/user-avatar' } : {}),
    ...(objects[2] ? { backgrounds: { landscape: '/api/ui-assets/background', portrait: '/api/ui-assets/background' } } : {}),
  }
}
