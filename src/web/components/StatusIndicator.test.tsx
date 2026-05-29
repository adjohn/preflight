import { render, screen } from '@testing-library/react';
import { StatusIndicator } from './StatusIndicator';

describe('StatusIndicator', () => {
  it('renders the label as the only spoken text', () => {
    const { container } = render(<StatusIndicator tone="good" label="connected" />);
    // The bullet must be aria-hidden so screen readers announce
    // only the label, not "bullet connected".
    const bullet = container.querySelector('span[aria-hidden="true"]');
    expect(bullet).toBeTruthy();
    expect(screen.getByText(/connected/)).toBeInTheDocument();
  });

  it('uses the matching tone class for each status', () => {
    const { container, rerender } = render(
      <StatusIndicator tone="good" label="ok" />,
    );
    expect(container.firstElementChild!.className).toContain('text-accent-green');

    rerender(<StatusIndicator tone="warn" label="warn" />);
    expect(container.firstElementChild!.className).toContain('text-accent-amber');

    rerender(<StatusIndicator tone="bad" label="down" />);
    expect(container.firstElementChild!.className).toContain('text-accent-red');

    rerender(<StatusIndicator tone="neutral" label="idle" />);
    expect(container.firstElementChild!.className).toContain('text-ink-muted');
  });

  it('appends caller-supplied className', () => {
    const { container } = render(
      <StatusIndicator tone="good" label="ok" className="mt-2" />,
    );
    expect(container.firstElementChild!.className).toContain('mt-2');
  });
});
