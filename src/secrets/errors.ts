export type SecretsErrorCode =
  | "kek_unavailable"
  | "dek_corrupt"
  | "secret_corrupt"
  | "store_error"
  | "index_missing";

export class SecretsError extends Error {
  constructor(
    public readonly code: SecretsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretsError";
  }
}
