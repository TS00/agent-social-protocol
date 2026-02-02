/**
 * In-memory storage implementation
 * For development and testing - not for production
 */

import { randomUUID } from 'crypto';
import type { Storage, Post, Comment, AgentProfile, PaginatedResponse, AuthChallenge } from '../types.js';

export class MemoryStorage implements Storage {
  private instance: string;
  private posts: Map<string, Post> = new Map();
  private comments: Map<string, Comment> = new Map();
  private agents: Map<string, AgentProfile> = new Map();
  private challenges: Map<string, { challenge: string; expiresAt: Date }> = new Map();

  constructor(instance: string) {
    this.instance = instance;
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
    const fullPost: Post = { ...post, id };
    this.posts.set(id, fullPost);
    return fullPost;
  }

  async getPost(id: string): Promise<Post | null> {
    return this.posts.get(id) || null;
  }

  async listPosts(options: { limit?: number; after?: string; community?: string }): Promise<PaginatedResponse<Post>> {
    const limit = options.limit || 20;
    let posts = Array.from(this.posts.values())
      .filter(p => !options.community || p.community === options.community)
      .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
    
    if (options.after) {
      const afterIndex = posts.findIndex(p => p.id === options.after);
      if (afterIndex >= 0) {
        posts = posts.slice(afterIndex + 1);
      }
    }

    const data = posts.slice(0, limit);
    const hasMore = posts.length > limit;

    return {
      data,
      pagination: {
        next: hasMore ? data[data.length - 1]?.id : undefined,
        hasMore
      }
    };
  }

  async deletePost(id: string): Promise<boolean> {
    return this.posts.delete(id);
  }

  // Comments
  async createComment(comment: Omit<Comment, 'id'>): Promise<Comment> {
    const id = this.makeCommentId();
    const fullComment: Comment = { ...comment, id };
    this.comments.set(id, fullComment);
    return fullComment;
  }

  async getComment(id: string): Promise<Comment | null> {
    return this.comments.get(id) || null;
  }

  async listComments(postId: string, options: { limit?: number; after?: string }): Promise<PaginatedResponse<Comment>> {
    const limit = options.limit || 50;
    let comments = Array.from(this.comments.values())
      .filter(c => c.inReplyTo === postId || c.inReplyTo.startsWith(postId))
      .sort((a, b) => new Date(a.published).getTime() - new Date(b.published).getTime());
    
    if (options.after) {
      const afterIndex = comments.findIndex(c => c.id === options.after);
      if (afterIndex >= 0) {
        comments = comments.slice(afterIndex + 1);
      }
    }

    const data = comments.slice(0, limit);
    const hasMore = comments.length > limit;

    return {
      data,
      pagination: {
        next: hasMore ? data[data.length - 1]?.id : undefined,
        hasMore
      }
    };
  }

  async deleteComment(id: string): Promise<boolean> {
    return this.comments.delete(id);
  }

  // Agents
  async getAgent(directoryId: string): Promise<AgentProfile | null> {
    return this.agents.get(directoryId) || null;
  }

  async listAgents(options: { limit?: number; after?: string }): Promise<PaginatedResponse<AgentProfile>> {
    const limit = options.limit || 50;
    let agents = Array.from(this.agents.values())
      .sort((a, b) => new Date(b.joined).getTime() - new Date(a.joined).getTime());
    
    if (options.after) {
      const afterIndex = agents.findIndex(a => a.directoryId === options.after);
      if (afterIndex >= 0) {
        agents = agents.slice(afterIndex + 1);
      }
    }

    const data = agents.slice(0, limit);
    const hasMore = agents.length > limit;

    return {
      data,
      pagination: {
        next: hasMore ? data[data.length - 1]?.directoryId : undefined,
        hasMore
      }
    };
  }

  async upsertAgent(agent: AgentProfile): Promise<AgentProfile> {
    const existing = this.agents.get(agent.directoryId);
    const updated = existing 
      ? { ...existing, ...agent, id: this.makeAgentId(agent.directoryId) }
      : { ...agent, id: this.makeAgentId(agent.directoryId) };
    this.agents.set(agent.directoryId, updated);
    return updated;
  }

  // Auth
  async createChallenge(directoryId: string): Promise<AuthChallenge> {
    const challenge = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    this.challenges.set(directoryId, { challenge, expiresAt });
    return { challenge, expiresAt: expiresAt.toISOString() };
  }

  async verifyChallenge(directoryId: string, challenge: string): Promise<boolean> {
    const stored = this.challenges.get(directoryId);
    if (!stored) return false;
    if (new Date() > stored.expiresAt) {
      this.challenges.delete(directoryId);
      return false;
    }
    if (stored.challenge !== challenge) return false;
    this.challenges.delete(directoryId);
    return true;
  }
}
