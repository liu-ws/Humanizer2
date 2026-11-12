import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeCodex } from '../src/integration/probe-codex.ts';

try {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId) throw new Error('Run from the original Codex chat: CODEX_THREAD_ID is required.');
  const socketPath = process.env.HUMANIZER2_CODEX_SOCKET ?? join(
    process.env.CODEX_HOME || homedir() + '/.codex', 'app-server-control', 'app-server-control.sock',
  );
  console.log(JSON.stringify(await probeCodex({ socketPath, threadId }), null, 2));
  // Reading a loaded thread alone cannot prove a browser → original chat → browser round trip.
  process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'probe-error', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
