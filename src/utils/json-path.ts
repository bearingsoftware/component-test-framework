/**
 * Read a value from parsed JSON by a dot path, e.g. `user.name`. Array
 * elements can be addressed as `items[0].id` or `items.0.id`. Returns
 * `undefined` when the last key is missing, and throws when the path runs
 * through something that isn't an object or array, naming where.
 */
export function valueAt(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let current = value
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      throw new Error(`Cannot resolve path "${path}" — hit ${typeof current} at "${part}"`)
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
