/**
 * Jest stub for `jose`. The real package is ESM-only and breaks ts-jest's CJS
 * transform when AppModule (which transitively imports auth.guard → jwks.service)
 * is loaded by a unit test. Tests that actually exercise JWT verification stub
 * `JwksService.verifyToken` directly; everything else just needs the import to
 * resolve so the Nest module graph can compile.
 */
export const createRemoteJWKSet = () => async () => {
  throw new Error('jose mock: createRemoteJWKSet should not be called in unit tests');
};

export const jwtVerify = async () => {
  throw new Error('jose mock: jwtVerify should not be called in unit tests');
};

export type JWTPayload = Record<string, unknown>;

export const errors = {
  JWTExpired: class JWTExpired extends Error {},
  JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {},
  JWSSignatureVerificationFailed: class JWSSignatureVerificationFailed extends Error {},
  JWKSNoMatchingKey: class JWKSNoMatchingKey extends Error {},
};
