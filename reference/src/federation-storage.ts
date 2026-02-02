/**
 * Federation Storage Layer
 * Persists federation state (instances, outbox, delivery queue) to SQLite
 */

import Database from 'better-sqlite3';
import type { FederationEvent } from './types.js';

// Types matching FederationManager's internal structures
export interface PersistedRemoteInstance {
  uri: string;
  version: string;
  inbox?: string;
  outbox?: string;
  trustMode: string;
  lastSeen: string; // ISO date
  lastError?: string;
  isAllowed: boolean;
  isBlocked: boolean;
}

export interface PersistedOutboxEvent {
  id: string;
  event: FederationEvent;
  created: string; // ISO date
  deliveredTo: string[]; // Instance URIs
}

export interface PersistedDeliveryAttempt {
  key: string; // `${instanceUri}:${eventId}`
  instanceUri: string;
  eventId: string;
  attemptCount: number;
  lastAttempt: string; // ISO date
  nextAttempt: string; // ISO date
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string;
}

/**
 * Federation Storage Interface
 */
export interface FederationStorage {
  // Instance management
  saveInstance(instance: PersistedRemoteInstance): void;
  getInstances(): PersistedRemoteInstance[];
  deleteInstance(uri: string): void;

  // Outbox
  saveOutboxEvent(event: PersistedOutboxEvent): void;
  getOutboxEvent(id: string): PersistedOutboxEvent | null;
  getOutboxEvents(options?: { limit?: number; since?: string }): PersistedOutboxEvent[];
  markDelivered(eventId: string, instanceUri: string): void;
  deleteOutboxEvent(id: string): void;
  pruneOldOutboxEvents(maxAge: number, maxCount: number): number;

  // Delivery queue
  saveDeliveryAttempt(attempt: PersistedDeliveryAttempt): void;
  getDeliveryAttempt(key: string): PersistedDeliveryAttempt | null;
  getPendingDeliveries(beforeTime: string): PersistedDeliveryAttempt[];
  deleteDeliveryAttempt(key: string): void;
  pruneOldDeliveries(olderThan: string): number;
  getDeliveryStats(): { pending: number; delivered: number; failed: number };
}

/**
 * SQLite implementation of FederationStorage
 */
export class SQLiteFederationStorage implements FederationStorage {
  private db: Database.Database;

  constructor(dbPath: string = 'asp.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_instances (
        uri TEXT PRIMARY KEY,
        version TEXT,
        inbox TEXT,
        outbox TEXT,
        trust_mode TEXT NOT NULL DEFAULT 'closed',
        last_seen TEXT NOT NULL,
        last_error TEXT,
        is_allowed INTEGER NOT NULL DEFAULT 0,
        is_blocked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS federation_outbox (
        id TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        created TEXT NOT NULL,
        delivered_to TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS federation_delivery_queue (
        key TEXT PRIMARY KEY,
        instance_uri TEXT NOT NULL,
        event_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt TEXT NOT NULL,
        next_attempt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_status ON federation_delivery_queue(status);
      CREATE INDEX IF NOT EXISTS idx_delivery_next_attempt ON federation_delivery_queue(next_attempt);
      CREATE INDEX IF NOT EXISTS idx_outbox_created ON federation_outbox(created DESC);
    `);
  }

  // Instance management
  saveInstance(instance: PersistedRemoteInstance): void {
    const stmt = this.db.prepare(`
      INSERT INTO federation_instances (uri, version, inbox, outbox, trust_mode, last_seen, last_error, is_allowed, is_blocked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        version = excluded.version,
        inbox = excluded.inbox,
        outbox = excluded.outbox,
        trust_mode = excluded.trust_mode,
        last_seen = excluded.last_seen,
        last_error = excluded.last_error,
        is_allowed = excluded.is_allowed,
        is_blocked = excluded.is_blocked
    `);
    stmt.run(
      instance.uri,
      instance.version,
      instance.inbox || null,
      instance.outbox || null,
      instance.trustMode,
      instance.lastSeen,
      instance.lastError || null,
      instance.isAllowed ? 1 : 0,
      instance.isBlocked ? 1 : 0
    );
  }

  getInstances(): PersistedRemoteInstance[] {
    const stmt = this.db.prepare('SELECT * FROM federation_instances');
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      uri: row.uri,
      version: row.version,
      inbox: row.inbox || undefined,
      outbox: row.outbox || undefined,
      trustMode: row.trust_mode,
      lastSeen: row.last_seen,
      lastError: row.last_error || undefined,
      isAllowed: row.is_allowed === 1,
      isBlocked: row.is_blocked === 1
    }));
  }

  deleteInstance(uri: string): void {
    const stmt = this.db.prepare('DELETE FROM federation_instances WHERE uri = ?');
    stmt.run(uri);
  }

  // Outbox
  saveOutboxEvent(event: PersistedOutboxEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO federation_outbox (id, event_json, created, delivered_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        event_json = excluded.event_json,
        delivered_to = excluded.delivered_to
    `);
    stmt.run(
      event.id,
      JSON.stringify(event.event),
      event.created,
      JSON.stringify(event.deliveredTo)
    );
  }

  getOutboxEvent(id: string): PersistedOutboxEvent | null {
    const stmt = this.db.prepare('SELECT * FROM federation_outbox WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      event: JSON.parse(row.event_json),
      created: row.created,
      deliveredTo: JSON.parse(row.delivered_to)
    };
  }

  getOutboxEvents(options: { limit?: number; since?: string } = {}): PersistedOutboxEvent[] {
    const limit = options.limit || 100;
    let query = 'SELECT * FROM federation_outbox';
    const params: any[] = [];

    if (options.since) {
      // Get events newer than the "since" cursor
      const sinceEvent = this.getOutboxEvent(options.since);
      if (sinceEvent) {
        query += ' WHERE created > ?';
        params.push(sinceEvent.created);
      }
    }

    query += ' ORDER BY created ASC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    
    return rows.map(row => ({
      id: row.id,
      event: JSON.parse(row.event_json),
      created: row.created,
      deliveredTo: JSON.parse(row.delivered_to)
    }));
  }

  markDelivered(eventId: string, instanceUri: string): void {
    const event = this.getOutboxEvent(eventId);
    if (event && !event.deliveredTo.includes(instanceUri)) {
      event.deliveredTo.push(instanceUri);
      this.saveOutboxEvent(event);
    }
  }

  deleteOutboxEvent(id: string): void {
    const stmt = this.db.prepare('DELETE FROM federation_outbox WHERE id = ?');
    stmt.run(id);
  }

  pruneOldOutboxEvents(maxAgeMs: number, maxCount: number): number {
    const cutoffTime = new Date(Date.now() - maxAgeMs).toISOString();
    
    // Delete events older than maxAge
    const deleteOld = this.db.prepare('DELETE FROM federation_outbox WHERE created < ?');
    const oldDeleted = deleteOld.run(cutoffTime).changes;

    // If still over maxCount, delete oldest
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM federation_outbox');
    const { count } = countStmt.get() as { count: number };
    
    let extraDeleted = 0;
    if (count > maxCount) {
      const excess = count - maxCount;
      const deleteExcess = this.db.prepare(`
        DELETE FROM federation_outbox WHERE id IN (
          SELECT id FROM federation_outbox ORDER BY created ASC LIMIT ?
        )
      `);
      extraDeleted = deleteExcess.run(excess).changes;
    }

    return oldDeleted + extraDeleted;
  }

  // Delivery queue
  saveDeliveryAttempt(attempt: PersistedDeliveryAttempt): void {
    const stmt = this.db.prepare(`
      INSERT INTO federation_delivery_queue (key, instance_uri, event_id, attempt_count, last_attempt, next_attempt, status, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        attempt_count = excluded.attempt_count,
        last_attempt = excluded.last_attempt,
        next_attempt = excluded.next_attempt,
        status = excluded.status,
        last_error = excluded.last_error
    `);
    stmt.run(
      attempt.key,
      attempt.instanceUri,
      attempt.eventId,
      attempt.attemptCount,
      attempt.lastAttempt,
      attempt.nextAttempt,
      attempt.status,
      attempt.lastError || null
    );
  }

  getDeliveryAttempt(key: string): PersistedDeliveryAttempt | null {
    const stmt = this.db.prepare('SELECT * FROM federation_delivery_queue WHERE key = ?');
    const row = stmt.get(key) as any;
    if (!row) return null;
    return {
      key: row.key,
      instanceUri: row.instance_uri,
      eventId: row.event_id,
      attemptCount: row.attempt_count,
      lastAttempt: row.last_attempt,
      nextAttempt: row.next_attempt,
      status: row.status,
      lastError: row.last_error || undefined
    };
  }

  getPendingDeliveries(beforeTime: string): PersistedDeliveryAttempt[] {
    const stmt = this.db.prepare(`
      SELECT * FROM federation_delivery_queue 
      WHERE status = 'pending' AND next_attempt <= ?
      ORDER BY next_attempt ASC
    `);
    const rows = stmt.all(beforeTime) as any[];
    return rows.map(row => ({
      key: row.key,
      instanceUri: row.instance_uri,
      eventId: row.event_id,
      attemptCount: row.attempt_count,
      lastAttempt: row.last_attempt,
      nextAttempt: row.next_attempt,
      status: row.status,
      lastError: row.last_error || undefined
    }));
  }

  deleteDeliveryAttempt(key: string): void {
    const stmt = this.db.prepare('DELETE FROM federation_delivery_queue WHERE key = ?');
    stmt.run(key);
  }

  pruneOldDeliveries(olderThan: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM federation_delivery_queue 
      WHERE status != 'pending' AND last_attempt < ?
    `);
    return stmt.run(olderThan).changes;
  }

  getDeliveryStats(): { pending: number; delivered: number; failed: number } {
    const stmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM federation_delivery_queue GROUP BY status
    `);
    const rows = stmt.all() as { status: string; count: number }[];
    
    const stats = { pending: 0, delivered: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in stats) {
        stats[row.status as keyof typeof stats] = row.count;
      }
    }
    return stats;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * In-memory implementation for testing
 */
export class MemoryFederationStorage implements FederationStorage {
  private instances: Map<string, PersistedRemoteInstance> = new Map();
  private outbox: Map<string, PersistedOutboxEvent> = new Map();
  private deliveryQueue: Map<string, PersistedDeliveryAttempt> = new Map();

  saveInstance(instance: PersistedRemoteInstance): void {
    this.instances.set(instance.uri, instance);
  }

  getInstances(): PersistedRemoteInstance[] {
    return Array.from(this.instances.values());
  }

  deleteInstance(uri: string): void {
    this.instances.delete(uri);
  }

  saveOutboxEvent(event: PersistedOutboxEvent): void {
    this.outbox.set(event.id, event);
  }

  getOutboxEvent(id: string): PersistedOutboxEvent | null {
    return this.outbox.get(id) || null;
  }

  getOutboxEvents(options: { limit?: number; since?: string } = {}): PersistedOutboxEvent[] {
    const limit = options.limit || 100;
    let events = Array.from(this.outbox.values())
      .sort((a, b) => a.created.localeCompare(b.created));
    
    if (options.since) {
      const sinceIdx = events.findIndex(e => e.id === options.since);
      if (sinceIdx !== -1) {
        events = events.slice(sinceIdx + 1);
      }
    }
    
    return events.slice(0, limit);
  }

  markDelivered(eventId: string, instanceUri: string): void {
    const event = this.outbox.get(eventId);
    if (event && !event.deliveredTo.includes(instanceUri)) {
      event.deliveredTo.push(instanceUri);
    }
  }

  deleteOutboxEvent(id: string): void {
    this.outbox.delete(id);
  }

  pruneOldOutboxEvents(maxAgeMs: number, maxCount: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    let deleted = 0;
    
    for (const [id, event] of this.outbox) {
      if (event.created < cutoff) {
        this.outbox.delete(id);
        deleted++;
      }
    }
    
    if (this.outbox.size > maxCount) {
      const sorted = Array.from(this.outbox.entries())
        .sort((a, b) => a[1].created.localeCompare(b[1].created));
      const toDelete = sorted.slice(0, sorted.length - maxCount);
      for (const [id] of toDelete) {
        this.outbox.delete(id);
        deleted++;
      }
    }
    
    return deleted;
  }

  saveDeliveryAttempt(attempt: PersistedDeliveryAttempt): void {
    this.deliveryQueue.set(attempt.key, attempt);
  }

  getDeliveryAttempt(key: string): PersistedDeliveryAttempt | null {
    return this.deliveryQueue.get(key) || null;
  }

  getPendingDeliveries(beforeTime: string): PersistedDeliveryAttempt[] {
    return Array.from(this.deliveryQueue.values())
      .filter(a => a.status === 'pending' && a.nextAttempt <= beforeTime)
      .sort((a, b) => a.nextAttempt.localeCompare(b.nextAttempt));
  }

  deleteDeliveryAttempt(key: string): void {
    this.deliveryQueue.delete(key);
  }

  pruneOldDeliveries(olderThan: string): number {
    let deleted = 0;
    for (const [key, attempt] of this.deliveryQueue) {
      if (attempt.status !== 'pending' && attempt.lastAttempt < olderThan) {
        this.deliveryQueue.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  getDeliveryStats(): { pending: number; delivered: number; failed: number } {
    const stats = { pending: 0, delivered: 0, failed: 0 };
    for (const attempt of this.deliveryQueue.values()) {
      if (attempt.status in stats) {
        stats[attempt.status as keyof typeof stats]++;
      }
    }
    return stats;
  }
}
