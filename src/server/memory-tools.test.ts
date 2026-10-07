import { describe, expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createMemoryTool } from './memory-tools'

describe('memory tool', () => {
  it('exposes an object parameter schema accepted by OpenAI-compatible providers', () => {
    const tool = createMemoryTool({
      setMemory: vi.fn(),
      deleteMemory: vi.fn(),
    }, 'session-1')

    expect(tool.parameters.type).toBe('object')
  })

  it('requires the fields for each action before changing memory', async () => {
    const setMemory = vi.fn()
    const deleteMemory = vi.fn()
    const tool = createMemoryTool({ setMemory, deleteMemory }, 'session-1')

    await expect(tool.execute({ action: 'delete' }, { callId: 'call-1' } as never, BACKGROUND_CONTEXT)).rejects.toThrow('id is required')
    await expect(tool.execute({ action: 'set' }, { callId: 'call-2' } as never, BACKGROUND_CONTEXT)).rejects.toThrow('kind and content are required')
    expect(setMemory).not.toHaveBeenCalled()
    expect(deleteMemory).not.toHaveBeenCalled()
  })
})
