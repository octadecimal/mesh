import type { V2Database } from './database.js';

export const V2_APPLICATION_ID = 1_297_494_528;

export class V2DatabaseIdentityError extends Error {
  readonly code = 'database_identity_mismatch' as const;

  constructor(applicationId: number) {
    super(
      `Refusing to open non-V2 database with SQLite application ID ${applicationId}`,
    );
    this.name = 'V2DatabaseIdentityError';
  }
}

export const assertV2OrEmptyDatabase = (database: V2Database): void => {
  const applicationId = database.pragma('application_id', {
    simple: true,
  }) as number;
  const schemaObjects = (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number }
  ).count;
  if (
    applicationId !== V2_APPLICATION_ID &&
    !(applicationId === 0 && schemaObjects === 0)
  ) {
    throw new V2DatabaseIdentityError(applicationId);
  }
};
