export class CapacityExceededError extends Error {
  readonly limit: number;
  readonly current: number;

  constructor(limit: number, current: number) {
    super(`Server at capacity (${current}/${limit} containers running).`);
    this.name = "CapacityExceededError";
    this.limit = limit;
    this.current = current;
  }
}
