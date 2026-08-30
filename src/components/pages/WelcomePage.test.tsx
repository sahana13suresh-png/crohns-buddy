import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import WelcomePage from './WelcomePage';

describe('WelcomePage', () => {
  const onNavigate = vi.fn();

  const teamMembers = [
    { name: 'Sahana Suresh', role: "Founder & Crohn's Patient" },
    { name: 'Annabelle Koo', role: 'Marketing & Outreach' },
  ];

  const getTeamSection = () => {
    const section = screen.getByText('Meet the team').closest('section');
    expect(section).not.toBeNull();
    return section as HTMLElement;
  };

  it('renders the hero with the mission explanation', () => {
    render(<WelcomePage onNavigate={onNavigate} />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /your companion for\s*living with crohn's\./i,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/built by patients, for patients/i)).toBeInTheDocument();
    expect(
      screen.getByText(/track symptoms, discover meals that work for your body/i)
    ).toBeInTheDocument();
    expect(
      screen.getByAltText('Illustrated colon with scalloped edges')
    ).toBeInTheDocument();
  });

  it('renders a link-out for each of the four things the site offers', () => {
    render(<WelcomePage onNavigate={onNavigate} />);

    expect(screen.getByText(/what you'll find here/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /learn about crohn's/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^track symptoms$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /ai meal planner/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /resources & support/i })).toBeInTheDocument();
  });

  it('renders the Meet the team section with its shared message', () => {
    render(<WelcomePage onNavigate={onNavigate} />);

    expect(screen.getByText('Meet the team')).toBeInTheDocument();
    expect(screen.getByText(/— Sahana & Annabelle/)).toBeInTheDocument();

    const quote = getTeamSection().querySelector('blockquote');
    expect(quote).toHaveTextContent(/we're glad you're here\./i);
  });

  it("displays Sahana Suresh with her Founder and Crohn's Patient role", () => {
    render(<WelcomePage onNavigate={onNavigate} />);

    const team = within(getTeamSection());
    expect(team.getByRole('heading', { name: 'Sahana Suresh' })).toBeInTheDocument();
    expect(team.getByText("Founder & Crohn's Patient")).toBeInTheDocument();
  });

  it('displays Annabelle Koo with her Marketing and Outreach role', () => {
    render(<WelcomePage onNavigate={onNavigate} />);

    const team = within(getTeamSection());
    expect(team.getByRole('heading', { name: 'Annabelle Koo' })).toBeInTheDocument();
    expect(team.getByText('Marketing & Outreach')).toBeInTheDocument();
  });

  it('renders one block per team member, each with a name and a role', () => {
    render(<WelcomePage onNavigate={onNavigate} />);

    const team = within(getTeamSection());
    const names = team.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(teamMembers.map((m) => m.name));

    teamMembers.forEach(({ role }) => {
      expect(team.getByText(role)).toBeInTheDocument();
    });
  });

  it('organises the page into sections under a single top-level heading', () => {
    const { container } = render(<WelcomePage onNavigate={onNavigate} />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: /built with care,\s*for people like us\./i,
      })
    ).toBeInTheDocument();
    expect(container.querySelectorAll('section').length).toBeGreaterThanOrEqual(4);
  });
});
