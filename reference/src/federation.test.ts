/**
 * Federation Active Push Tests
 * Quick verification of push federation logic
 */

import { FederationManager, createFederationConfig } from './federation.js';
import type { Post } from './types.js';

// Mock ethers signing for tests
const TEST_PRIVATE_KEY = '0x' + '1'.repeat(64);

describe('FederationManager - Active Push', () => {
  let federation: FederationManager;

  beforeEach(() => {
    federation = new FederationManager(
      createFederationConfig('https://test.asp.example', true, 'open', TEST_PRIVATE_KEY)
    );
  });

  afterEach(() => {
    federation.stopPushProcessor();
  });

  it('should queue events for delivery', () => {
    const post: Post = {
      id: 'asp:test.asp.example/posts/1',
      type: 'Post',
      author: '0x1234567890123456789012345678901234567890',
      content: 'Test post',
      contentType: 'text/plain',
      published: new Date().toISOString(),
      signature: '0x' + 'a'.repeat(130)
    };

    // Publish and queue for push
    const eventId = federation.publishAndPush('PostCreated', post);

    // Should be in outbox
    const { events } = federation.getOutboxEvents();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('PostCreated');
    expect(events[0].object).toEqual(post);
  });

  it('should track delivery queue status', () => {
    // Initially empty
    const status = federation.getDeliveryQueueStatus();
    expect(status.pending).toBe(0);
    expect(status.delivered).toBe(0);
    expect(status.failed).toBe(0);
  });

  it('should trust instances based on mode', () => {
    // Open mode - trusts by default
    expect(federation.trustsInstance('https://other.asp.example')).toBe(true);

    // Block an instance
    federation.blockInstance('https://blocked.asp.example');
    expect(federation.trustsInstance('https://blocked.asp.example')).toBe(false);
    expect(federation.trustsInstance('https://other.asp.example')).toBe(true);
  });

  it('should generate valid metadata for /.well-known/asp', () => {
    const metadata = federation.getMetadata();
    expect(metadata.enabled).toBe(true);
    expect(metadata.inbox).toBe('https://test.asp.example/federation/inbox');
    expect(metadata.outbox).toBe('https://test.asp.example/federation/outbox');
    expect(metadata.trustMode).toBe('open');
  });
});

// Run if executed directly
if (typeof describe === 'undefined') {
  console.log('Run with: npx jest src/federation.test.ts');
}
