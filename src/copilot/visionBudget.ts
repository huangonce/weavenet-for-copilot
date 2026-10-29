import type { CanonicalChatMessage } from './canonicalRequest';
import { estimateTextTokens } from './helpers';

export const VISION_DESCRIPTION_TOKENS_PER_IMAGE = 1_024;
const MAX_VISION_DESCRIPTION_IMAGES = 8;

/** Conservative reservation also covers captions retained from earlier turns. */
export function reservedVisionDescriptionTokens(imageCount: number): number {
  return VISION_DESCRIPTION_TOKENS_PER_IMAGE * Math.min(MAX_VISION_DESCRIPTION_IMAGES, Math.max(0, Math.floor(imageCount)));
}

/** Allowance for current-turn captions, including framing; historical captions keep their original text. */
export function visionDescriptionTokenBudget(
  imageCount: number,
  maxInputTokens: number,
  baseInputTokens = 0,
): number {
  const inputLimit = Number.isFinite(maxInputTokens) ? Math.max(0, Math.floor(maxInputTokens)) : 0;
  return Math.max(0, Math.min(
    reservedVisionDescriptionTokens(imageCount),
    Math.floor(inputLimit / 4),
    inputLimit - Math.max(0, Math.ceil(baseInputTokens)),
  ));
}

/** Base text/tool estimate; image reservations and protocol-specific reasoning are added separately. */
export function estimateCanonicalTextTokens(messages: readonly CanonicalChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += 4;
    for (const part of message.content) {
      if (part.kind === 'text') tokens += estimateTextTokens(part.value);
      else if (part.kind === 'toolCall') tokens += estimateTextTokens(part.name) + estimateTextTokens(part.inputJson);
      else if (part.kind === 'toolResult') {
        for (const nested of part.content) if (nested.kind === 'text') tokens += estimateTextTokens(nested.value);
      }
    }
  }
  return tokens;
}

/** Fits the final framed text to the same local estimator used by the host token count. */
export function truncateVisionDescription(
  description: string,
  tokenBudget: number,
  frame: (description: string) => string,
): string {
  if (tokenBudget <= 0) return '';
  const value = description.trim();
  const complete = frame(value);
  if (estimateTextTokens(complete) <= tokenBudget) return complete;
  let framed = frame('…');
  if (estimateTextTokens(framed) > tokenBudget) return '';
  const characters = Array.from(value);
  let lower = 0;
  let upper = characters.length;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = frame(`${characters.slice(0, middle).join('').trimEnd()}…`);
    if (estimateTextTokens(candidate) <= tokenBudget) {
      framed = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return framed;
}
