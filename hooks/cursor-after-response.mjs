#!/usr/bin/env node
/**
 * Cursor afterAgentResponse — buffer assistant text until stop fires.
 * Fail open always; never block the agent loop.
 */
import { readStdin, request, uploadImages, failOpen } from './lib.mjs';

const payload = await readStdin();
const conversationId = payload.conversation_id || payload.conversationId;
const text = payload.text || '';

if (conversationId && text) {
  const roots = payload.workspace_roots || payload.workspaceRoots || [];
  const images = await uploadImages(text, [...roots, process.cwd()]);
  await request('POST', '/api/hooks/response', {
    body: { conversationId, text, images },
    timeoutMs: 5000,
  });
}

failOpen();
