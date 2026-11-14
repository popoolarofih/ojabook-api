import { ValidationError, ValidationPipe } from '@nestjs/common';
import { badRequest } from '../common/errors';

function flatten(errors: ValidationError[], parent = ''): { field: string; messages: string[] }[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints ? [{ field, messages: Object.values(e.constraints) }] : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true, // strip unknown properties (mass assignment protection)
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      badRequest('VALIDATION_FAILED', 'Some fields are invalid.', flatten(errors)),
  });
