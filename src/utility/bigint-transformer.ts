import { ValueTransformer } from 'typeorm';

export class BigintTransformer implements ValueTransformer {
  from(dbValue: unknown) {
    if (dbValue == null) {
      return dbValue;
    }
    const numberValue = Number.parseInt(String(dbValue), 10);
    if (!Number.isFinite(numberValue)) {
      return null;
    }
    return numberValue;
  }

  to(entityValue: unknown) {
    return entityValue;
  }
}
