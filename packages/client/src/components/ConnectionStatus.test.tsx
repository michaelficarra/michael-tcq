import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionStatus } from './ConnectionStatus.js';

describe('ConnectionStatus', () => {
  it('shows green dot when connected', () => {
    render(<ConnectionStatus connected={true} />);
    const dot = screen.getByLabelText('Connected to server');
    expect(dot.className).toContain('bg-green-500');
  });

  it('shows red dot when disconnected', () => {
    render(<ConnectionStatus connected={false} />);
    const dot = screen.getByLabelText('Disconnected from server');
    expect(dot.className).toContain('bg-red-500');
  });

  it('shows tooltip when transitioning from connected to disconnected', () => {
    const { rerender } = render(<ConnectionStatus connected={true} />);
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();

    rerender(<ConnectionStatus connected={false} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
  });

  it('does not show tooltip on initial render when disconnected', () => {
    render(<ConnectionStatus connected={false} />);
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });

  it('keeps tooltip visible until dismissed or reconnected', () => {
    const { rerender } = render(<ConnectionStatus connected={true} />);
    rerender(<ConnectionStatus connected={false} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();

    // Still visible after a long time
    rerender(<ConnectionStatus connected={false} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
  });

  it('dismisses tooltip on click', () => {
    const { rerender } = render(<ConnectionStatus connected={true} />);
    rerender(<ConnectionStatus connected={false} />);

    fireEvent.click(screen.getByText('Connection lost'));
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });

  it('hides tooltip when reconnected', () => {
    const { rerender } = render(<ConnectionStatus connected={true} />);
    rerender(<ConnectionStatus connected={false} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();

    rerender(<ConnectionStatus connected={true} />);
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });
});
