/**
 * @jooservices/ssh-client
 *
 * Scaffold only — SSH client implementation is planned in BACKLOG.md Wave C.
 */

export const clientPackageName = '@jooservices/ssh-client' as const;

export interface ClientMetadata {
  readonly packageName: typeof clientPackageName;
  readonly status: 'scaffold';
}

export const clientMetadata: ClientMetadata = {
  packageName: clientPackageName,
  status: 'scaffold',
};
