import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import WelcomePage from './WelcomePage';

describe('WelcomePage', () => {
  it('renders the introductory section with mission explanation', () => {
    render(<WelcomePage />);
    
    expect(screen.getByRole('heading', { name: /welcome to crohn's buddy/i })).toBeInTheDocument();
    expect(screen.getByText(/supportive platform built for teens and young adults/i)).toBeInTheDocument();
    expect(screen.getByText(/educational resources/i)).toBeInTheDocument();
    expect(screen.getByText(/symptom tracking/i)).toBeInTheDocument();
    expect(screen.getByText(/ai-powered meal planning/i)).toBeInTheDocument();
    expect(screen.getByText(/community/i)).toBeInTheDocument();
  });

  it('renders the Meet the Team section heading', () => {
    render(<WelcomePage />);
    
    expect(screen.getByRole('heading', { name: /meet the team/i })).toBeInTheDocument();
  });

  it('displays Sahana Suresh with Founder and Crohn\'s Patient role', () => {
    render(<WelcomePage />);
    
    expect(screen.getByText('Sahana Suresh')).toBeInTheDocument();
    expect(screen.getByText("Founder and Crohn's Patient")).toBeInTheDocument();
  });

  it('displays Annabelle Koo with Marketing and Outreach role', () => {
    render(<WelcomePage />);
    
    expect(screen.getByText('Annabelle Koo')).toBeInTheDocument();
    expect(screen.getByText('Marketing and Outreach')).toBeInTheDocument();
  });

  it('renders team member cards with the card class', () => {
    const { container } = render(<WelcomePage />);
    
    const cards = container.querySelectorAll('.card');
    expect(cards).toHaveLength(2);
  });

  it('has accessible section landmarks', () => {
    render(<WelcomePage />);
    
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });
});
