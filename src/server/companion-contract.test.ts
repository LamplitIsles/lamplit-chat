import { expect, it } from 'vitest'
import { Type } from 'typebox'
import { Value } from 'typebox/value'
import contract from '../../docs/companion-materials.contract.json'
import fixtures from './fixtures/companion-materials.json'
import { FileCreateSchema, FileUpdateSchema, MemoryDeleteSchema, MemoryUpdateSchema, ResetSchema } from '../shared/companion-materials'

it('validates fictional machine-consumed contract fixtures and rejects extra mutation fields', () => {
  const samples = [
    ['FileCreate', fixtures.fileCreate, FileCreateSchema], ['FileUpdate', fixtures.fileUpdate, FileUpdateSchema],
    ['MemoryUpdate', fixtures.memoryUpdate, MemoryUpdateSchema], ['MemoryDelete', fixtures.memoryDelete, MemoryDeleteSchema], ['Reset', fixtures.reset, ResetSchema],
  ] as const
  for (const [name, sample, runtimeSchema] of samples) {
    expect(Value.Check(Type.Unsafe(contract.schemas[name]), sample)).toBe(true)
    expect(Value.Check(runtimeSchema, sample)).toBe(true)
    expect(Value.Check(runtimeSchema, { ...sample, sessionId: 'unauthorized-selector' })).toBe(false)
  }
  for (const [schema, value] of [
    [contract.schemas.File, fixtures.file], [contract.schemas.FileList, fixtures.fileList],
    [contract.schemas.Memory, fixtures.memory], [contract.schemas.EffectiveCompaction, fixtures.compactionCustom],
    ...fixtures.errors.map(error => [contract.schemas.Error, error] as const),
  ] as const) expect(Value.Check(Type.Unsafe(schema), value)).toBe(true)
})
