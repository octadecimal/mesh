import { render, screen } from '@testing-library/react';

import App from './app';

describe('App', () => {
  it('renders the minimal Mesh application shell', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Mesh' })).toBeDefined();
    expect(screen.getByText('Session platform')).toBeDefined();
  });
});
