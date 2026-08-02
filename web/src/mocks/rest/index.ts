/**
 * The full REST surface of the mocked app.
 *
 * MSW matches in registration order, so bootstrap goes first: it is both the
 * startup payload and the app's reachability probe, and losing it to a broader
 * pattern is what makes the shell flip to the sign-in gate.
 */

import type { RequestHandler } from "msw";
import { automataHandlers } from "./automata";
import { bootstrapHandlers } from "./bootstrap";
import { feedbackHandlers } from "./feedback";
import { miscHandlers } from "./misc";
import { projectHandlers } from "./projects";
import { settingsHandlers } from "./settings";
import { threadHandlers } from "./threads";
import { workbenchHandlers } from "./workbenches";

export const restHandlers: RequestHandler[] = [
  ...bootstrapHandlers,
  ...feedbackHandlers,
  ...settingsHandlers,
  ...projectHandlers,
  ...workbenchHandlers,
  ...automataHandlers,
  ...miscHandlers,
  // Last: `/api/threads/:threadId/*` is the broadest family here, and the
  // attachment handler in `misc` shares its prefix.
  ...threadHandlers,
];
