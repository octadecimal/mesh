import { z } from 'zod';

import {
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  projectIdSchema,
} from './ids';

export const gitCommitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export type GitCommit = z.infer<typeof gitCommitSchema>;

export const projectSchema = z.strictObject({
  id: projectIdSchema,
  displayName: z.string().trim().min(1).max(256),
  repositoryIdentity: z.string().min(1),
  repositoryPath: z.string().min(1),
  gitCommonDirectory: z.string().min(1),
  headCommit: gitCommitSchema,
  revision: nonNegativeIntegerSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type Project = z.infer<typeof projectSchema>;
