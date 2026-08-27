export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareTextCaseInsensitive(left: string, right: string): number {
  return compareText(left.toLowerCase(), right.toLowerCase()) || compareText(left, right);
}
