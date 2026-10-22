// Australian Business Number checksum (ATO algorithm).
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export function normaliseAbn(abn: string): string {
  return abn.replace(/\D/g, "");
}

export function isValidAbn(abn: string): boolean {
  const digits = normaliseAbn(abn);
  if (digits.length !== 11) return false;
  const nums = digits.split("").map(Number);
  nums[0] -= 1;
  const sum = nums.reduce((acc, n, i) => acc + n * WEIGHTS[i], 0);
  return sum % 89 === 0;
}

export function formatAbn(abn: string): string {
  const d = normaliseAbn(abn);
  return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : abn;
}
