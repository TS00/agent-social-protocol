/**
 * SQLite storage implementation
 * Persistent storage for production use
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Storage, Post, Comment, AgentProfile, PaginatedResponse, AuthChallenge } from '../types.js';

export class SQLiteStorage implements Storage {
  private instance: string;
  private db: Database.Database;

  constructor(instance: string, dbPath: string = 'asp.db') {
    this.instance = instance;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/markdown',
        community TEXT,
        published TEXT NOT NULL,
        updated TEXT,
        in_reply_to TEXT,
        signature TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/markdown',
        in_reply_to TEXT NOT NULL,
        published TEXT NOT NULL,
        signature TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        directory_id TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT,
        bio TEXT,
        avatar TEXT,
        joined TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS challenges (
        directory_id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community);
      CREATE INDEX IF NOT EXISTS idx_comments_in_reply_to ON comments(in_reply_to);
    `);
  }

  private makePostId(): string {
    return `asp:${this.instance}/posts/${randomUUID().slice(0, 8)}`;
  }

  private makeCommentId(): string {
    return `asp:${this.instance}/comments/${randomUUID().slice(0, 8)}`;
  }

  private makeAgentId(directoryId: string): string {
    return `asp:${this.instance}/agents/${directoryId}`;
  }

  // Posts
  async createPost(post: Omit<Post, 'id'>): Promise<Post> {
    const id = this.makePostId();
    const stmt = this.db.prepare(`
      INSERT INTO posts (id, author, content, content_type, community, published, updated, in_reply_to, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      post.author,
      post.content,
      post.contentType,
      post.community || null,
      post.published,
      post.updated || null,
      post.inReplyTo || null,
      post.signature
    );
    return { ...post, id, type: 'Post' };
  }

  async getPost(id: string): Promise<Post | null> {
    const stmt = this.db.prepare('SELECT * FROM posts WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      type: 'Post',
      author: row.author,
      content: row.content,
      contentType: row.content_type,
      community: row.community || undefined,
      published: row.published,
      updated: row.updated,
      inReplyTo: row.in_reply_to,
      signature: row.signature
    };
  }

  async listPosts(options: { limit?: number; after?: string; community?: string }): Promise<PaginatedResponse<Post>> {
    const limit = options.limit || 20;
    let query = 'SELECT * FROM posts';
    const params: any[] = [];
    const conditions: string[] = [];

    if (options.community) {
      conditions.push('community = ?');
      params.push(options.community);
    }

    if (options.after) {
      // Get the published date of the "after" post for cursor-based pagination
      const afterPost = await this.getPost(options.after);
      if (afterPost) {
        conditions.push('published < ?');
        params.push(afterPost.published);
      }
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY published DESC LIMIT ?';
    params.push(limit + 1); // Fetch one extra to check hasMore

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(row => ({
      id: row.id,
      type: 'Post' as const,
      author: row.author,
      content: row.content,
      contentType: row.content_type,
      community: row.community || undefined,
      published: row.published,
      updated: row.updated,
      inReplyTo: row.in_reply_to,
      signature: row.signature
    }));

    return {
      data,
      pagination: {
        next: hasMore && data.length > 0 ? data[data.length - 1].id : undefined,
        hasMore
      }
    };
  }

  async deletePost(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM posts WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // Comments
  async createComment(comment: Omit<Comment, 'id'>): Promise<Comment> {
    const id = this.makeCommentId();
    const stmt = this.db.prepare(`
      INSERT INTO comments (id, author, content, content_type, in_reply_to, published, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      comment.author,
      comment.content,
      comment.contentType,
      comment.inReplyTo,
      comment.published,
      comment.signature
    );
    return { ...comment, id, type: 'Comment' };
  }

  async getComment(id: string): Promise<Comment | null> {
    const stmt = this.db.prepare('SELECT * FROM comments WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      type: 'Comment',
      author: row.author,
      content: row.content,
      contentType: row.content_type,
      inReplyTo: row.in_reply_to,
      published: row.published,
      signature: row.signature
    };
  }

  async listComments(postId: string, options: { limit?: number; after?: string }): Promise<PaginatedResponse<Comment>> {
    const limit = options.limit || 50;
    let query = 'SELECT * FROM comments WHERE in_reply_to = ? OR in_reply_to LIKE ?';
    const params: any[] = [postId, `${postId}%`];

    if (options.after) {
      const afterComment = await this.getComment(options.after);
      if (afterComment) {
        query += ' AND published > ?';
        params.push(afterComment.published);
      }
    }

    query += ' ORDER BY published ASC LIMIT ?';
    params.push(limit + 1);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(row => ({
      id: row.id,
      type: 'Comment' as const,
      author: row.author,
      content: row.content,
      contentType: row.content_type,
      inReplyTo: row.in_reply_to,
      published: row.published,
      signature: row.signature
    }));

    return {
      data,
      pagination: {
        next: hasMore && data.length > 0 ? data[data.length - 1].id : undefined,
        hasMore
      }
    };
  }

  async deleteComment(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM comments WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // Agents
  async getAgent(directoryId: string): Promise<AgentProfile | null> {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE directory_id = ?');
    const row = stmt.get(directoryId) as any;
    if (!row) return null;
    return {
      id: row.id,
      type: 'Agent',
      directoryId: row.directory_id,
      handle: row.handle,
      displayName: row.display_name || undefined,
      bio: row.bio || undefined,
      avatar: row.avatar || undefined,
      joined: row.joined
    };
  }

  async listAgents(options: { limit?: number; after?: string }): Promise<PaginatedResponse<AgentProfile>> {
    const limit = options.limit || 50;
    let query = 'SELECT * FROM agents';
    const params: any[] = [];

    if (options.after) {
      // Get the join date of the "after" agent for cursor-based pagination
      const afterAgent = await this.getAgent(options.after);
      if (afterAgent) {
        query += ' WHERE joined < ?';
        params.push(afterAgent.joined);
      }
    }

    query += ' ORDER BY joined DESC LIMIT ?';
    params.push(limit + 1);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(row => ({
      id: row.id,
      type: 'Agent' as const,
      directoryId: row.directory_id,
      handle: row.handle,
      displayName: row.display_name || undefined,
      bio: row.bio || undefined,
      avatar: row.avatar || undefined,
      joined: row.joined
    }));

    return {
      data,
      pagination: {
        next: hasMore && data.length > 0 ? data[data.length - 1].directoryId : undefined,
        hasMore
      }
    };
  }

  async upsertAgent(agent: AgentProfile): Promise<AgentProfile> {
    const id = this.makeAgentId(agent.directoryId);
    const stmt = this.db.prepare(`
      INSERT INTO agents (directory_id, id, handle, display_name, bio, avatar, joined)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(directory_id) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        bio = excluded.bio,
        avatar = excluded.avatar
    `);
    stmt.run(
      agent.directoryId,
      id,
      agent.handle,
      agent.displayName || null,
      agent.bio || null,
      agent.avatar || null,
      agent.joined
    );
    return { ...agent, id };
  }

  // Auth
  async createChallenge(directoryId: string): Promise<AuthChallenge> {
    const challenge = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    
    const stmt = this.db.prepare(`
      INSERT INTO challenges (directory_id, challenge, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(directory_id) DO UPDATE SET
        challenge = excluded.challenge,
        expires_at = excluded.expires_at
    `);
    stmt.run(directoryId, challenge, expiresAt.toISOString());
    
    return { challenge, expiresAt: expiresAt.toISOString() };
  }

  async verifyChallenge(directoryId: string, challenge: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT * FROM challenges WHERE directory_id = ?');
    const row = stmt.get(directoryId) as any;
    
    if (!row) return false;
    if (new Date() > new Date(row.expires_at)) {
      this.db.prepare('DELETE FROM challenges WHERE directory_id = ?').run(directoryId);
      return false;
    }
    if (row.challenge !== challenge) return false;
    
    this.db.prepare('DELETE FROM challenges WHERE directory_id = ?').run(directoryId);
    return true;
  }

  // Cleanup expired challenges periodically
  cleanupExpiredChallenges(): void {
    const stmt = this.db.prepare('DELETE FROM challenges WHERE expires_at < ?');
    stmt.run(new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
