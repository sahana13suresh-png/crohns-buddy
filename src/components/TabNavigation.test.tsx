import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import TabNavigation, { TABS, TabId } from './TabNavigation';

describe('TabNavigation', () => {
  const defaultProps = {
    activeTab: 'welcome' as TabId,
    onTabChange: vi.fn(),
  };

  it('renders all 5 tabs in correct order', () => {
    render(<TabNavigation {...defaultProps} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    expect(tabs[0]).toHaveTextContent('Welcome');
    expect(tabs[1]).toHaveTextContent("About Crohn's");
    expect(tabs[2]).toHaveTextContent('Symptom Tracker');
    expect(tabs[3]).toHaveTextContent('AI Meal Planner');
    expect(tabs[4]).toHaveTextContent('Resources');
  });

  it('marks the active tab with aria-selected=true', () => {
    render(<TabNavigation {...defaultProps} activeTab="tracker" />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[3]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[4]).toHaveAttribute('aria-selected', 'false');
  });

  it('sets Welcome as default active tab', () => {
    render(<TabNavigation {...defaultProps} />);

    const welcomeTab = screen.getByRole('tab', { name: 'Welcome' });
    expect(welcomeTab).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onTabChange when a tab is clicked', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<TabNavigation activeTab="welcome" onTabChange={onTabChange} />);

    await user.click(screen.getByRole('tab', { name: "About Crohn's" }));
    expect(onTabChange).toHaveBeenCalledWith('about');
  });

  it('activates tab on Enter key press', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<TabNavigation activeTab="welcome" onTabChange={onTabChange} />);

    const welcomeTab = screen.getByRole('tab', { name: 'Welcome' });
    welcomeTab.focus();
    await user.keyboard('{Enter}');
    expect(onTabChange).toHaveBeenCalledWith('welcome');
  });

  it('activates tab on Space key press', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<TabNavigation activeTab="welcome" onTabChange={onTabChange} />);

    const welcomeTab = screen.getByRole('tab', { name: 'Welcome' });
    welcomeTab.focus();
    await user.keyboard(' ');
    expect(onTabChange).toHaveBeenCalledWith('welcome');
  });

  it('moves focus to next tab on ArrowRight', async () => {
    const user = userEvent.setup();
    render(<TabNavigation {...defaultProps} />);

    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveFocus();
  });

  it('moves focus to previous tab on ArrowLeft', async () => {
    const user = userEvent.setup();
    render(<TabNavigation activeTab="about" onTabChange={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    tabs[1].focus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs[0]).toHaveFocus();
  });

  it('wraps focus from last tab to first on ArrowRight', async () => {
    const user = userEvent.setup();
    render(<TabNavigation activeTab="resources" onTabChange={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    tabs[4].focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[0]).toHaveFocus();
  });

  it('wraps focus from first tab to last on ArrowLeft', async () => {
    const user = userEvent.setup();
    render(<TabNavigation {...defaultProps} />);

    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs[4]).toHaveFocus();
  });

  it('sets tabIndex=0 on active tab and tabIndex=-1 on inactive tabs', () => {
    render(<TabNavigation activeTab="planner" onTabChange={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[3]).toHaveAttribute('tabindex', '0'); // planner is active
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[2]).toHaveAttribute('tabindex', '-1');
    expect(tabs[4]).toHaveAttribute('tabindex', '-1');
  });

  it('has proper ARIA attributes on the tablist', () => {
    render(<TabNavigation {...defaultProps} />);

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label', 'Site sections');
  });

  it('each tab has aria-controls pointing to its panel', () => {
    render(<TabNavigation {...defaultProps} />);

    TABS.forEach((tab) => {
      const tabElement = screen.getByRole('tab', { name: tab.label });
      expect(tabElement).toHaveAttribute('aria-controls', `tabpanel-${tab.id}`);
    });
  });

  it('applies distinct visual classes to active vs inactive tabs', () => {
    render(<TabNavigation activeTab="welcome" onTabChange={vi.fn()} />);

    const activeTab = screen.getByRole('tab', { name: 'Welcome' });
    const inactiveTab = screen.getByRole('tab', { name: "About Crohn's" });

    expect(activeTab.className).toContain('bg-brand-600');
    expect(activeTab.className).toContain('text-white');
    expect(inactiveTab.className).toContain('text-brand-200');
    expect(inactiveTab.className).not.toContain('bg-brand-600');
  });
});
