import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StorageNoticeDialog, {
  ACKNOWLEDGE_LABEL,
  DECLINE_LABEL,
  STORAGE_NOTICE_DECLINED_MESSAGE,
} from './StorageNoticeDialog';

const onAcknowledge = vi.fn();
const onDecline = vi.fn();

function renderDialog(submitting = false) {
  return render(
    <StorageNoticeDialog
      onAcknowledge={onAcknowledge}
      onDecline={onDecline}
      submitting={submitting}
    />
  );
}

describe('StorageNoticeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Requirement 12.3 — explain what is saved, how it is protected, and how
  // long it is kept without exposing infrastructure details.
  it('explains the health-related data, protection, and retention in user terms', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(/health-related data/i);
    expect(dialog).toHaveTextContent(/adds it to your account/i);
    expect(dialog).toHaveTextContent(/encrypted while stored and while being sent/i);
    expect(dialog).toHaveTextContent(/until you delete them or delete your account/i);
    expect(dialog).not.toHaveTextContent(
      /Amazon|AWS|DynamoDB|us-east-1|Northern Virginia|cloud storage/i
    );
  });

  it('labels the dialog by its heading and links to the Privacy Notice', () => {
    renderDialog();

    const heading = screen.getByRole('heading', { name: 'Storing your meal plan' });
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', heading.id);
    expect(screen.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'href',
      '/privacy'
    );
  });

  // Requirement 12.3 — exactly one acknowledgment control, and it is the only
  // path that leads to a write.
  it('reports the acknowledgment once when the acknowledge control is activated', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: ACKNOWLEDGE_LABEL }));

    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
  });

  // Requirement 12.5 — declining reports a decline and never an acknowledgment,
  // so the caller resubmits nothing.
  it('reports a decline when the decline control is activated', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: DECLINE_LABEL }));

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  // Requirement 12.5 — closing the notice is the same outcome as declining it.
  it('reports a decline when the close control is activated', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it('reports a decline when Escape is pressed', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.keyboard('{Escape}');

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog so the notice is read before either choice', () => {
    renderDialog();

    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('disables both choices and shows progress while the acknowledged save is in flight', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: DECLINE_LABEL })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('states that saving requires the acknowledgment and that nothing was saved', () => {
    expect(STORAGE_NOTICE_DECLINED_MESSAGE).toMatch(/acknowledg/i);
    expect(STORAGE_NOTICE_DECLINED_MESSAGE).toMatch(/nothing has been saved/i);
  });
});
