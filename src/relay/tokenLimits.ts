/** Token counts are integral; invalid metadata should use the existing defaults. */
export function tokenLimit(value: unknown, minimum = 1): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}
