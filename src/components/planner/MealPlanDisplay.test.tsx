import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import MealPlanDisplay from './MealPlanDisplay';
import { MealPlanResponse } from '@/lib/types';

const mockMealPlan: MealPlanResponse['mealPlan'] = {
  meals: [
    {
      mealName: 'Breakfast',
      items: [
        { name: 'Oatmeal', portion: '1 cup', notes: 'Cooked with water for easy digestion' },
        { name: 'Banana', portion: '1 medium' },
      ],
    },
    {
      mealName: 'Lunch',
      items: [
        { name: 'Grilled Chicken', portion: '4 oz' },
        { name: 'White Rice', portion: '1/2 cup' },
      ],
    },
    {
      mealName: 'Dinner',
      items: [
        { name: 'Salmon', portion: '5 oz', notes: 'Baked, skin removed' },
        { name: 'Mashed Potatoes', portion: '3/4 cup' },
      ],
    },
  ],
  summary: 'A gentle, easy-to-digest meal plan focused on low-fiber foods.',
  warnings: ['Consult your doctor before making dietary changes.', 'Avoid raw vegetables during flare.'],
};

describe('MealPlanDisplay', () => {
  const defaultProps = {
    mealPlan: null as MealPlanResponse['mealPlan'] | null,
    isLoading: false,
    error: null as string | null,
    onRetry: vi.fn(),
  };

  it('renders nothing when no meal plan, not loading, and no error', () => {
    const { container } = render(<MealPlanDisplay {...defaultProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('loading state', () => {
    it('displays loading spinner and message', () => {
      render(<MealPlanDisplay {...defaultProps} isLoading={true} />);
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByText('Generating your personalized meal plan...')).toBeInTheDocument();
    });

    it('does not render meal plan during loading even if data is provided', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} isLoading={true} />);
      expect(screen.queryByText('Plan Summary')).not.toBeInTheDocument();
      expect(screen.getByText('Generating your personalized meal plan...')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('displays error message', () => {
      render(
        <MealPlanDisplay {...defaultProps} error="The AI service is temporarily unavailable." />
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('The AI service is temporarily unavailable.')).toBeInTheDocument();
    });

    it('displays retry button that calls onRetry', async () => {
      const onRetry = vi.fn();
      render(
        <MealPlanDisplay
          {...defaultProps}
          error="Something went wrong"
          onRetry={onRetry}
        />
      );
      const retryBtn = screen.getByRole('button', { name: /try again/i });
      expect(retryBtn).toBeInTheDocument();
      await userEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('meal plan display', () => {
    it('renders the plan summary', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} />);
      expect(screen.getByText('Plan Summary')).toBeInTheDocument();
      expect(
        screen.getByText('A gentle, easy-to-digest meal plan focused on low-fiber foods.')
      ).toBeInTheDocument();
    });

    it('renders warnings in a caution box', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} />);
      expect(screen.getByText('Important Notes')).toBeInTheDocument();
      expect(
        screen.getByText(/Consult your doctor before making dietary changes/)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Avoid raw vegetables during flare/)
      ).toBeInTheDocument();
    });

    it('does not render warnings section when no warnings', () => {
      const planNoWarnings = { ...mockMealPlan, warnings: undefined };
      render(<MealPlanDisplay {...defaultProps} mealPlan={planNoWarnings} />);
      expect(screen.queryByText('Important Notes')).not.toBeInTheDocument();
    });

    it('renders all meal sections with labels', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} />);
      expect(screen.getByText('Breakfast')).toBeInTheDocument();
      expect(screen.getByText('Lunch')).toBeInTheDocument();
      expect(screen.getByText('Dinner')).toBeInTheDocument();
    });

    it('renders food items with names and portions', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} />);
      expect(screen.getByText('Oatmeal')).toBeInTheDocument();
      expect(screen.getByText('1 cup')).toBeInTheDocument();
      expect(screen.getByText('Grilled Chicken')).toBeInTheDocument();
      expect(screen.getByText('4 oz')).toBeInTheDocument();
    });

    it('renders optional notes for food items', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} />);
      expect(
        screen.getByText('Cooked with water for easy digestion')
      ).toBeInTheDocument();
      expect(screen.getByText('Baked, skin removed')).toBeInTheDocument();
    });

    it('renders the correct number of meals', () => {
      render(<MealPlanDisplay {...defaultProps} mealPlan={mockMealPlan} />);
      const mealHeaders = ['Breakfast', 'Lunch', 'Dinner'];
      mealHeaders.forEach((name) => {
        expect(screen.getByText(name)).toBeInTheDocument();
      });
    });
  });
});
