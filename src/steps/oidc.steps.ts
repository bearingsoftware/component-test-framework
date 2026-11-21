import { Given } from '@cucumber/cucumber'
import { latestOidcIssuer, type OidcIssuer } from '../clients/oidc-issuer'

/** Options for {@link registerOidcSteps}. */
export interface OidcStepOptions {
  /** The issuer the steps act on, or a function returning it. Default: the last one `startOidcIssuer` started. */
  issuer?: OidcIssuer | (() => OidcIssuer)
}

let registered = false

/**
 * Register the OIDC issuer steps:
 *
 * - `the OIDC user {string} has groups {string}`: the user's `sub`, and a comma-separated list
 * - `the OIDC signing key is rotated`
 *
 * Calling this twice registers nothing more.
 */
export function registerOidcSteps(options: OidcStepOptions = {}): void {
  if (registered) return
  registered = true
  const issuer = (): OidcIssuer => {
    const given = options.issuer
    const found = typeof given === 'function' ? given() : (given ?? latestOidcIssuer())
    if (found === undefined)
      throw new Error('no OIDC issuer is running; call startOidcIssuer first')
    return found
  }

  Given('the OIDC user {string} has groups {string}', function (sub: string, groups: string) {
    issuer().setClaims(sub, {
      groups: groups
        .split(',')
        .map((g) => g.trim())
        .filter((g) => g !== ''),
    })
  })

  Given('the OIDC signing key is rotated', async function () {
    await issuer().rotateKey()
  })
}
