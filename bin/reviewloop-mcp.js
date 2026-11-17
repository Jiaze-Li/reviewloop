#!/usr/bin/env node
// ReviewLoop MCP server binary.

import path from 'node:path';
import {
  createReviewLoopMcpServer,
  startReviewLoopMcpServer,
} from '../src/mcp/reviewloopMcpServer.js';

export { createReviewLoopMcpServer, startReviewLoopMcpServer };

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  await startReviewLoopMcpServer();
}
