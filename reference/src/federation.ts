/**
 * Federation Layer for ASP
 * Handles inter-instance communication via inbox/outbox pattern
 * 
 * Design:
 * - Outbox: Local events are published here for remote instances to poll
 * - Inbox: Receives events from remote instances
 * - Trust: Instances can be open, allowlisted, blocklisted, or closed
 * - Persistence: Optional FederationStorage for surviving restarts
 */

import { ethers } from 'ethers';
import type { Post, Comment, FederationEvent } from './types.js';
import type { FederationStorage, PersistedRemoteInstance, PersistedOutboxEvent, PersistedDeliveryAttempt } from './federation-storage.js';

// Trust modes for federation
export type TrustMode = 'open' | 'allowlist' | 'blocklist' | 'closed';

// Instance trust configuration
export interface InstanceTrust {
  mode: TrustMode;
  allowlist: Set<string>;  // Instance URIs we trust
  blocklist: Set<string>;  // Instance URIs we block
}

// Federation configuration
export interface FederationConfig {
  enabled: boolean;
  instanceUri: string;
  trust: InstanceTrust;
  signingKey?: string;  // Private key for signing outbound events
}

// Remote instance info (discovered via /.well-known/asp)
export interface RemoteInstance {
  uri: string;
  version: string;
  inbox?: string;
  outbox?: string;
  trustMode: TrustMode;
  lastSeen: Date;
  lastError?: string;
}

// Event queue for outbox
export interface OutboxEvent {
  id: string;
  event: FederationEvent;
  created: Date;
  delivered: Set<string>;  // Instance URIs that have fetched this
}

// Delivery attempt tracking for active push
export interface DeliveryAttempt {
  instanceUri: string;
  eventId: string;
  attemptCount: number;
  lastAttempt: Date;
  nextAttempt: Date;
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string;
}

/**
 * Federation Manager
 * Coordinates event flow between instances
 */
export class FederationManager {
  private config: FederationConfig;
  private knownInstances: Map<string, RemoteInstance> = new Map();
  private outboxQueue: Map<string, OutboxEvent> = new Map();
  private outboxIdCounter = 0;
  private eventListeners: Array<(event: FederationEvent) => void> = [];
  
  // Active push state
  private deliveryQueue: Map<string, DeliveryAttempt> = new Map(); // key: `${instanceUri}:${eventId}`
  private pushInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly RETRY_BACKOFF_MS = [1000, 5000, 30000, 120000, 600000]; // 1s, 5s, 30s, 2m, 10m

  // Optional persistent storage
  private storage?: FederationStorage;

  constructor(config: FederationConfig, storage?: FederationStorage) {
    this.config = config;
    this.storage = storage;
    
    // Load persisted state if storage is available
    if (storage) {
      this.loadFromStorage();
    }
  }

  /**
   * Load federation state from persistent storage
   */
  private loadFromStorage(): void {
    if (!this.storage) return;

    // Load known instances
    const instances = this.storage.getInstances();
    for (const inst of instances) {
      this.knownInstances.set(inst.uri, {
        uri: inst.uri,
        version: inst.version,
        inbox: inst.inbox,
        outbox: inst.outbox,
        trustMode: inst.trustMode as TrustMode,
        lastSeen: new Date(inst.lastSeen),
        lastError: inst.lastError
      });
      
      // Restore trust settings
      if (inst.isAllowed) this.config.trust.allowlist.add(inst.uri);
      if (inst.isBlocked) this.config.trust.blocklist.add(inst.uri);
    }

    // Load outbox events
    const outboxEvents = this.storage.getOutboxEvents({ limit: 1000 });
    for (const evt of outboxEvents) {
      this.outboxQueue.set(evt.id, {
        id: evt.id,
        event: evt.event,
        created: new Date(evt.created),
        delivered: new Set(evt.deliveredTo)
      });
      // Track highest ID for counter
      const idMatch = evt.id.match(/\/outbox\/(\d+)$/);
      if (idMatch) {
        const num = parseInt(idMatch[1], 10);
        if (num > this.outboxIdCounter) this.outboxIdCounter = num;
      }
    }

    // Load delivery queue
    const deliveries = this.storage.getPendingDeliveries(new Date(Date.now() + 86400000).toISOString()); // Include all pending
    for (const del of deliveries) {
      this.deliveryQueue.set(del.key, {
        instanceUri: del.instanceUri,
        eventId: del.eventId,
        attemptCount: del.attemptCount,
        lastAttempt: new Date(del.lastAttempt),
        nextAttempt: new Date(del.nextAttempt),
        status: del.status,
        lastError: del.lastError
      });
    }

    console.log(`[Federation] Loaded from storage: ${instances.length} instances, ${outboxEvents.length} outbox events, ${deliveries.length} pending deliveries`);
  }

  /**
   * Save a remote instance to persistent storage
   */
  private persistInstance(instance: RemoteInstance): void {
    if (!this.storage) return;
    
    this.storage.saveInstance({
      uri: instance.uri,
      version: instance.version,
      inbox: instance.inbox,
      outbox: instance.outbox,
      trustMode: instance.trustMode,
      lastSeen: instance.lastSeen.toISOString(),
      lastError: instance.lastError,
      isAllowed: this.config.trust.allowlist.has(instance.uri),
      isBlocked: this.config.trust.blocklist.has(instance.uri)
    });
  }

  /**
   * Save an outbox event to persistent storage
   */
  private persistOutboxEvent(event: OutboxEvent): void {
    if (!this.storage) return;
    
    this.storage.saveOutboxEvent({
      id: event.id,
      event: event.event,
      created: event.created.toISOString(),
      deliveredTo: Array.from(event.delivered)
    });
  }

  /**
   * Save a delivery attempt to persistent storage
   */
  private persistDeliveryAttempt(key: string, attempt: DeliveryAttempt): void {
    if (!this.storage) return;
    
    this.storage.saveDeliveryAttempt({
      key,
      instanceUri: attempt.instanceUri,
      eventId: attempt.eventId,
      attemptCount: attempt.attemptCount,
      lastAttempt: attempt.lastAttempt.toISOString(),
      nextAttempt: attempt.nextAttempt.toISOString(),
      status: attempt.status,
      lastError: attempt.lastError
    });
  }

  /**
   * Check if federation is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if we trust an instance
   */
  trustsInstance(instanceUri: string): boolean {
    if (!this.config.enabled) return false;
    
    const { mode, allowlist, blocklist } = this.config.trust;
    
    switch (mode) {
      case 'closed':
        return false;
      case 'open':
        return !blocklist.has(instanceUri);
      case 'blocklist':
        return !blocklist.has(instanceUri);
      case 'allowlist':
        return allowlist.has(instanceUri);
      default:
        return false;
    }
  }

  /**
   * Discover a remote instance via /.well-known/asp
   */
  async discoverInstance(instanceUri: string): Promise<RemoteInstance | null> {
    try {
      const url = instanceUri.startsWith('http') 
        ? `${instanceUri}/.well-known/asp`
        : `https://${instanceUri}/.well-known/asp`;
      
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) return null;

      const metadata = await response.json();
      
      const instance: RemoteInstance = {
        uri: instanceUri,
        version: metadata.version,
        inbox: metadata.federation?.inbox,
        outbox: metadata.federation?.outbox,
        trustMode: metadata.federation?.trustMode || 'closed',
        lastSeen: new Date()
      };

      this.knownInstances.set(instanceUri, instance);
      this.persistInstance(instance);
      return instance;
    } catch (error) {
      const existing = this.knownInstances.get(instanceUri);
      if (existing) {
        existing.lastError = error instanceof Error ? error.message : String(error);
      }
      return null;
    }
  }

  /**
   * Sign an outbound event
   */
  signEvent(event: Omit<FederationEvent, 'signature'>): FederationEvent {
    if (!this.config.signingKey) {
      throw new Error('No signing key configured for federation');
    }

    const wallet = new ethers.Wallet(this.config.signingKey);
    const message = `${event.type}|${event.origin}|${event.timestamp}|${JSON.stringify(event.object)}`;
    const signature = wallet.signMessageSync(message);

    return { ...event, signature };
  }

  /**
   * Verify an inbound event signature
   * Returns the signer address if valid, null otherwise
   */
  verifyEventSignature(event: FederationEvent): string | null {
    try {
      const message = `${event.type}|${event.origin}|${event.timestamp}|${JSON.stringify(event.object)}`;
      return ethers.verifyMessage(message, event.signature);
    } catch {
      return null;
    }
  }

  /**
   * Publish a local event to the outbox
   */
  publishEvent(type: FederationEvent['type'], object: Post | Comment): string {
    if (!this.config.enabled) {
      throw new Error('Federation is not enabled');
    }

    const eventId = `${this.config.instanceUri}/outbox/${++this.outboxIdCounter}`;
    
    const unsignedEvent: Omit<FederationEvent, 'signature'> = {
      type,
      origin: this.config.instanceUri,
      timestamp: new Date().toISOString(),
      object
    };

    const event = this.signEvent(unsignedEvent);

    const outboxEvent: OutboxEvent = {
      id: eventId,
      event,
      created: new Date(),
      delivered: new Set()
    };

    this.outboxQueue.set(eventId, outboxEvent);
    this.persistOutboxEvent(outboxEvent);
    
    // Prune old events (keep last 1000)
    if (this.outboxQueue.size > 1000) {
      const oldest = Array.from(this.outboxQueue.keys()).slice(0, this.outboxQueue.size - 1000);
      oldest.forEach(id => {
        this.outboxQueue.delete(id);
        this.storage?.deleteOutboxEvent(id);
      });
    }

    return eventId;
  }

  /**
   * Get outbox events for a remote instance to consume
   */
  getOutboxEvents(options: { 
    since?: string;  // Event ID cursor
    limit?: number;
  } = {}): { events: FederationEvent[]; cursor?: string } {
    const limit = Math.min(options.limit || 50, 200);
    const events: FederationEvent[] = [];
    let cursor: string | undefined;
    let foundSince = !options.since;

    for (const [id, outboxEvent] of this.outboxQueue) {
      if (!foundSince) {
        if (id === options.since) foundSince = true;
        continue;
      }

      events.push(outboxEvent.event);
      cursor = id;

      if (events.length >= limit) break;
    }

    return { events, cursor };
  }

  /**
   * Process an inbound event from a remote instance
   */
  async processInboundEvent(event: FederationEvent, sourceInstance: string): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.config.enabled) {
      return { accepted: false, reason: 'Federation disabled' };
    }

    // Check trust
    if (!this.trustsInstance(sourceInstance)) {
      return { accepted: false, reason: 'Instance not trusted' };
    }

    // Verify origin matches source
    if (event.origin !== sourceInstance) {
      return { accepted: false, reason: 'Origin mismatch' };
    }

    // Verify signature
    const signer = this.verifyEventSignature(event);
    if (!signer) {
      return { accepted: false, reason: 'Invalid signature' };
    }

    // Verify the signer owns the content they're publishing
    // For now we trust the instance's attestation
    // Future: could verify against Agent Directory

    // Notify listeners
    this.eventListeners.forEach(listener => {
      try {
        listener(event);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    });

    return { accepted: true };
  }

  /**
   * Register a listener for inbound events
   */
  onEvent(listener: (event: FederationEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx !== -1) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * Get all known instances
   */
  getKnownInstances(): RemoteInstance[] {
    return Array.from(this.knownInstances.values());
  }

  /**
   * Add an instance to the allowlist
   */
  allowInstance(instanceUri: string): void {
    this.config.trust.allowlist.add(instanceUri);
    this.config.trust.blocklist.delete(instanceUri);
    
    // Persist trust change if instance is known
    const instance = this.knownInstances.get(instanceUri);
    if (instance) {
      this.persistInstance(instance);
    }
  }

  /**
   * Add an instance to the blocklist
   */
  blockInstance(instanceUri: string): void {
    this.config.trust.blocklist.add(instanceUri);
    this.config.trust.allowlist.delete(instanceUri);
    
    // Persist trust change if instance is known
    const instance = this.knownInstances.get(instanceUri);
    if (instance) {
      this.persistInstance(instance);
    }
  }

  /**
   * Get metadata for /.well-known/asp response
   */
  getMetadata(): {
    enabled: boolean;
    inbox?: string;
    outbox?: string;
    trustMode: TrustMode;
  } {
    if (!this.config.enabled) {
      return { enabled: false, trustMode: 'closed' };
    }

    return {
      enabled: true,
      inbox: `${this.config.instanceUri}/federation/inbox`,
      outbox: `${this.config.instanceUri}/federation/outbox`,
      trustMode: this.config.trust.mode
    };
  }

  // ============================================
  // ACTIVE PUSH FEDERATION
  // ============================================

  /**
   * Push an event to a specific remote instance's inbox
   */
  async pushToInstance(event: FederationEvent, instanceUri: string): Promise<{ success: boolean; error?: string }> {
    if (!this.trustsInstance(instanceUri)) {
      return { success: false, error: 'Instance not trusted' };
    }

    // Get or discover instance
    let instance: RemoteInstance | null | undefined = this.knownInstances.get(instanceUri);
    if (!instance || !instance.inbox) {
      instance = await this.discoverInstance(instanceUri);
      if (!instance) {
        return { success: false, error: 'Could not discover instance' };
      }
      if (!instance.inbox) {
        return { success: false, error: 'Instance does not accept federation inbox' };
      }
    }

    try {
      const response = await fetch(instance.inbox, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ASP-Origin': this.config.instanceUri,
        },
        body: JSON.stringify({ events: [event] }),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Update last seen
      instance.lastSeen = new Date();
      delete instance.lastError;
      this.persistInstance(instance);
      
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (instance) {
        instance.lastError = errorMsg;
        this.persistInstance(instance);
      }
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Push an event to all trusted instances
   */
  async pushToAllInstances(event: FederationEvent): Promise<Map<string, { success: boolean; error?: string }>> {
    const results = new Map<string, { success: boolean; error?: string }>();
    
    const pushPromises = Array.from(this.knownInstances.keys())
      .filter(uri => this.trustsInstance(uri))
      .map(async (uri) => {
        const result = await this.pushToInstance(event, uri);
        results.set(uri, result);
      });

    await Promise.allSettled(pushPromises);
    return results;
  }

  /**
   * Queue an event for delivery with retry logic
   */
  queueForDelivery(eventId: string, event: FederationEvent, targetInstances?: string[]): void {
    const targets = targetInstances || Array.from(this.knownInstances.keys()).filter(uri => this.trustsInstance(uri));
    
    for (const instanceUri of targets) {
      const key = `${instanceUri}:${eventId}`;
      if (!this.deliveryQueue.has(key)) {
        const attempt: DeliveryAttempt = {
          instanceUri,
          eventId,
          attemptCount: 0,
          lastAttempt: new Date(0),
          nextAttempt: new Date(),
          status: 'pending'
        };
        this.deliveryQueue.set(key, attempt);
        this.persistDeliveryAttempt(key, attempt);
      }
    }
  }

  /**
   * Process the delivery queue - call periodically
   */
  async processDeliveryQueue(): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0, succeeded = 0, failed = 0;
    const now = new Date();

    for (const [key, attempt] of this.deliveryQueue) {
      if (attempt.status !== 'pending' || attempt.nextAttempt > now) continue;

      const outboxEvent = Array.from(this.outboxQueue.values())
        .find(e => e.id === attempt.eventId);
      
      if (!outboxEvent) {
        // Event no longer exists, remove from queue
        this.deliveryQueue.delete(key);
        continue;
      }

      processed++;
      const result = await this.pushToInstance(outboxEvent.event, attempt.instanceUri);
      
      attempt.attemptCount++;
      attempt.lastAttempt = now;

      if (result.success) {
        attempt.status = 'delivered';
        outboxEvent.delivered.add(attempt.instanceUri);
        this.persistOutboxEvent(outboxEvent); // Save delivery record
        succeeded++;
      } else {
        attempt.lastError = result.error;
        
        if (attempt.attemptCount >= this.MAX_RETRY_ATTEMPTS) {
          attempt.status = 'failed';
          failed++;
        } else {
          // Exponential backoff
          const backoffMs = this.RETRY_BACKOFF_MS[Math.min(attempt.attemptCount - 1, this.RETRY_BACKOFF_MS.length - 1)];
          attempt.nextAttempt = new Date(now.getTime() + backoffMs);
        }
      }
      
      // Persist delivery attempt update
      this.persistDeliveryAttempt(key, attempt);
    }

    // Prune old delivered/failed entries (keep for 1 hour for debugging)
    const oneHourAgo = new Date(now.getTime() - 3600000);
    for (const [key, attempt] of this.deliveryQueue) {
      if (attempt.status !== 'pending' && attempt.lastAttempt < oneHourAgo) {
        this.deliveryQueue.delete(key);
        this.storage?.deleteDeliveryAttempt(key);
      }
    }

    return { processed, succeeded, failed };
  }

  /**
   * Start the background push processor
   */
  startPushProcessor(intervalMs: number = 5000): void {
    if (this.pushInterval) {
      clearInterval(this.pushInterval);
    }
    
    this.pushInterval = setInterval(async () => {
      try {
        await this.processDeliveryQueue();
      } catch (error) {
        console.error('[Federation] Push processor error:', error);
      }
    }, intervalMs);

    console.log(`[Federation] Push processor started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop the background push processor
   */
  stopPushProcessor(): void {
    if (this.pushInterval) {
      clearInterval(this.pushInterval);
      this.pushInterval = null;
      console.log('[Federation] Push processor stopped');
    }
  }

  /**
   * Get delivery queue status for monitoring
   */
  getDeliveryQueueStatus(): {
    pending: number;
    delivered: number;
    failed: number;
    items: DeliveryAttempt[];
  } {
    const items = Array.from(this.deliveryQueue.values());
    return {
      pending: items.filter(i => i.status === 'pending').length,
      delivered: items.filter(i => i.status === 'delivered').length,
      failed: items.filter(i => i.status === 'failed').length,
      items
    };
  }

  /**
   * Subscribe to a remote instance - add to known instances and begin polling/pushing
   */
  async subscribeToInstance(instanceUri: string): Promise<{ success: boolean; instance?: RemoteInstance; error?: string }> {
    const discovered = await this.discoverInstance(instanceUri);
    if (!discovered) {
      return { success: false, error: 'Could not discover instance' };
    }

    if (discovered.trustMode === 'closed') {
      return { success: false, error: 'Instance federation is closed', instance: discovered };
    }

    this.allowInstance(instanceUri);
    return { success: true, instance: discovered };
  }

  /**
   * Enhanced publishEvent that also queues for active push
   */
  publishAndPush(type: FederationEvent['type'], object: Post | Comment): string {
    const eventId = this.publishEvent(type, object);
    const outboxEvent = this.outboxQueue.get(eventId);
    
    if (outboxEvent) {
      this.queueForDelivery(eventId, outboxEvent.event);
    }
    
    return eventId;
  }
}

/**
 * Create default federation config
 */
export function createFederationConfig(
  instanceUri: string,
  enabled: boolean = false,
  mode: TrustMode = 'closed',
  signingKey?: string
): FederationConfig {
  return {
    enabled,
    instanceUri,
    trust: {
      mode,
      allowlist: new Set(),
      blocklist: new Set()
    },
    signingKey
  };
}
