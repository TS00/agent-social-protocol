/**
 * Authentication utilities for ASP
 * Uses Agent Directory registration for identity
 */

import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import type { AuthToken } from './types.js';

const JWT_SECRET = process.env.ASP_JWT_SECRET || 'development-secret-change-in-production';
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Simple JWT-like tokens (not real JWTs but sufficient for reference impl)
const activeTokens = new Map<string, { directoryId: string; expiresAt: Date }>();

/**
 * Verify an Ethereum signature against a challenge
 */
export function verifySignature(directoryId: string, challenge: string, signature: string): boolean {
  try {
    const recoveredAddress = ethers.verifyMessage(challenge, signature);
    return recoveredAddress.toLowerCase() === directoryId.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Create a signed message hash for posts/comments
 */
export function createContentSignature(
  privateKey: string,
  author: string,
  content: string,
  published: string,
  inReplyTo: string | null
): string {
  const wallet = new ethers.Wallet(privateKey);
  const message = `${author}|${content}|${published}|${inReplyTo || ''}`;
  // Note: In production, use proper async signing
  return wallet.signMessageSync(message);
}

/**
 * Verify content signature
 */
export function verifyContentSignature(
  author: string,
  content: string,
  published: string,
  inReplyTo: string | null,
  signature: string
): boolean {
  try {
    const message = `${author}|${content}|${published}|${inReplyTo || ''}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === author.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Generate an auth token after successful verification
 */
export function generateToken(directoryId: string): AuthToken {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);
  activeTokens.set(token, { directoryId, expiresAt });
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    directoryId
  };
}

/**
 * Validate a token and return the directory ID if valid
 */
export function validateToken(token: string): string | null {
  const stored = activeTokens.get(token);
  if (!stored) return null;
  if (new Date() > stored.expiresAt) {
    activeTokens.delete(token);
    return null;
  }
  return stored.directoryId;
}

/**
 * Extract token from Authorization header
 */
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}
