import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import TabNavigation, { TABS, TabId } from './TabNavigation';

describe('TabNavigation', () => {
  const defaultProps = {
    activeTab: 'welcome' as TabId,
    onTabChange: vi.fn(),
  };

  it('renders every tab from TABS in order', () => {
    render(<TabNavigation {...defaultProps} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(TABS.length);
    TABS.forEach((tab, index) => {
      expect(tabs[index]).toHaveTextContent(tab.label);
    });
  });

  it('marks the active tab with aria-selected=true', () => {
    const activeIndex = TABS.findIndex((tab) => tab.id === 'tracker');
    render(<TabNavigation {...defaultProps} activeTab="tracker" />);

    const tabs = screen.getAllByRole('tab');
    TABS.forEach((_, index) => {
      expect(tabs[index]).toHaveAttribute(
        'aria-selected',
        index === activeIndex ? 'true' : 'false'
      );
    });
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
    const lastIndex = TABS.length - 1;
    render(<TabNavigation activeTab={TABS[lastIndex].id} onTabChange={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    tabs[lastIndex].focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[0]).toHaveFocus();
  });

  it('wraps focus from first tab to last on ArrowLeft', async () => {
    const user = userEvent.setup();
    render(<TabNavigation {...defaultProps} />);

    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs[TABS.length - 1]).toHaveFocus();
  });

  it('sets tabIndex=0 on active tab and tabIndex=-1 on inactive tabs', () => {
    const activeIndex = TABS.findIndex((tab) => tab.id === 'planner');
    render(<TabNavigation activeTab="planner" onTabChange={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    TABS.forEach((_, index) => {
      expect(tabs[index]).toHaveAttribute(
        'tabindex',
        index === activeIndex ? '0' : '-1'
      );
    });
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

    // The active tab is marked with an underline pseudo-element and
    // full-strength text colour.
    expect(activeTab.className).toContain('after:h-[2px]');
    expect(activeTab.className).toContain('after:bg-brand-400');
    expect(activeTab.className).toContain('text-brand-800');
    expect(activeTab.className).not.toContain('text-brand-800/40');

    // Inactive tabs get no underline and a muted text colour.
    expect(inactiveTab.className).not.toContain('after:bg-brand-400');
    expect(inactiveTab.className).toContain('text-brand-800/40');
  });
});
