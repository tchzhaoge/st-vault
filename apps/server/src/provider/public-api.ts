import { ProviderError } from './http.js';

/** Shared ID guard for status polling, covers and anonymous browser proofs. */
export function broadcastResponse(text: string, modelId: number): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('invalid-upstream-json');
  }
  const item = body && typeof body === 'object' && 'item' in body ? body.item : null;
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new ProviderError('upstream-item-unavailable');
  if ('modelId' in item && item.modelId !== modelId)
    throw new ProviderError('upstream-identity-mismatch');
  return item as Record<string, unknown>;
}
