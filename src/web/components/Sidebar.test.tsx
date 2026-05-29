import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('renders all four nav items', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Audit')).toBeInTheDocument();
  });

  it('highlights the active item', () => {
    render(<Sidebar currentPath="/audit" onNavigate={() => {}} connected={true} />);
    const audit = screen.getByText('Audit').closest('button');
    expect(audit).toHaveAttribute('aria-current', 'page');
  });

  it('shows ● connected when connected=true', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('shows ● reconnecting when connected=false', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('does not set aria-current on inactive items', () => {
    render(<Sidebar currentPath="/audit" onNavigate={() => {}} connected={true} />);
    for (const label of ['Today', 'Sessions', 'History']) {
      const btn = screen.getByText(label).closest('button')!;
      expect(btn.hasAttribute('aria-current')).toBe(false);
    }
  });

  it('marks decorative icons aria-hidden inside nav buttons', () => {
    const { container } = render(
      <Sidebar currentPath="/" onNavigate={() => {}} connected={true} />,
    );
    const icons = container.querySelectorAll('nav button svg');
    expect(icons.length).toBe(4);
    for (const svg of Array.from(icons)) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('labels the nav landmark as "Primary"', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeInTheDocument();
  });
});
