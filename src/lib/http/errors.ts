export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }

  /** Worth retrying on a later pass rather than failing the job outright. */
  get isTransient(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export class RateLimitError extends HttpError {
  constructor(
    method: string,
    path: string,
    body: string,
    /** Seconds, from the `Retry-After` header. */
    readonly retryAfterSeconds: number,
  ) {
    super(429, method, path, body);
    this.name = "RateLimitError";
  }
}

/**
 * Thrown when a source's circuit breaker is open. Jobs hitting this are
 * requeued without consuming a retry attempt — the upstream is sick, not the job.
 */
export class CircuitOpenError extends Error {
  constructor(
    readonly source: string,
    readonly openUntil: Date,
  ) {
    super(
      `Circuit for "${source}" is open until ${openUntil.toISOString()}; skipping request`,
    );
    this.name = "CircuitOpenError";
  }
}

/** A response that parsed as JSON but did not match its zod schema. */
export class ResponseShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string,
  ) {
    super(`Unexpected response shape from ${path}:\n${issues}`);
    this.name = "ResponseShapeError";
  }
}
