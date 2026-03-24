export type DEX_TYPE = "pumpfun" | "raydium" | "moonshot" | "meteora" | "launchlab";
export type API_TYPE = "price" | "overview";

export type TokenMetaData = {
  name: string,
  symbol: string,
  image: string|null,
  description: string|null,
  socials: any,
  decimals: number,
  supply: number,
  mintAuthority: string|null,
  freezeAuthority: string|null,
  updateAuthority: string|null,
  creators: any,
  isToken2022: boolean,
}