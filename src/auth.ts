/**
 * Return the HTTP Authorization header value for a NetBox API token.
 *
 * NetBox v2 tokens are shaped `nbt_<key>.<secret>` and use the Bearer
 * authentication scheme. Legacy v1 tokens use the Token scheme.
 */
export function authorizationHeader(token: string): string {
  return token.startsWith("nbt_") ? `Bearer ${token}` : `Token ${token}`;
}
