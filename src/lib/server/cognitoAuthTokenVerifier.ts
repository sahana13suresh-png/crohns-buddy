import type { AuthTokenVerifier } from './authTokenVerifier';
import { verifyCognitoRequest } from './cognitoAuth';

export const cognitoAuthTokenVerifier: AuthTokenVerifier = {
  verifyAuthToken: verifyCognitoRequest,
};

