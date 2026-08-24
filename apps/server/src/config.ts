const apiBillingOverrideVariables = ['ANTHROPIC_API_KEY'] as const;

export type BillingOverrideVariable = (typeof apiBillingOverrideVariables)[number];

export interface BillingConflict {
  variable: BillingOverrideVariable;
}

export const detectBillingOverrides = (
  environment: Readonly<Record<string, string | undefined>>,
): BillingConflict[] =>
  apiBillingOverrideVariables
    .filter((variable) => environment[variable]?.trim())
    .map((variable) => ({ variable }));
