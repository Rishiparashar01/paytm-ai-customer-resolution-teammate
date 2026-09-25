/**
 * Application error with an HTTP status code.
 * The error handler renders AppError as `{ error: message }` with `status`.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export default AppError;
