import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { AppError } from './errorHandler';

/**
 * API Key Authentication Middleware
 * Validates API key from Authorization header or X-API-Key header
 * 
 * Usage:
 * - Header: Authorization: Bearer <api-key>
 * - Header: X-API-Key: <api-key>
 */
export const apiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  // Get API key from headers
  let apiKey: string | undefined;

  // Try Authorization header first (Bearer token format)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  }

  // Try X-API-Key header
  if (!apiKey) {
    apiKey = req.headers['x-api-key'] as string;
  }

  // Try query parameter (less secure, but useful for some cases)
  if (!apiKey && req.query.apiKey) {
    apiKey = req.query.apiKey as string;
  }

  // Validate API key
  if (!apiKey) {
    return next(new AppError(
      'API key required. Please provide API key in Authorization header (Bearer <key>) or X-API-Key header.',
      401,
      'NO_API_KEY'
    ));
  }

  // Compare API key (use constant-time comparison to prevent timing attacks)
  if (!constantTimeCompare(apiKey, config.apiKey)) {
    return next(new AppError(
      'Invalid API key.',
      401,
      'INVALID_API_KEY'
    ));
  }

  // API key is valid, continue
  next();
};

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Optional API Key Authentication
 * Validates API key if provided, but doesn't require it
 */
export const optionalApiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  let apiKey: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  }

  if (!apiKey) {
    apiKey = req.headers['x-api-key'] as string;
  }

  if (apiKey && !constantTimeCompare(apiKey, config.apiKey)) {
    return next(new AppError('Invalid API key.', 401, 'INVALID_API_KEY'));
  }

  next();
};
