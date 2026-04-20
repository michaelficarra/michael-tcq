import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionStatus } from './ConnectionStatus.js';

describe('ConnectionStatus', () => {
  it('shows green dot when connected', () => {
    render(<ConnectionStatus connected={true} activeConnections={1} />);
    const dot = screen.getByLabelText(/^Connected —/);
    expect(dot.className).toContain('bg-green-500');
  });

  it('shows red dot when disconnected', () => {
    render(<ConnectionStatus connected={false} activeConnections={0} />);
    const dot = screen.getByLabelText('Disconnected from server');
    expect(dot.className).toContain('bg-red-500');
  });

  it('shows tooltip when transitioning from connected to disconnected', () => {
    const { rerender } = render(<ConnectionStatus connected={true} activeConnections={1} />);
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();

    rerender(<ConnectionStatus connected={false} activeConnections={0} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
  });

  it('does not show tooltip on initial render when disconnected', () => {
    render(<ConnectionStatus connected={false} activeConnections={0} />);
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });

  it('keeps tooltip visible until dismissed or reconnected', () => {
    const { rerender } = render(<ConnectionStatus connected={true} activeConnections={1} />);
    rerender(<ConnectionStatus connected={false} activeConnections={0} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();

    // Still visible after a long time
    rerender(<ConnectionStatus connected={false} activeConnections={0} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
  });

  it('dismisses tooltip on click', () => {
    const { rerender } = render(<ConnectionStatus connected={true} activeConnections={1} />);
    rerender(<ConnectionStatus connected={false} activeConnections={0} />);

    fireEvent.click(screen.getByText('Connection lost'));
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });

  it('hides tooltip when reconnected', () => {
    const { rerender } = render(<ConnectionStatus connected={true} activeConnections={1} />);
    rerender(<ConnectionStatus connected={false} activeConnections={0} />);
    expect(screen.getByText('Connection lost')).toBeInTheDocument();

    rerender(<ConnectionStatus connected={true} activeConnections={1} />);
    expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
  });

  describe('active-connections hover pill', () => {
    it('is hidden by default when connected (no hover)', () => {
      render(<ConnectionStatus connected={true} activeConnections={3} />);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('appears on hover and shows the count (plural)', () => {
      render(<ConnectionStatus connected={true} activeConnections={3} />);
      const dot = screen.getByLabelText(/^Connected —/);
      fireEvent.mouseEnter(dot);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Connected — 3 active connections');
    });

    it('uses singular form when there is one connection', () => {
      render(<ConnectionStatus connected={true} activeConnections={1} />);
      const dot = screen.getByLabelText(/^Connected —/);
      fireEvent.mouseEnter(dot);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Connected — 1 active connection');
    });

    it('disappears on mouse leave', () => {
      render(<ConnectionStatus connected={true} activeConnections={2} />);
      const dot = screen.getByLabelText(/^Connected —/);
      fireEvent.mouseEnter(dot);
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
      fireEvent.mouseLeave(dot);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('does not appear on hover when disconnected', () => {
      render(<ConnectionStatus connected={false} activeConnections={0} />);
      const dot = screen.getByLabelText('Disconnected from server');
      fireEvent.mouseEnter(dot);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('uses the help cursor on the container when connected', () => {
      // The cursor lives on the outer container so it applies across the
      // whole active hit area (dot, gap, and pill) while hovering.
      render(<ConnectionStatus connected={true} activeConnections={1} />);
      const dot = screen.getByLabelText(/^Connected —/);
      const container = dot.parentElement!;
      expect(container.className).toContain('cursor-help');
    });

    it('does not use the help cursor when disconnected', () => {
      render(<ConnectionStatus connected={false} activeConnections={0} />);
      const dot = screen.getByLabelText('Disconnected from server');
      const container = dot.parentElement!;
      expect(container.className).not.toContain('cursor-help');
    });
  });
});
