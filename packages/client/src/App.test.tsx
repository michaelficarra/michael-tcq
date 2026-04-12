import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './pages/HomePage.js';

describe('HomePage', () => {
  it('renders the welcome message', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Welcome to TCQ')).toBeInTheDocument();
  });

  it('displays the TCQ branding', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('TCQ')).toBeInTheDocument();
  });
});
