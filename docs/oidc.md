# OIDC issuer stub

A service that signs users in with OpenID Connect can sign them in against a stub issuer instead of a real identity provider. `startOidcIssuer` from `@bearingsoftware/component-test-framework/oidc` starts one on `127.0.0.1`, with no dependency beyond Node: RS256 signing uses `node:crypto`.

The issuer is for tests only. Without `clients` it accepts any `client_id` and `redirect_uri`, and its access tokens never expire. Never point a real service at it.

```typescript
import { startOidcIssuer, registerOidcSteps } from '@bearingsoftware/component-test-framework/oidc'

const issuer = await startOidcIssuer({
  port: 0, // the default: an ephemeral port, returned as issuer.port
  // portEnv: 'OIDC_PORT', // or read it from an environment variable
  // issuerPath: '/realms/test', // the issuer URL gets this path
  users: [{ sub: 'u1', email: 'u1@example.test', name: 'User One', groups: ['dev'] }],
  clients: [{ id: 'app', secret: 'shh', redirectUris: ['http://localhost:3000/callback'] }],
})
// Configure the service under test with issuer.issuer, then:
await issuer.stop()
```

Under `workerIsolation`, leave `port` at 0 and hand each worker's service its own `issuer.issuer`, or pass `workerPort(base)` as `port`.

## Endpoints

All paths sit under `issuer.issuer` (`url` plus `issuerPath`).

| Path | Behaviour |
|---|---|
| `/.well-known/openid-configuration` | Discovery document |
| `/jwks` | Every signing key, current and rotated-out |
| `/authorize` | No login page: it redirects straight back with `code` and `state`. The user is the one named by `login_hint` (a `sub` or an email), or the only user. Otherwise `error=access_denied`. Takes `nonce`, and PKCE with `code_challenge_method=S256` (any other method is refused) |
| `/token` | `authorization_code` (checks the PKCE verifier when a challenge was sent) and `refresh_token` (the refresh token rotates). Codes are single use. The client authenticates with Basic auth or in the body |
| `/userinfo` | The user's claims, for the access token from `/token` |

ID tokens carry `iss`, `aud`, `sub`, `email`, `email_verified`, `name`, `groups`, any `claims` of the user, `iat`, `exp`, and the `nonce` the authorize request sent (not on refresh). Without `clients` every client and redirect URI is accepted; with them, an unknown client or redirect URI gets a 400 and a secret is checked when the client has one.

## Changing the issuer mid-scenario

- `issuer.setClaims(sub, claims)` merges claims into that user's next tokens and `/userinfo`, replacing any claim of the same name.
- `issuer.rotateKey()` signs with a new `kid` from then on. Old keys stay in `/jwks`, so tokens issued earlier still verify.

## Steps

Opt-in, like the Mailpit steps:

```typescript
registerOidcSteps() // acts on the last issuer started; or registerOidcSteps({ issuer })
```

| Step | Description |
|---|---|
| `Given the OIDC user {string} has groups {string}` | The user's `sub`, and a comma-separated list, set as the `groups` claim |
| `Given the OIDC signing key is rotated` | `issuer.rotateKey()` |
