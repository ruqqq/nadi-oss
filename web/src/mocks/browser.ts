/**
 * The MSW browser worker for the mocked app.
 *
 * REST only — no WebSocket interception. `/live` and the agent sockets are
 * handled separately (see `mocks/live.ts`), because faking the Agents/Think
 * wire protocol is an explicit non-goal.
 */

import type { RequestHandler } from "msw";
import { setupWorker } from "msw/browser";
import { restHandlers } from "./rest";

/**
 * The REST surface. `mock-main.tsx` still primes the bootstrap cache so first
 * paint doesn't wait on a round trip, but from here on `/api/bootstrap` is a
 * real (mocked) response — which is also what keeps the app's reachability
 * probe green and stops it latching offline.
 */
export const handlers: RequestHandler[] = [...restHandlers];

export const worker = setupWorker(...handlers);
