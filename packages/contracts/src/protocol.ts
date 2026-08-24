import { z } from 'zod';

export const protocolVersion = 1 as const;
export const protocolVersionSchema = z.literal(protocolVersion);
