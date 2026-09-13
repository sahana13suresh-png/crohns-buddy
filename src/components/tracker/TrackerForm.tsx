'use client';

import { useState, useEffect } from 'react';
import { TrackerEntry } from '@/lib/types';

interface TrackerFormProps {
  date: string;
  initialData?: TrackerEntry;
  onSubmit: (entry: TrackerEntry) => void;
  onCancel?: () => void;
}

interface FormErrors {
  foodConsumed?: string;
  painLevel?: string;
  bowelMovements?: string;
  stressLevel?: string;
  energyLevel?: string;
}

export default function TrackerForm({ date, initialData, onSubmit, onCancel }: TrackerFormProps) {
  const [foodConsumed, setFoodConsumed] = useState(initialData?.foodConsumed ?? '');
  const [painLevel, setPainLevel] = useState<number>(initialData?.painLevel ?? 5);
  const [bowelMovements, setBowelMovements] = useState<number>(initialData?.bowelMovements ?? 0);
  const [stressLevel, setStressLevel] = useState<number>(initialData?.stressLevel ?? 5);
  const [energyLevel, setEnergyLevel] = useState<number>(initialData?.energyLevel ?? 5);
  const [errors, setErrors] = useState<FormErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Reset form when initialData or date changes
  useEffect(() => {
    setFoodConsumed(initialData?.foodConsumed ?? '');
    setPainLevel(initialData?.painLevel ?? 5);
    setBowelMovements(initialData?.bowelMovements ?? 0);
    setStressLevel(initialData?.stressLevel ?? 5);
    setEnergyLevel(initialData?.energyLevel ?? 5);
    setErrors({});
    setTouched({});
  }, [initialData, date]);

  function validate(): FormErrors {
    const newErrors: FormErrors = {};

    if (foodConsumed.length > 500) {
      newErrors.foodConsumed = 'Food description must be 500 characters or fewer.';
    }

    if (!Number.isInteger(painLevel) || painLevel < 1 || painLevel > 10) {
      newErrors.painLevel = 'Pain level must be a whole number between 1 and 10.';
    }

    if (!Number.isInteger(bowelMovements) || bowelMovements < 0 || bowelMovements > 20) {
      newErrors.bowelMovements = 'Bowel movements must be a whole number between 0 and 20.';
    }

    if (!Number.isInteger(stressLevel) || stressLevel < 1 || stressLevel > 10) {
      newErrors.stressLevel = 'Stress level must be a whole number between 1 and 10.';
    }

    if (!Number.isInteger(energyLevel) || energyLevel < 1 || energyLevel > 10) {
      newErrors.energyLevel = 'Energy level must be a whole number between 1 and 10.';
    }

    return newErrors;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Mark all fields as touched on submit
    setTouched({
      foodConsumed: true,
      painLevel: true,
      bowelMovements: true,
      stressLevel: true,
      energyLevel: true,
    });

    const validationErrors = validate();
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    const entry: TrackerEntry = {
      date,
      foodConsumed,
      painLevel,
      bowelMovements,
      stressLevel,
      energyLevel,
      submittedAt: new Date().toISOString(),
    };

    onSubmit(entry);
  }

  function handleBlur(field: string) {
    setTouched((prev) => ({ ...prev, [field]: true }));
    setErrors(validate());
  }

  function formatDate(dateStr: string): string {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  return (
    <form onSubmit={handleSubmit} className="surface-card space-y-6">
      <h2 className="text-xl font-semibold text-brand-800">
        Daily Log — {formatDate(date)}
      </h2>

      {/* Food Consumed */}
      <div className="space-y-2">
        <label htmlFor="foodConsumed" className="block text-sm font-semibold text-brand-800/75">
          What did you eat today?
        </label>
        <textarea
          id="foodConsumed"
          value={foodConsumed}
          onChange={(e) => setFoodConsumed(e.target.value)}
          onBlur={() => handleBlur('foodConsumed')}
          maxLength={500}
          rows={4}
          className={`field-control min-h-28 resize-y ${
            touched.foodConsumed && errors.foodConsumed
              ? 'border-red-400 focus:border-red-400 focus:ring-red-100'
              : ''
          }`}
          placeholder="Describe what you ate today..."
          aria-describedby="foodConsumed-count foodConsumed-error"
        />
        <div className="flex justify-between items-center">
          <span
            id="foodConsumed-count"
            className={`text-xs ${foodConsumed.length > 500 ? 'text-red-600' : 'text-brand-800/45'}`}
          >
            {foodConsumed.length}/500 characters
          </span>
          {touched.foodConsumed && errors.foodConsumed && (
            <span id="foodConsumed-error" className="text-xs text-red-600" role="alert">
              {errors.foodConsumed}
            </span>
          )}
        </div>
      </div>

      {/* Pain Level */}
      <div className="space-y-2">
        <label htmlFor="painLevel" className="block text-sm font-semibold text-brand-800/75">
          Pain Level (1 = no pain, 10 = worst pain)
        </label>
        <div className="flex items-center gap-3">
          <input
            id="painLevel"
            type="number"
            min={1}
            max={10}
            step={1}
            value={painLevel}
            onChange={(e) => setPainLevel(Math.round(Number(e.target.value)))}
            onBlur={() => handleBlur('painLevel')}
            className={`field-control w-24 ${
              touched.painLevel && errors.painLevel
                ? 'border-red-400 focus:border-red-400 focus:ring-red-100'
                : ''
            }`}
            aria-describedby="painLevel-error"
          />
          <span className="text-sm text-brand-800/45">/10</span>
        </div>
        {touched.painLevel && errors.painLevel && (
          <span id="painLevel-error" className="text-xs text-red-600" role="alert">
            {errors.painLevel}
          </span>
        )}
      </div>

      {/* Bowel Movements */}
      <div className="space-y-2">
        <label htmlFor="bowelMovements" className="block text-sm font-semibold text-brand-800/75">
          Number of Bowel Movements
        </label>
        <div className="flex items-center gap-3">
          <input
            id="bowelMovements"
            type="number"
            min={0}
            max={20}
            step={1}
            value={bowelMovements}
            onChange={(e) => setBowelMovements(Math.round(Number(e.target.value)))}
            onBlur={() => handleBlur('bowelMovements')}
            className={`field-control w-24 ${
              touched.bowelMovements && errors.bowelMovements
                ? 'border-red-400 focus:border-red-400 focus:ring-red-100'
                : ''
            }`}
            aria-describedby="bowelMovements-error"
          />
          <span className="text-sm text-brand-800/45">(0–20)</span>
        </div>
        {touched.bowelMovements && errors.bowelMovements && (
          <span id="bowelMovements-error" className="text-xs text-red-600" role="alert">
            {errors.bowelMovements}
          </span>
        )}
      </div>

      {/* Stress Level */}
      <div className="space-y-2">
        <label htmlFor="stressLevel" className="block text-sm font-semibold text-brand-800/75">
          Stress Level (1 = very relaxed, 10 = extremely stressed)
        </label>
        <div className="flex items-center gap-3">
          <input
            id="stressLevel"
            type="number"
            min={1}
            max={10}
            step={1}
            value={stressLevel}
            onChange={(e) => setStressLevel(Math.round(Number(e.target.value)))}
            onBlur={() => handleBlur('stressLevel')}
            className={`field-control w-24 ${
              touched.stressLevel && errors.stressLevel
                ? 'border-red-400 focus:border-red-400 focus:ring-red-100'
                : ''
            }`}
            aria-describedby="stressLevel-error"
          />
          <span className="text-sm text-brand-800/45">/10</span>
        </div>
        {touched.stressLevel && errors.stressLevel && (
          <span id="stressLevel-error" className="text-xs text-red-600" role="alert">
            {errors.stressLevel}
          </span>
        )}
      </div>

      {/* Energy Level */}
      <div className="space-y-2">
        <label htmlFor="energyLevel" className="block text-sm font-semibold text-brand-800/75">
          Energy Level (1 = very low, 10 = very high)
        </label>
        <div className="flex items-center gap-3">
          <input
            id="energyLevel"
            type="number"
            min={1}
            max={10}
            step={1}
            value={energyLevel}
            onChange={(e) => setEnergyLevel(Math.round(Number(e.target.value)))}
            onBlur={() => handleBlur('energyLevel')}
            className={`field-control w-24 ${
              touched.energyLevel && errors.energyLevel
                ? 'border-red-400 focus:border-red-400 focus:ring-red-100'
                : ''
            }`}
            aria-describedby="energyLevel-error"
          />
          <span className="text-sm text-brand-800/45">/10</span>
        </div>
        {touched.energyLevel && errors.energyLevel && (
          <span id="energyLevel-error" className="text-xs text-red-600" role="alert">
            {errors.energyLevel}
          </span>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-4">
        <button
          type="submit"
          className="btn-primary flex-1"
        >
          {initialData ? 'Update Entry' : 'Save Entry'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="btn-secondary"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
