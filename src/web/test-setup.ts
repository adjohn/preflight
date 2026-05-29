import '@testing-library/jest-dom/vitest';

type ResizeCallback = (entries: Array<{ contentRect: DOMRect; target: Element }>) => void;

class ResizeObserverStub {
  private readonly cb: ResizeCallback;
  constructor(cb: ResizeCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    queueMicrotask(() =>
      this.cb([{ contentRect: { width: 500, height: 200 } as DOMRect, target }]),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}

Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  value: 500,
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  value: 200,
});
