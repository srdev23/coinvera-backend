import { BN } from "bn.js";

const WSOL = "So11111111111111111111111111111111111111112";
let cachedSolPrice = 130;

async function fetchLatestSolPrice() {
  const tmpSolPrice = await getSolPrice();
  cachedSolPrice = tmpSolPrice === 0 ? cachedSolPrice : tmpSolPrice;
  await sleep(1000);
  fetchLatestSolPrice();
}

fetchLatestSolPrice();

async function getSolPrice() {
  const url = `https://lite-api.jup.ag/price/v2?ids=${WSOL}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    const price = data.data[WSOL]?.price;
    return price;
  } catch (error) {
    console.error("Error fetching SOL price: " + error);
    return 0;
  }
}

export function getCachedSolPrice() {
  return cachedSolPrice || 130;
};

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export function toNonExponential(num: number): string {
  const str = num.toString();
  if (str.indexOf('e') === -1) return str;
  const [base, exponent] = str.split('e');
  let result = '';
  if (+exponent < 0) {
    result = '0.' + '0'.repeat(Math.abs(+exponent) - 1) + base.replace('.', '');
  } else {
    // For large exponents, handle accordingly
    // Not needed for small numbers
    result = base.replace('.', '') + '0'.repeat(+exponent);
  }
  return result;
}

export function convertNumbersAndCleanObject(obj: any): any {
  if (typeof obj === 'number') {
    return toNonExponential(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => convertNumbersAndCleanObject(item));
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = convertNumbersAndCleanObject(obj[key]);
        if (value !== undefined) { // Remove keys with undefined values
          result[key] = value;
        }
      }
    }
    return result;
  }
  // For primitives (string, boolean, null, etc.)
  return obj;
}

export function calculatePrice(
  numeratorAmount: string,
  denominatorAmount: string,
  decimalDifference: number
): number {
  // Add 9 decimals of precision for SOL conversion
  const decimalAdjustment = decimalDifference + 11;

  // Calculate price: (numerator * 10^adjustment) / denominator / 10^9
  const scaledNumerator = new BN(numeratorAmount).mul(
    new BN(10).pow(new BN(decimalAdjustment))
  );
  const rawPrice = scaledNumerator.div(new BN(denominatorAmount));

  // Convert to JavaScript number and adjust for 9 decimals
  return rawPrice.toNumber() / 1e11;
}

