import type { AuthTokenVerifier } from './authTokenVerifier';
import { verifyLogtoRequest } from './logtoAuth';

export const logtoAuthTokenVerifier: AuthTokenVerifier = {
  verifyAuthToken: verifyLogtoRequest,
};
