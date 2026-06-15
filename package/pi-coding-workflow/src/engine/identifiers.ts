export function isFinalConfirmationDecisionId(id: string): boolean {
  return /(?:stage1[-_.])?final[-_.]?confirm|final[-_.]?confirmation|prd[-_.]?confirm/i.test(id);
}
