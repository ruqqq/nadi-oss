/**
 * Durable Object classes bound to the Cloudflare Sandbox container instance
 * types configured in wrangler.jsonc. Kept as thin subclasses (rather than
 * exporting `Sandbox` twice under different bindings) because wrangler's
 * container config keys a Durable Object binding to a distinct class name
 * per instance type.
 */
import { Sandbox } from "@cloudflare/sandbox";

export { ContainerProxy } from "@cloudflare/sandbox";

export class NadiSandboxSmall extends Sandbox {}
export class NadiSandboxMedium extends Sandbox {}
