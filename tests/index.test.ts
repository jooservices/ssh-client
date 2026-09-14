import { describe, expect, it } from 'vitest';
import { clientMetadata, clientPackageName } from '../src/index.js';

describe('scaffold', () => {
  it('exposes package metadata', () => {
    expect(clientPackageName).toBe('@jooservices/vigor3912s-client');
    expect(clientMetadata.status).toBe('scaffold');
  });
});
