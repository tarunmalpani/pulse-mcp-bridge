import { z } from 'zod';

// Every field MUST have .default() so configSchema.safeParse({}) succeeds
// on an empty install before the user has configured anything.
export const configSchema = z
  .object({
    relayUrl: z.string().default(''),
    relayApiKey: z.string().default(''),
    deviceId: z.string().default(''),
  })
  .passthrough();

export type PulseMcpConfig = z.infer<typeof configSchema>;
