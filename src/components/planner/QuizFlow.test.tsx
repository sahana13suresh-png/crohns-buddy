import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import QuizFlow from './QuizFlow';
import { quizSections } from '@/lib/quizConfig';

describe('QuizFlow', () => {
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    mockOnComplete.mockClear();
  });

  it('renders the first section by default', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    expect(screen.getByText('Section 1 of 6')).toBeInTheDocument();
    expect(screen.getByText(quizSections[0].title)).toBeInTheDocument();
  });

  it('shows progress indicator with correct remaining count', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    expect(screen.getByText('5 remaining')).toBeInTheDocument();
  });

  it('renders a progress bar with proper aria attributes', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '1');
    expect(progressBar).toHaveAttribute('aria-valuemax', '6');
  });

  it('disables Previous button on first section', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    const prevButton = screen.getByText('← Previous');
    expect(prevButton).toBeDisabled();
  });

  it('shows Next button on non-last sections', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    expect(screen.getByText('Next →')).toBeInTheDocument();
    expect(screen.queryByText('Generate Meal Plan')).not.toBeInTheDocument();
  });

  it('prevents advancement when required questions are unanswered', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    fireEvent.click(screen.getByText('Next →'));
    // Should still be on section 1
    expect(screen.getByText('Section 1 of 6')).toBeInTheDocument();
  });

  it('shows error messages when trying to advance without answering', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    fireEvent.click(screen.getByText('Next →'));
    // Error messages should appear for unanswered required questions
    expect(screen.getAllByText(/please/i).length).toBeGreaterThan(0);
  });

  it('allows navigation back to previous sections', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);

    // Fill out section 1 to advance - click radio options
    // Q1: "Are you currently in a flare?" - select "Yes"
    fireEvent.click(screen.getByLabelText('Yes'));
    // Q2: "How would you describe your symptoms today?" - select "Mild"
    fireEvent.click(screen.getByLabelText('Mild'));
    // Q3: Symptom checklist - select at least one
    fireEvent.click(screen.getByLabelText('Abdominal pain'));
    // Q4: Doctor diet instructions - select one
    fireEvent.click(screen.getByLabelText('No specific instructions'));

    fireEvent.click(screen.getByText('Next →'));
    expect(screen.getByText('Section 2 of 6')).toBeInTheDocument();

    // Now go back
    fireEvent.click(screen.getByText('← Previous'));
    expect(screen.getByText('Section 1 of 6')).toBeInTheDocument();
  });

  it('renders section navigation dots for all 6 sections', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    const dots = quizSections.map((s) =>
      screen.getByLabelText(new RegExp(`Go to ${s.title}`))
    );
    expect(dots).toHaveLength(6);
  });

  it('allows clicking navigation dots to jump to sections', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    // Click on a later section dot
    const dot = screen.getByLabelText(new RegExp(`Go to ${quizSections[2].title}`));
    fireEvent.click(dot);
    expect(screen.getByText('Section 3 of 6')).toBeInTheDocument();
    expect(screen.getByText(quizSections[2].title)).toBeInTheDocument();
  });

  it('shows Generate Meal Plan button on the last section', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    // Navigate to last section via dot
    const lastDot = screen.getByLabelText(new RegExp(`Go to ${quizSections[5].title}`));
    fireEvent.click(lastDot);
    expect(screen.getByText('Generate Meal Plan')).toBeInTheDocument();
    expect(screen.queryByText('Next →')).not.toBeInTheDocument();
  });

  it('calls onComplete with all answers when Generate Meal Plan is clicked with valid answers', () => {
    render(<QuizFlow onComplete={mockOnComplete} />);
    // Navigate to last section
    const lastDot = screen.getByLabelText(new RegExp(`Go to ${quizSections[5].title}`));
    fireEvent.click(lastDot);

    // Fill last section - select dietary goals
    fireEvent.click(screen.getByLabelText('Weight gain'));
    // Select output format
    fireEvent.click(screen.getByLabelText('Simple list of meals'));
    // Select adventurousness
    fireEvent.click(screen.getByLabelText('Conservative - stick to what I know works'));
    // Fill extra notes
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Some notes' } });

    fireEvent.click(screen.getByText('Generate Meal Plan'));
    expect(mockOnComplete).toHaveBeenCalledTimes(1);
    expect(mockOnComplete).toHaveBeenCalledWith(expect.objectContaining({
      section6_output: expect.objectContaining({
        dietaryGoals: ['Weight gain'],
        outputFormat: 'Simple list of meals',
        adventurousness: 'Conservative - stick to what I know works',
        extraNotes: 'Some notes',
      }),
    }));
  });
});
