export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
export class LiveClock implements Clock {
  now(): Date {
    return new Date();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
export class MockClock implements Clock {
  constructor(private time: Date) {}
  now(): Date {
    return new Date(this.time);
  }
  set(at: string): void {
    this.time = new Date(at);
  }
  async sleep(ms: number): Promise<void> {
    this.time = new Date(this.time.getTime() + ms);
  }
}
