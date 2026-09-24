export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function fail(statusCode: number, code: string, message: string): never {
  throw new AppError(statusCode, code, message);
}
