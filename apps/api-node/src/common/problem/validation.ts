import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { FieldError, Problems } from './problem.exception';

/**
 * The global validation pipe.
 *
 * Two settings here are contract requirements rather than preferences:
 *
 * - `whitelist: true` with `forbidNonWhitelisted: false`. The contract says
 *   unrecognised query parameters are *ignored*, not rejected, so unknown
 *   properties are stripped and the request proceeds. Turning on
 *   `forbidNonWhitelisted` would return 400 for a stray `?utm_source=`, which
 *   would break the API for anyone arriving from a link with tracking on it.
 *
 * - 422, not 400. The contract reserves 422 for a well-formed request whose
 *   contents are invalid, and every such response carries `errors[]`.
 *
 * Every failing field is reported, not the first: a client fixing a form one
 * field per round trip is the behaviour this avoids.
 */
export const validationPipeOptions: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
  // Deliberately NOT enableImplicitConversion, even though it makes query DTOs
  // more convenient. It coerces request *bodies* too, so a JSON number sent for
  // a string field becomes a string and passes `@IsString()`. Jackson on the
  // Java side is strict by default and would reject the same body with a 422 —
  // a parity failure produced entirely by a convenience setting.
  //
  // The cost is that query and path DTOs must declare `@Type(() => Number)`
  // explicitly, since those values genuinely do arrive as strings.
  stopAtFirstError: false,
  exceptionFactory: (errors) =>
    Problems.validationFailed(
      flattenValidationErrors(errors as ValidationError[]),
      'One or more fields are invalid.',
    ),
};

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe(validationPipeOptions);
}

/**
 * Flattens class-validator's tree into the contract's flat `errors[]`.
 *
 * Paths are built the way the contract's examples write them — `items[0].quantity`
 * — so a client can map an error straight onto a form field. class-validator
 * represents array indices as child properties named "0", "1", which is why the
 * numeric case is bracketed rather than dotted.
 */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldError[] {
  const flattened: FieldError[] = [];

  for (const error of errors) {
    const path = joinPath(parentPath, error.property);

    for (const message of Object.values(error.constraints ?? {})) {
      flattened.push({ field: path, message });
    }

    if (error.children && error.children.length > 0) {
      flattened.push(...flattenValidationErrors(error.children, path));
    }
  }

  return flattened;
}

function joinPath(parent: string, property: string): string {
  if (!parent) {
    return property;
  }
  return /^\d+$/.test(property) ? `${parent}[${property}]` : `${parent}.${property}`;
}
