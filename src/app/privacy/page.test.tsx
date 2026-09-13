import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PrivacyNotice, { metadata } from './page';

const INFRASTRUCTURE_TERMS =
  /Amazon|AWS|DynamoDB|us-east-1|Northern Virginia|cloud storage|API request|HTTPS|JSON file/i;

describe('PrivacyNotice', () => {
  it('explains collection, protection, retention, and removal without infrastructure details', () => {
    render(<PrivacyNotice />);

    expect(screen.getByRole('heading', { name: 'What we store' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How we protect it' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How long we keep it' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'How to remove it, and how to get a copy' })
    ).toBeInTheDocument();
    expect(document.body).toHaveTextContent(/encrypted while stored and while being sent/i);
    expect(document.body).not.toHaveTextContent(INFRASTRUCTURE_TERMS);
  });

  it('keeps infrastructure details out of search and sharing metadata', () => {
    expect(metadata.description).not.toMatch(INFRASTRUCTURE_TERMS);
  });
});
