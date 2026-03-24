import { PublicKey, TokenAccountBalancePair } from "@solana/web3.js";
import { getMintDecoder } from "@solana-program/token-2022";
import { Metaplex } from "@metaplex-foundation/js";
import { BN } from "bn.js";
import { TokenMetaData } from "./type";
import { CLEAR_CACHE_INTERVAL, connection } from "../config";

const cacheMetaData = new Map<string, TokenMetaData>();
const metaplex = new Metaplex(connection);

setInterval(() => {
  cacheMetaData.clear();
}, CLEAR_CACHE_INTERVAL);

async function getNormalToken(ca: string){
  const metaData = await metaplex
    .nfts()
    .findByMint({ mintAddress: new PublicKey(ca) });
  
  const name = metaData.name;
  const symbol = metaData.symbol;
  const image = metaData.json?.image||null;
  const description = metaData.json?.description||null;
  const socials = extractSocial(metaData.json);
  const decimals = metaData.mint.decimals;
  const supply = metaData.mint.supply.basisPoints.div(new BN(10 ** decimals)).toNumber();
  const mintAuthority = metaData.mint.mintAuthorityAddress?.toBase58()||null;
  const freezeAuthority = metaData.mint.freezeAuthorityAddress?.toBase58()||null;
  const updateAuthority = metaData.updateAuthorityAddress?.toBase58()||null;
  const creators = convertPubkey2String(metaData.creators);

  return {
    name,
    symbol,
    image,
    description,
    socials,
    decimals,
    supply,
    mintAuthority,
    freezeAuthority,
    updateAuthority,
    creators,
    isToken2022: false,
  };
}

async function getToken2022(ca: string){
    const mint = new PublicKey(ca);
    const tokenAccInfo = await connection.getAccountInfo(mint);
    const mintInfo = getMintDecoder().decode(new Uint8Array(tokenAccInfo?.data ?? []));
    const analyzedData = await analyzeToken2022Data(mintInfo);
    return analyzedData;
}

interface Token2022Extension {
  __kind: string;
  [key: string]: any;
}

interface Token2022MintInfo {
  mintAuthority: { __option: string, value?: string };
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: { __option: string, value?: string };
  extensions: { __option: string; value?: Token2022Extension[] };
}

async function analyzeToken2022Data(mintInfo: Token2022MintInfo) {
  const result: TokenMetaData = {
    name: "Unknown",
    symbol: "Unknown", 
    image: null,
    description: null,
    socials: {},
    mintAuthority: mintInfo.mintAuthority.__option === 'Some' ? mintInfo.mintAuthority.value || null : null,
    freezeAuthority: mintInfo.freezeAuthority.__option === 'Some' ? mintInfo.freezeAuthority.value || null : null,
    updateAuthority: null,
    decimals: mintInfo.decimals,
    supply: Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals),
    creators: undefined as string[] | undefined,
    isToken2022: true
  };

  // Extract data from extensions
  if (mintInfo.extensions.__option === 'Some' && mintInfo.extensions.value) {
    for (const extension of mintInfo.extensions.value) {
      switch (extension.__kind) {
        case 'TokenMetadata':
          result.name = extension.name || "Unknown";
          result.symbol = extension.symbol || "Unknown";
          
          // Extract update authority
          if (extension.updateAuthority?.__option === 'Some') {
            result.updateAuthority = extension.updateAuthority.value;
          }
          // Fetch metadata from URI if available
          if (extension.uri) {
            try {
              const metadataFromUri = await fetchMetadataFromUri(extension.uri);
              if (metadataFromUri) {
                result.image = metadataFromUri.image;
                result.description = metadataFromUri.description;
                result.socials = extractSocial(metadataFromUri);
              }
            } catch (error) {
              // console.error(`Failed to fetch metadata from URI: ${extension.uri}`, error);
            }
          }
          break;

        case 'MetadataPointer':
          // Handle metadata pointer if needed
          // console.log('MetadataPointer found:', extension);
          break;

        case 'TransferFeeConfig':
          // Handle transfer fee config if needed for additional info
          // console.log('TransferFeeConfig found:', extension);
          break;

        default:
          // console.log(`Unknown extension type: ${extension.__kind}`);
      }
    }
  }

  return result;
}

async function fetchMetadataFromUri(uri: string) {
  try {
    // Handle IPFS URIs
    let fetchUrl = uri;
    if (uri.startsWith('ipfs://')) {
      fetchUrl = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const metadata = await response.json();
    return metadata;
  } catch (error) {
    console.error('Error fetching metadata from URI:', error);
    return null;
  }
}


function convertPubkey2String(obj: any): any {
  if (obj === null || obj === undefined) {
      return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
      return obj.map(item => convertPubkey2String(item));
  }

  // Handle objects
  if (typeof obj === 'object') {
    if (obj instanceof PublicKey) {
        return obj.toBase58();
    }

    const converted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = convertPubkey2String(value);
    }
    return converted;
  }
  return obj;
}

function extractSocial(obj: any): any {
  if (obj === null || obj === undefined) {
      return {};
  }

  const socials: any = {};

  // Handle objects
  if (typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'website' || key === 'telegram' || key === 'twitter') {
          socials[key] = value;
        } else if (typeof value === 'object' && value !== null) {
          // Recursively search nested objects and merge results
          const nestedSocials = extractSocial(value);
          Object.assign(socials, nestedSocials);
        }
      }
  }

  return socials;
}

export async function getTokenMetaData(ca: string) {
  let tokenMetaData = cacheMetaData.get(ca);
  if (tokenMetaData === undefined) {
    try{
      tokenMetaData = await getNormalToken(ca);
    }catch(e){
      console.log("get normal token error", e)
      tokenMetaData = await getToken2022(ca);
    }
    cacheMetaData.set(ca, tokenMetaData);
  }
  // console.log("got meta data", Date.now())
  return tokenMetaData;
}

export function calculateTotalPercentage(holders: TokenAccountBalancePair[], totalAmount: number) {
  const holdersWithPercentage = holders.map(holder => ({
    ...holder,
    percentage: totalAmount > 0 ? (holder.uiAmount||0) / totalAmount * 100 : 0,
  }));
  const amount = holdersWithPercentage.reduce((total, holder) => total + (holder.uiAmount||0), 0)
  const percentage = holdersWithPercentage.reduce((total, holder) => total + holder.percentage, 0)
  return {
    amount: Number(amount.toFixed(6)),
    percentage: Number(percentage.toFixed(2))
  }
};

export async function getHolders(ca: string) {
  const holders = await connection.getTokenLargestAccounts(new PublicKey(ca));
  // const totalAmount = holders.value.reduce((sum, holder) => sum + (holder.uiAmount||0), 0);
  // Add percentage calculation to each holder
  
  // Sort by amount (highest first)
  const sortedArray = holders.value.sort((a, b) => (b.uiAmount||0) - (a.uiAmount||0));

  const top10 = sortedArray.slice(1, 10);
  const top20 = sortedArray.slice(1, 20);

  // const totalHolders = holdersWithPercentage.length;
  // const top10Percentage = calculateTotalPercentage(top10).toFixed(2);
  // const top25Percentage = calculateTotalPercentage(top20).toFixed(2);
  return {
    top10,
    top20,
  };
}