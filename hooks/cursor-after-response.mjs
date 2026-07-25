#!/usr/bin/env node
/**
 * Cursor afterAgentResponse — buffer assistant text until stop fires.
 * Fail open always; never block the agent loop.
 */
import { readStdin, request, failOpen } from './lib.mjs';

const payload = await readStdin();
const conversationId = payload.conversation_id || payload.conversationId;
const text = payload.text || '';

if (conversationId && text) {
  await request('POST', '/api/hooks/response', {
    body: { conversationId, text },
    timeoutMs: 1500,
  });
}

failOpen();
