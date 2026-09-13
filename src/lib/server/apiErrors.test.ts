import { describe, it, expect } from 'vitest';

import {
  CREDENTIAL_ERROR_BODY,
  DELETION_INCOMPLETE_BODY,
  NOT_FOUND_BODY,
  PLAN_LIMIT_REACHED_BODY,
  PLAN_TOO_LARGE_BODY,
  PLAN_UNREADABLE_BODY,
  SERVICE_UNAVAILABLE_BODY,
  STORAGE_ACK_REQUIRED_BODY,
  credentialErrorResponse,
  deletionIncompleteResponse,
  mealPlanValidationErrorResponse,
  notFoundResponse,
  planLimitReachedResponse,
  planTooLargeResponse,
  planUnreadableResponse,
  saveFailureResponse,
  serviceUnavailableResponse,
  storageAckRequiredResponse,
  storeFailureCategoryFor,
  validationErrorResponse,
} from './apiErrors';
import { MealPlanValidationError } from '../mealPlanSerializer';

describe('frozen bodies', () => {
  it('freezes every body the credential and ownership classes depend on', () => {
    for (const body of [
      CREDENTIAL_ERROR_BODY,
      NOT_FOUND_BODY,
      PLAN_LIMIT_REACHED_BODY,
      PLAN_TOO_LARGE_BODY,
      PLAN_UNREADABLE_BODY,
      STORAGE_ACK_REQUIRED_BODY,
      DELETION_INCOMPLETE_BODY,
      SERVICE_UNAVAILABLE_BODY,
    ]) {
      expect(Object.isFrozen(body)).toBe(true);
    }
  });

  it('carries only a code and a message, so no record detail can leak', () => {
    expect(Object.keys(NOT_FOUND_BODY)).toEqual(['error', 'message']);
    expect(Object.keys(CREDENTIAL_ERROR_BODY)).toEqual(['error', 'message']);
  });
});

describe('status mapping', () => {
  it('maps each failure class to its documented status', async () => {
    const cases: Array<[Response, number, string]> = [
      [credentialErrorResponse(), 401, 'UNAUTHENTICATED'],
      [notFoundResponse(), 404, 'NOT_FOUND'],
      [validationErrorResponse('content.meals', '1 to 10 meals'), 400, 'VALIDATION_FAILED'],
      [planLimitReachedResponse(), 409, 'PLAN_LIMIT_REACHED'],
      [planTooLargeResponse(), 413, 'PLAN_TOO_LARGE'],
      [planUnreadableResponse(), 422, 'PLAN_UNREADABLE'],
      [storageAckRequiredResponse(), 428, 'STORAGE_ACK_REQUIRED'],
      [deletionIncompleteResponse(), 500, 'DELETION_INCOMPLETE'],
      [serviceUnavailableResponse(), 503, 'SERVICE_UNAVAILABLE'],
    ];

    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(((await response.json()) as { error: string }).error).toBe(code);
    }
  });

  it('challenges only on the credential failure', () => {
    expect(credentialErrorResponse().headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(notFoundResponse().headers.get('WWW-Authenticate')).toBeNull();
  });
});

describe('indistinguishable bodies', () => {
  it('produces identical 404 bytes on every call, whatever the cause', async () => {
    const ownedElsewhere = await notFoundResponse().text();
    const nonexistent = await notFoundResponse().text();
    const malformedId = await saveFailureResponse('not-found').text();

    expect(nonexistent).toBe(ownedElsewhere);
    expect(malformedId).toBe(ownedElsewhere);
    expect(JSON.parse(ownedElsewhere)).toEqual(NOT_FOUND_BODY);
  });

  it('produces identical 401 bytes on every call', async () => {
    expect(await credentialErrorResponse().text()).toBe(await credentialErrorResponse().text());
  });
});

describe('validation responses', () => {
  it('names the field and the bound without echoing the submitted value', async () => {
    const response = validationErrorResponse('content.meals[0].items[3].portion', '1 to 100 characters');
    const body = (await response.json()) as { message: string; field: string };

    expect(body.field).toBe('content.meals[0].items[3].portion');
    expect(body.message).toContain('content.meals[0].items[3].portion');
    expect(body.message).toContain('1 to 100 characters');
  });

  it('names the field alone when no bound is supplied', async () => {
    const body = (await validationErrorResponse('cursor').json()) as { message: string; field: string };
    expect(body.field).toBe('cursor');
    expect(body.message).toBe('Request field "cursor" is not valid.');
  });

  it('carries a serializer validation error through as a 400 naming its field', async () => {
    const error = new MealPlanValidationError('content.warnings', '0 to 20 warnings');
    const response = mealPlanValidationErrorResponse(error);
    const body = (await response.json()) as { field: string; message: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe('content.warnings');
    expect(body.message).toContain('0 to 20 warnings');
  });

  it('keeps the faulting attribute out of the 422 body', async () => {
    const body = (await planUnreadableResponse().json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error', 'message']);
    expect(body).toEqual(PLAN_UNREADABLE_BODY);
  });
});

describe('outcome and log-category mapping', () => {
  it('maps each failing save outcome to its status', () => {
    expect(saveFailureResponse('cap-reached').status).toBe(409);
    expect(saveFailureResponse('ack-required').status).toBe(428);
    expect(saveFailureResponse('not-found').status).toBe(404);
  });

  it('pairs each code with the store failure category from the taxonomy', () => {
    expect(storeFailureCategoryFor('NOT_FOUND')).toBe('not-found');
    expect(storeFailureCategoryFor('PLAN_LIMIT_REACHED')).toBe('cap');
    expect(storeFailureCategoryFor('PLAN_TOO_LARGE')).toBe('size');
    expect(storeFailureCategoryFor('VALIDATION_FAILED')).toBe('validation');
    expect(storeFailureCategoryFor('STORAGE_ACK_REQUIRED')).toBe('validation');
    expect(storeFailureCategoryFor('PLAN_UNREADABLE')).toBe('validation');
    expect(storeFailureCategoryFor('SERVICE_UNAVAILABLE')).toBe('unavailable');
    expect(storeFailureCategoryFor('DELETION_INCOMPLETE')).toBe('unavailable');
    expect(storeFailureCategoryFor('UNAUTHENTICATED')).toBeUndefined();
  });
});
