/**
 * @jooservices/vigor3912s-client
 *
 * Scaffold only — SSH Transport implementation is planned in BACKLOG.md Wave C.
 * Do not use this package against a live router until C4 is done and reviewed.
 */

export const clientPackageName = '@jooservices/vigor3912s-client' as const;

export interface ClientMetadata {
  readonly packageName: typeof clientPackageName;
  readonly status: 'scaffold';
  readonly implementsTransport: false;
}

export const clientMetadata: ClientMetadata = {
  packageName: clientPackageName,
  status: 'scaffold',
  implementsTransport: false,
};
