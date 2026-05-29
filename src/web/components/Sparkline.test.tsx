import { render } from '@testing-library/react';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('renders an svg', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4]} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders no svg when fewer than 2 values', () => {
    const { container } = render(<Sparkline values={[5]} />);
    expect(container.querySelector('svg')).toBeFalsy();
  });

  it('emits a polyline with one point per value', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4]} />);
    const poly = container.querySelector('polyline');
    expect(poly).toBeTruthy();
    const pts = poly!.getAttribute('points')!.trim().split(/\s+/);
    expect(pts).toHaveLength(4);
  });

  it('marks the svg as decorative (aria-hidden) when no label is provided', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4]} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBeNull();
  });

  it('exposes role=img and a descriptive aria-label when a label is provided', () => {
    const { container } = render(
      <Sparkline values={[10, 20, 30, 40]} ariaLabel="Latency ms" />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    const label = svg.getAttribute('aria-label')!;
    expect(label).toContain('Latency ms');
    expect(label).toContain('4 points');
    expect(label).toContain('start 10');
    expect(label).toContain('end 40');
    expect(label).toContain('min 10');
    expect(label).toContain('max 40');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });
});
