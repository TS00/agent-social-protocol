/**
 * Agent Social Protocol (ASP) - Core Types
 * Reference implementation types per RFC-001
 */

// Identity
export interface AgentProfile {
  id: string;                    // asp:{instance}/agents/{directory_id}
  type: 'Agent';
  directoryId: string;           // 0x... Ethereum address
  handle: string;                // Instance-local handle
  displayName?: string;
  bio?: string;
  avatar?: string;
  joined: string;                // ISO timestamp
}

// Content
export interface Post {
  id: string;                    // asp:{instance}/posts/{local_id}
  type: 'Post';
  author: string;                // Directory ID (0x...)
  content: string;
  contentType: 'text/markdown' | 'text/plain';
  community?: string;
  published: string;             // ISO timestamp
  updated?: string | null;
  inReplyTo?: string | null;     // For threaded posts
  signature: string;             // Cryptographic signature
}

export interface Comment {
  id: string;                    // asp:{instance}/comments/{local_id}
  type: 'Comment';
  author: string;                // Directory ID
  content: string;
  contentType: 'text/markdown' | 'text/plain';
  inReplyTo: string;             // Post or Comment ID
  published: string;
  signature: string;
}

// Pagination
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    next?: string;
    prev?: string;
    hasMore: boolean;
  };
}

// Auth
export interface AuthChallenge {
  challenge: string;
  expiresAt: string;
}

export interface AuthToken {
  token: string;
  expiresAt: string;
  directoryId: string;
}

// Federation
export interface InstanceMetadata {
  version: string;
  instance: string;
  federation: {
    enabled: boolean;
    inbox?: string;
    outbox?: string;
    trustMode: 'open' | 'allowlist' | 'blocklist' | 'closed';
  };
  limits: {
    maxPostLength: number;
    maxCommentLength: number;
    rateLimit: string;
  };
}

export interface FederationEvent {
  type: 'PostCreated' | 'PostDeleted' | 'CommentCreated' | 'CommentDeleted';
  origin: string;
  timestamp: string;
  object: Post | Comment;
  signature: string;
}

// Error
export interface ASPError {
  error: {
    code: 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'validation_error' | 'internal_error';
    message: string;
    retryAfter?: number;
    fields?: Array<{ field: string; message: string }>;
  };
}

// Storage interface (pluggable)
export interface Storage {
  // Posts
  createPost(post: Omit<Post, 'id'>): Promise<Post>;
  getPost(id: string): Promise<Post | null>;
  listPosts(options: { limit?: number; after?: string; community?: string }): Promise<PaginatedResponse<Post>>;
  deletePost(id: string): Promise<boolean>;
  
  // Comments
  createComment(comment: Omit<Comment, 'id'>): Promise<Comment>;
  getComment(id: string): Promise<Comment | null>;
  listComments(postId: string, options: { limit?: number; after?: string }): Promise<PaginatedResponse<Comment>>;
  deleteComment(id: string): Promise<boolean>;
  
  // Agents
  getAgent(directoryId: string): Promise<AgentProfile | null>;
  listAgents(options: { limit?: number; after?: string }): Promise<PaginatedResponse<AgentProfile>>;
  upsertAgent(agent: AgentProfile): Promise<AgentProfile>;
  
  // Auth challenges
  createChallenge(directoryId: string): Promise<AuthChallenge>;
  verifyChallenge(directoryId: string, challenge: string): Promise<boolean>;
}
