/** The access token's claim set. A parity surface — see docs/auth-tokens.md. */
export interface JwtClaims {
  /** The user's id. */
  sub: string;
  /** `customer` or `admin`. Carried in the token so authorisation needs no query. */
  role: string;
  iat: number;
  exp: number;
}

/** What the guard attaches to the request. Not the full user row. */
export interface AuthenticatedUser {
  id: string;
  role: string;
}

/** Matches `TokenPair` in the contract. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Seconds. Not milliseconds, and not a timestamp. */
  expiresIn: number;
}

/** Matches `User` in the contract. */
export interface UserView {
  id: string;
  email: string;
  fullName: string;
  role: string;
  createdAt: Date;
}

/** Matches `AuthSession` in the contract. */
export interface AuthSession {
  user: UserView;
  tokens: TokenPair;
}
