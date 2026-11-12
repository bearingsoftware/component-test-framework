import { describe, it, expect } from 'vitest'
import { parseSeedJson, rowsFromTable } from './db-seed'

describe('rowsFromTable (COMPONENT-24)', () => {
  it('takes the header row as columns, with strings for cells and NULL for empty ones', () => {
    expect(
      rowsFromTable([
        ['sku', 'qty', 'note'],
        ['A', '2', ''],
        ['B', '', 'x'],
      ]),
    ).toEqual([
      { sku: 'A', qty: '2', note: null },
      { sku: 'B', qty: null, note: 'x' },
    ])
  })

  it('gives no rows for a header alone, and rejects a ragged row', () => {
    expect(rowsFromTable([['sku']])).toEqual([])
    expect(() => rowsFromTable([['a', 'b'], ['1']])).toThrow(/1 cells, the header has 2/)
    expect(() => rowsFromTable([])).toThrow(/header row/)
  })
})

describe('parseSeedJson (COMPONENT-24)', () => {
  it('keeps the table order and the row values', () => {
    const tables = parseSeedJson('{"b":[{"x":1}],"a":[{"y":null},{"y":"s"}]}', 'f.json')
    expect(tables).toEqual([
      ['b', [{ x: 1 }]],
      ['a', [{ y: null }, { y: 's' }]],
    ])
  })

  it('rejects anything but an object of row arrays', () => {
    expect(() => parseSeedJson('[]', 'f.json')).toThrow(/f.json: expected an object/)
    expect(() => parseSeedJson('{"t":{"x":1}}', 'f.json')).toThrow(/"t" must be an array/)
    expect(() => parseSeedJson('{"t":[1]}', 'f.json')).toThrow(/"t" must be an array/)
  })
})
