import { describe, it, expect } from 'vitest';
import { compilePrompt, findMissingAnswers, QuizAnswers } from './compilePrompt';
import { quizSections } from './quizConfig';

describe('compilePrompt', () => {
  const completeAnswers: QuizAnswers = {
    section1_crohnsStatus: {
      flareStatus: 'active-flare',
      currentSymptoms: 'mild cramping after meals',
      symptomChecklist: ['Abdominal pain', 'Fatigue', 'Bloating'],
      doctorDietInstructions: 'Low-residue diet during flare',
    },
    section2_medicalSafety: {
      surgeryOrObstruction: 'no',
      recentWeightLoss: 'yes',
      foodAllergies: ['peanuts', 'shellfish'],
      foodsToAvoid: ['raw vegetables', 'high-fiber foods'],
    },
    section3_foodTolerance: {
      safeFoods: ['white rice', 'bananas', 'chicken breast'],
      triggerFoods: ['spicy foods', 'dairy'],
      reintroduceFoods: ['eggs'],
      fiberTolerance: 'low',
    },
    section4_foodPreferences: {
      preferredMealTypes: ['Soup', 'Smoothie'],
      refusedFoods: ['mushrooms', 'liver'],
      proteinPreferences: ['Chicken', 'Fish'],
      carbPreferences: ['White rice', 'Pasta'],
    },
    section5_lifestyle: {
      mealPlanDuration: '3-day',
      cookingTime: 'minimal',
      applianceAccess: ['Microwave', 'Blender'],
      mealsPerDay: 4,
    },
    section6_output: {
      dietaryGoals: ['Weight gain', 'Reduce inflammation'],
      outputFormat: 'simple-list',
      adventurousness: 'conservative',
      extraNotes: 'College student with limited budget',
    },
  };

  it('should produce a prompt starting with the intro line', () => {
    const prompt = compilePrompt(completeAnswers);
    expect(prompt).toContain("Create a personalized meal plan for someone with Crohn's disease.");
  });

  it('should include every answer from all sections', () => {
    const prompt = compilePrompt(completeAnswers);

    // Section 1
    expect(prompt).toContain('active-flare');
    expect(prompt).toContain('mild cramping after meals');
    expect(prompt).toContain('Abdominal pain, Fatigue, Bloating');
    expect(prompt).toContain('Low-residue diet during flare');

    // Section 2
    expect(prompt).toContain('peanuts, shellfish');
    expect(prompt).toContain('raw vegetables, high-fiber foods');

    // Section 3
    expect(prompt).toContain('white rice, bananas, chicken breast');
    expect(prompt).toContain('spicy foods, dairy');
    expect(prompt).toContain('low');

    // Section 4
    expect(prompt).toContain('Soup, Smoothie');
    expect(prompt).toContain('mushrooms, liver');
    expect(prompt).toContain('Chicken, Fish');

    // Section 5
    expect(prompt).toContain('Plan duration: 3-day');
    expect(prompt).toContain('minimal');
    expect(prompt).toContain('Microwave, Blender');
    expect(prompt).toContain('4');

    // Section 6
    expect(prompt).toContain('Weight gain, Reduce inflammation');
    expect(prompt).toContain('simple-list');
    expect(prompt).toContain('conservative');
    expect(prompt).toContain('College student with limited budget');
  });

  it('should include the closing instructions', () => {
    const prompt = compilePrompt(completeAnswers);
    expect(prompt).toContain('Use only foods they tolerate or are comfortable trying.');
    expect(prompt).toContain('not medical advice');
  });

  it('should handle empty arrays gracefully', () => {
    const answers: QuizAnswers = {
      ...completeAnswers,
      section2_medicalSafety: {
        ...completeAnswers.section2_medicalSafety,
        foodAllergies: [],
      },
    };
    const prompt = compilePrompt(answers);
    expect(prompt).toContain('Food allergies: None');
  });

  it('should handle undefined values gracefully', () => {
    const answers: QuizAnswers = {
      ...completeAnswers,
      section1_crohnsStatus: {
        ...completeAnswers.section1_crohnsStatus,
        currentSymptoms: undefined,
      },
    };
    const prompt = compilePrompt(answers);
    expect(prompt).toContain('Symptoms description: Not specified');
  });

  it('should handle missing section gracefully', () => {
    const answers: QuizAnswers = { ...completeAnswers };
    delete answers.section3_foodTolerance;
    const prompt = compilePrompt(answers);
    expect(prompt).toContain('Safe foods: Not specified');
    expect(prompt).toContain('Trigger foods: Not specified');
  });

  it('should not duplicate any answers', () => {
    const prompt = compilePrompt(completeAnswers);
    // Count occurrences of a specific unique answer
    const matches = prompt.match(/mild cramping after meals/g);
    expect(matches).toHaveLength(1);
  });

  it('should include labels for all 24 questions', () => {
    const prompt = compilePrompt(completeAnswers);
    // Each section has 4 questions = 24 lines with ":" separator for answers
    // Only the answer lines carry a ":" — the opening line and the closing
    // instructions have none — so the colon alone identifies them. Excluding
    // lines by prefix would also drop the "Additional notes" answer.
    const answerLines = prompt.split('\n').filter((line) => line.includes(':'));
    expect(answerLines.length).toBe(24);
  });
});

describe('findMissingAnswers', () => {
  it('should return empty array when all answers are present', () => {
    const answers: QuizAnswers = {};
    for (const section of quizSections) {
      answers[section.id] = {};
      for (const q of section.questions) {
        if (q.type === 'checkbox' || q.type === 'tag-input') {
          answers[section.id][q.id] = ['some value'];
        } else if (q.type === 'number') {
          answers[section.id][q.id] = 3;
        } else {
          answers[section.id][q.id] = 'some value';
        }
      }
    }
    const missing = findMissingAnswers(answers);
    expect(missing).toHaveLength(0);
  });

  it('should detect missing answers', () => {
    const answers: QuizAnswers = {
      section1_crohnsStatus: {
        flareStatus: 'active-flare',
        // currentSymptoms missing
        symptomChecklist: ['pain'],
        doctorDietInstructions: 'none',
      },
    };
    const missing = findMissingAnswers(answers);
    expect(missing).toContain('section1_crohnsStatus.currentSymptoms');
  });

  it('should detect empty arrays as missing', () => {
    const answers: QuizAnswers = {
      section3_foodTolerance: {
        safeFoods: [],
        triggerFoods: ['dairy'],
        reintroduceFoods: ['eggs'],
        fiberTolerance: 'low',
      },
    };
    const missing = findMissingAnswers(answers);
    expect(missing).toContain('section3_foodTolerance.safeFoods');
  });
});
