/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Load an optional peer dependency, or say which package to install and what
 * needs it, rather than Node's bare "Cannot find module".
 */
export function requireOptional<T>(name: string, usedBy: string): T {
  try {
    return require(name) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' && String(err).includes(name)) {
      throw new Error(
        `${usedBy} needs ${name}. Add it to the suite's dependencies: npm install --save-dev ${name}`,
      )
    }
    throw err
  }
}
