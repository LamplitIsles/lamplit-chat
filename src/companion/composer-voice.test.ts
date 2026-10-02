import { describe, expect, it } from 'vitest'
import { createComposerState, reduceComposer, shouldSubmitEnter } from '../../frontend/src/lib/companion/client/composer'
describe('composer composition', () => {
  it('keeps Chinese composition intact until compositionend, including Enter', () => {
    let state = createComposerState('你好')
    state = reduceComposer(state, { type: 'compositionstart' })
    expect(shouldSubmitEnter({ key: 'Enter' }, state.composing)).toBe(false)
    expect(reduceComposer(state, { type: 'submit' })).toEqual(state)
    state = reduceComposer(state, { type: 'compositionend', value: '你好世界' })
    expect(shouldSubmitEnter({ key: 'Enter', isComposing: true }, state.composing)).toBe(false)
    expect(shouldSubmitEnter({ key: 'Enter', shiftKey: true }, state.composing)).toBe(false)
    expect(reduceComposer(state, { type: 'submit' })).toMatchObject({ draft: '', lastSubmitted: '你好世界' })
    expect(reduceComposer(createComposerState('  '), { type: 'submit' }).draft).toBe('  ')
  })

})
