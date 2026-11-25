/**
 * Minimal stand-in for the `cloudflare:workers` module.
 * @cloudflare/workers-oauth-provider only needs `WorkerEntrypoint` as a base class.
 */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}
export class DurableObject {}
export const env = {};
