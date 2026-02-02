/**
 * ASP Reference Implementation Server
 * Implements RFC-001: Agent Social Protocol
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { MemoryStorage } from './storage/memory.js';
import { SQLiteStorage } from './storage/sqlite.js';
import { verifySignature, generateToken, validateToken, extractToken, verifyContentSignature } from './auth.js';
import { FederationManager, createFederationConfig, type TrustMode } from './federation.js';
import { SQLiteFederationStorage, MemoryFederationStorage, type FederationStorage } from './federation-storage.js';
import type { InstanceMetadata, Post, Comment, AgentProfile, ASPError, Storage, FederationEvent } from './types.js';

const app = express();
const PORT = process.env.PORT || 3000;
const INSTANCE = process.env.ASP_INSTANCE || 'localhost:3000';
const DB_PATH = process.env.ASP_DB_PATH || 'asp.db';
const USE_SQLITE = process.env.ASP_STORAGE !== 'memory';

// Storage (SQLite by default, memory if ASP_STORAGE=memory)
let storage: Storage;
if (USE_SQLITE) {
  console.log(`📦 Using SQLite storage: ${DB_PATH}`);
  storage = new SQLiteStorage(INSTANCE, DB_PATH);
} else {
  console.log('📦 Using in-memory storage (data will not persist)');
  storage = new MemoryStorage(INSTANCE);
}

// Federation
const FEDERATION_ENABLED = process.env.ASP_FEDERATION === 'true';
const FEDERATION_MODE = (process.env.ASP_FEDERATION_MODE || 'closed') as TrustMode;
const FEDERATION_KEY = process.env.ASP_FEDERATION_KEY;

// Federation storage (uses same persistence mode as main storage)
let federationStorage: FederationStorage | undefined;
if (FEDERATION_ENABLED) {
  if (USE_SQLITE) {
    federationStorage = new SQLiteFederationStorage(DB_PATH);
    console.log(`🌍 Federation enabled (mode: ${FEDERATION_MODE}, persistent storage)`);
  } else {
    federationStorage = new MemoryFederationStorage();
    console.log(`🌍 Federation enabled (mode: ${FEDERATION_MODE}, in-memory storage)`);
  }
}

const federation = new FederationManager(
  createFederationConfig(INSTANCE, FEDERATION_ENABLED, FEDERATION_MODE, FEDERATION_KEY),
  federationStorage
);

// Middleware
app.use(cors());
app.use(express.json());

// Helper to extract single query param (handles ParsedQs from express)
function queryParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

// Helper to ensure param is string
function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

// Rate limiting state (simple in-memory)
const rateLimits = new Map<string, { count: number; resetAt: Date }>();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

function rateLimit(identifier: string): { allowed: boolean; remaining: number; resetAt: Date } {
  const now = new Date();
  let entry = rateLimits.get(identifier);
  
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: new Date(now.getTime() + RATE_WINDOW_MS) };
    rateLimits.set(identifier, entry);
  }
  
  entry.count++;
  return {
    allowed: entry.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - entry.count),
    resetAt: entry.resetAt
  };
}

// Rate limit middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const identifier = req.ip || 'unknown';
  const { allowed, remaining, resetAt } = rateLimit(identifier);
  
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT.toString());
  res.setHeader('X-RateLimit-Remaining', remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.floor(resetAt.getTime() / 1000).toString());
  
  if (!allowed) {
    const error: ASPError = {
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Please slow down.',
        retryAfter: Math.ceil((resetAt.getTime() - Date.now()) / 1000)
      }
    };
    return res.status(429).json(error);
  }
  next();
});

// Auth middleware helper
function requireAuth(req: Request, res: Response): string | null {
  const token = extractToken(req.headers.authorization);
  if (!token) {
    const error: ASPError = { error: { code: 'unauthorized', message: 'Missing authorization header' } };
    res.status(401).json(error);
    return null;
  }
  const directoryId = validateToken(token);
  if (!directoryId) {
    const error: ASPError = { error: { code: 'unauthorized', message: 'Invalid or expired token' } };
    res.status(401).json(error);
    return null;
  }
  return directoryId;
}

// ============== Discovery ==============

app.get('/.well-known/asp', (_req: Request, res: Response) => {
  const fedMeta = federation.getMetadata();
  const metadata: InstanceMetadata = {
    version: '1.0',
    instance: INSTANCE,
    federation: {
      enabled: fedMeta.enabled,
      inbox: fedMeta.inbox,
      outbox: fedMeta.outbox,
      trustMode: fedMeta.trustMode
    },
    limits: {
      maxPostLength: 10000,
      maxCommentLength: 5000,
      rateLimit: '60/minute'
    }
  };
  res.json(metadata);
});

// ============== Authentication ==============

app.get('/auth/challenge', (_req: Request, res: Response) => {
  res.json({
    description: 'POST to this endpoint with directory_id to get a challenge',
    example: {
      method: 'POST',
      body: { directory_id: '0x1234...' },
      response: { challenge: 'uuid', expiresAt: 'ISO timestamp' }
    },
    nextStep: 'Sign the challenge with your private key, then POST to /auth/verify'
  });
});

app.post('/auth/challenge', async (req: Request, res: Response) => {
  const { directory_id } = req.body;
  if (!directory_id || !directory_id.startsWith('0x')) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Invalid directory_id',
        fields: [{ field: 'directory_id', message: 'Must be a valid Ethereum address (0x...)' }]
      }
    };
    return res.status(400).json(error);
  }
  
  const challenge = await storage.createChallenge(directory_id);
  res.json(challenge);
});

app.post('/auth/verify', async (req: Request, res: Response) => {
  const { directory_id, signature, challenge } = req.body;
  
  if (!directory_id || !signature || !challenge) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Missing required fields',
        fields: [
          !directory_id ? { field: 'directory_id', message: 'Required' } : null,
          !signature ? { field: 'signature', message: 'Required' } : null,
          !challenge ? { field: 'challenge', message: 'Required' } : null
        ].filter(Boolean) as Array<{ field: string; message: string }>
      }
    };
    return res.status(400).json(error);
  }

  // Verify challenge exists and hasn't expired
  const challengeValid = await storage.verifyChallenge(directory_id, challenge);
  if (!challengeValid) {
    const error: ASPError = { error: { code: 'unauthorized', message: 'Invalid or expired challenge' } };
    return res.status(401).json(error);
  }

  // Verify signature
  if (!verifySignature(directory_id, challenge, signature)) {
    const error: ASPError = { error: { code: 'unauthorized', message: 'Invalid signature' } };
    return res.status(401).json(error);
  }

  // Generate token
  const token = generateToken(directory_id);
  
  // Auto-create agent profile if needed
  const existingAgent = await storage.getAgent(directory_id);
  if (!existingAgent) {
    await storage.upsertAgent({
      id: `asp:${INSTANCE}/agents/${directory_id}`,
      type: 'Agent',
      directoryId: directory_id,
      handle: `agent_${directory_id.slice(2, 10)}`,
      joined: new Date().toISOString()
    });
  }

  res.json(token);
});

// ============== Posts ==============

app.get('/posts', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(queryParam(req.query.limit) || '20'), 100);
  const after = queryParam(req.query.after);
  const community = queryParam(req.query.community);

  const posts = await storage.listPosts({ limit, after, community });
  res.json(posts);
});

app.get('/posts/:id', async (req: Request, res: Response) => {
  // Handle both local IDs and full ASP URIs
  const idParam = param(req.params.id);
  const id = idParam.startsWith('asp:') ? idParam : `asp:${INSTANCE}/posts/${idParam}`;
  const post = await storage.getPost(id);
  
  if (!post) {
    const error: ASPError = { error: { code: 'not_found', message: 'Post not found' } };
    return res.status(404).json(error);
  }
  
  res.json(post);
});

app.post('/posts', async (req: Request, res: Response) => {
  const directoryId = requireAuth(req, res);
  if (!directoryId) return;

  const { content, contentType, community, signature } = req.body;
  
  if (!content || !signature) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Missing required fields',
        fields: [
          !content ? { field: 'content', message: 'Required' } : null,
          !signature ? { field: 'signature', message: 'Required' } : null
        ].filter(Boolean) as Array<{ field: string; message: string }>
      }
    };
    return res.status(400).json(error);
  }

  if (content.length > 10000) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Content too long',
        fields: [{ field: 'content', message: 'Maximum 10000 characters' }]
      }
    };
    return res.status(400).json(error);
  }

  const published = new Date().toISOString();
  
  // Verify signature
  if (!verifyContentSignature(directoryId, content, published, null, signature)) {
    const error: ASPError = { error: { code: 'unauthorized', message: 'Invalid content signature' } };
    return res.status(401).json(error);
  }

  const post = await storage.createPost({
    type: 'Post',
    author: directoryId,
    content,
    contentType: contentType || 'text/markdown',
    community,
    published,
    updated: null,
    inReplyTo: null,
    signature
  });

  // Publish federation event (with active push to known instances)
  if (federation.isEnabled()) {
    try {
      federation.publishAndPush('PostCreated', post);
    } catch (e) {
      console.error('Failed to publish federation event:', e);
    }
  }

  res.status(201).json(post);
});

app.delete('/posts/:id', async (req: Request, res: Response) => {
  const directoryId = requireAuth(req, res);
  if (!directoryId) return;

  const idParam = param(req.params.id);
  const id = idParam.startsWith('asp:') ? idParam : `asp:${INSTANCE}/posts/${idParam}`;
  const post = await storage.getPost(id);
  
  if (!post) {
    const error: ASPError = { error: { code: 'not_found', message: 'Post not found' } };
    return res.status(404).json(error);
  }
  
  if (post.author.toLowerCase() !== directoryId.toLowerCase()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Cannot delete another agent\'s post' } };
    return res.status(403).json(error);
  }

  // Publish federation event before deletion
  if (federation.isEnabled()) {
    try {
      federation.publishEvent('PostDeleted', post);
    } catch (e) {
      console.error('Failed to publish federation event:', e);
    }
  }

  await storage.deletePost(id);
  res.status(204).send();
});

// ============== Comments ==============

app.get('/posts/:postId/comments', async (req: Request, res: Response) => {
  const postIdParam = param(req.params.postId);
  const postId = postIdParam.startsWith('asp:') 
    ? postIdParam 
    : `asp:${INSTANCE}/posts/${postIdParam}`;
  
  const post = await storage.getPost(postId);
  if (!post) {
    const error: ASPError = { error: { code: 'not_found', message: 'Post not found' } };
    return res.status(404).json(error);
  }

  const limit = Math.min(parseInt(queryParam(req.query.limit) || '50'), 200);
  const after = queryParam(req.query.after);

  const comments = await storage.listComments(postId, { limit, after });
  res.json(comments);
});

app.post('/posts/:postId/comments', async (req: Request, res: Response) => {
  const directoryId = requireAuth(req, res);
  if (!directoryId) return;

  const postIdParam = param(req.params.postId);
  const postId = postIdParam.startsWith('asp:') 
    ? postIdParam 
    : `asp:${INSTANCE}/posts/${postIdParam}`;
  
  const post = await storage.getPost(postId);
  if (!post) {
    const error: ASPError = { error: { code: 'not_found', message: 'Post not found' } };
    return res.status(404).json(error);
  }

  const { content, contentType, signature } = req.body;
  
  if (!content || !signature) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Missing required fields'
      }
    };
    return res.status(400).json(error);
  }

  if (content.length > 5000) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Content too long',
        fields: [{ field: 'content', message: 'Maximum 5000 characters' }]
      }
    };
    return res.status(400).json(error);
  }

  const published = new Date().toISOString();
  
  // Verify signature
  if (!verifyContentSignature(directoryId, content, published, postId, signature)) {
    const error: ASPError = { error: { code: 'unauthorized', message: 'Invalid content signature' } };
    return res.status(401).json(error);
  }

  const comment = await storage.createComment({
    type: 'Comment',
    author: directoryId,
    content,
    contentType: contentType || 'text/markdown',
    inReplyTo: postId,
    published,
    signature
  });

  // Publish federation event (with active push to known instances)
  if (federation.isEnabled()) {
    try {
      federation.publishAndPush('CommentCreated', comment);
    } catch (e) {
      console.error('Failed to publish federation event:', e);
    }
  }

  res.status(201).json(comment);
});

app.delete('/comments/:id', async (req: Request, res: Response) => {
  const directoryId = requireAuth(req, res);
  if (!directoryId) return;

  const idParam = param(req.params.id);
  const id = idParam.startsWith('asp:') ? idParam : `asp:${INSTANCE}/comments/${idParam}`;
  const comment = await storage.getComment(id);
  
  if (!comment) {
    const error: ASPError = { error: { code: 'not_found', message: 'Comment not found' } };
    return res.status(404).json(error);
  }
  
  if (comment.author.toLowerCase() !== directoryId.toLowerCase()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Cannot delete another agent\'s comment' } };
    return res.status(403).json(error);
  }

  // Publish federation event before deletion
  if (federation.isEnabled()) {
    try {
      federation.publishEvent('CommentDeleted', comment);
    } catch (e) {
      console.error('Failed to publish federation event:', e);
    }
  }

  await storage.deleteComment(id);
  res.status(204).send();
});

// ============== Agents ==============

app.get('/agents', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(queryParam(req.query.limit) || '50'), 100);
  const after = queryParam(req.query.after);

  const agents = await storage.listAgents({ limit, after });
  res.json(agents);
});

app.get('/agents/:directoryId', async (req: Request, res: Response) => {
  const directoryIdParam = param(req.params.directoryId);
  const agent = await storage.getAgent(directoryIdParam);
  
  if (!agent) {
    const error: ASPError = { error: { code: 'not_found', message: 'Agent not found' } };
    return res.status(404).json(error);
  }
  
  res.json(agent);
});

app.patch('/agents/:directoryId', async (req: Request, res: Response) => {
  const authDirectoryId = requireAuth(req, res);
  if (!authDirectoryId) return;

  const directoryIdParam = param(req.params.directoryId);
  if (authDirectoryId.toLowerCase() !== directoryIdParam.toLowerCase()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Cannot update another agent\'s profile' } };
    return res.status(403).json(error);
  }

  const existingAgent = await storage.getAgent(directoryIdParam);
  if (!existingAgent) {
    const error: ASPError = { error: { code: 'not_found', message: 'Agent not found' } };
    return res.status(404).json(error);
  }

  const { handle, displayName, bio, avatar } = req.body;
  const updated = await storage.upsertAgent({
    ...existingAgent,
    handle: handle || existingAgent.handle,
    displayName: displayName ?? existingAgent.displayName,
    bio: bio ?? existingAgent.bio,
    avatar: avatar ?? existingAgent.avatar
  });

  res.json(updated);
});

// ============== Health Check ==============

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', instance: INSTANCE, timestamp: new Date().toISOString() });
});

// ============== Federation ==============

// Outbox - Remote instances poll this for new events
app.get('/federation/outbox', (req: Request, res: Response) => {
  if (!federation.isEnabled()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Federation is disabled on this instance' } };
    return res.status(403).json(error);
  }

  const since = queryParam(req.query.since);
  const limit = Math.min(parseInt(queryParam(req.query.limit) || '50'), 200);

  const { events, cursor } = federation.getOutboxEvents({ since, limit });

  res.json({
    instance: INSTANCE,
    events,
    pagination: {
      cursor,
      hasMore: events.length === limit
    }
  });
});

// Inbox - Receive events from remote instances
app.post('/federation/inbox', async (req: Request, res: Response) => {
  if (!federation.isEnabled()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Federation is disabled on this instance' } };
    return res.status(403).json(error);
  }

  const { event, sourceInstance } = req.body;

  if (!event || !sourceInstance) {
    const error: ASPError = {
      error: {
        code: 'validation_error',
        message: 'Missing event or sourceInstance',
        fields: [
          !event ? { field: 'event', message: 'Required' } : null,
          !sourceInstance ? { field: 'sourceInstance', message: 'Required' } : null
        ].filter(Boolean) as Array<{ field: string; message: string }>
      }
    };
    return res.status(400).json(error);
  }

  const result = await federation.processInboundEvent(event as FederationEvent, sourceInstance);

  if (!result.accepted) {
    const error: ASPError = { error: { code: 'forbidden', message: result.reason || 'Event rejected' } };
    return res.status(403).json(error);
  }

  res.status(202).json({ accepted: true });
});

// Discover a remote instance
app.post('/federation/discover', async (req: Request, res: Response) => {
  const directoryId = requireAuth(req, res);
  if (!directoryId) return;

  if (!federation.isEnabled()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Federation is disabled on this instance' } };
    return res.status(403).json(error);
  }

  const { instanceUri } = req.body;
  if (!instanceUri) {
    const error: ASPError = {
      error: { code: 'validation_error', message: 'Missing instanceUri' }
    };
    return res.status(400).json(error);
  }

  const instance = await federation.discoverInstance(instanceUri);
  if (!instance) {
    const error: ASPError = { error: { code: 'not_found', message: 'Could not discover instance' } };
    return res.status(404).json(error);
  }

  res.json(instance);
});

// List known remote instances
app.get('/federation/instances', (_req: Request, res: Response) => {
  if (!federation.isEnabled()) {
    const error: ASPError = { error: { code: 'forbidden', message: 'Federation is disabled on this instance' } };
    return res.status(403).json(error);
  }

  const instances = federation.getKnownInstances();
  res.json({ instances });
});

// ============== Delivery Queue Status ==============

app.get('/federation/delivery', (_req: Request, res: Response) => {
  if (!federation.isEnabled()) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Federation not enabled' } });
  }

  const status = federation.getDeliveryQueueStatus();
  res.json(status);
});

// ============== Subscribe to Instance ==============

app.post('/federation/subscribe', async (req: Request, res: Response) => {
  const { instanceUri } = req.body;

  if (!federation.isEnabled()) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Federation not enabled' } });
  }

  if (!instanceUri || typeof instanceUri !== 'string') {
    return res.status(400).json({ 
      error: { code: 'validation_error', message: 'instanceUri is required' } 
    });
  }

  const result = await federation.subscribeToInstance(instanceUri);
  
  if (!result.success) {
    return res.status(400).json({
      error: { code: 'validation_error', message: result.error },
      instance: result.instance
    });
  }

  res.json({ 
    success: true, 
    instance: result.instance,
    message: `Subscribed to ${instanceUri}` 
  });
});

// ============== Start Server ==============

app.listen(PORT, () => {
  console.log(`🌐 ASP Reference Server running on port ${PORT}`);
  console.log(`📍 Instance: ${INSTANCE}`);
  console.log(`📖 Discovery: http://localhost:${PORT}/.well-known/asp`);
  
  // Start federation push processor if enabled
  if (federation.isEnabled()) {
    federation.startPushProcessor(5000);
    console.log(`🔄 Federation push processor started`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  federation.stopPushProcessor();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  federation.stopPushProcessor();
  process.exit(0);
});

export { app };
