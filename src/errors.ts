export class FiggyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FiggyError";
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
