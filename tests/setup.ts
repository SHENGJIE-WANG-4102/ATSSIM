import { afterEach, beforeEach } from 'vitest';

// The simulation tests are long synchronous loops. Yield to the event loop
// around each test so the vitest worker can answer its RPC heartbeats.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
beforeEach(tick);
afterEach(tick);
