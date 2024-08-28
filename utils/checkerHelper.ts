import {
  Allocation,
  AssetMintLimit,
  CandyMachine,
  GuardSet,
  MintLimit,
  NftMintCounter,
  NftMintLimit,
  fetchAssetMintCounter,
  fetchNftMintCounter,
  findAssetMintCounterPda,
  findNftMintCounterPda,
  safeFetchAllocationTrackerFromSeeds,
  safeFetchMintCounterFromSeeds,
} from "@metaplex-foundation/mpl-core-candy-machine";
import {
  fetchToken,
  findAssociatedTokenPda,
} from "@metaplex-foundation/mpl-toolbox";
import {
  Pda,
  PublicKey,
  SolAmount,
  Some,
  Umi,
  publicKey,
} from "@metaplex-foundation/umi";
import { DigitalAssetWithToken } from "@metaplex-foundation/mpl-token-metadata";
import { createStandaloneToast } from "@chakra-ui/react";
import { DasApiAsset } from "@metaplex-foundation/digital-asset-standard-api";
import { DasExtra } from "@metaplex-foundation/mpl-core-das/dist/src/types";
import { AssetV1 } from "@metaplex-foundation/mpl-core";

export interface GuardReturn {
  label: string;
  allowed: boolean;
  minting?: boolean;
  loadingText?: string;
  reason?: string;
  maxAmount: number;
  mintAmount?: number;
}
export type DigitalAssetWithTokenAndNftMintLimit = DigitalAssetWithToken & {
  nftMintLimit?: number;
  nftMintLimitPda?: Pda;
};

export type DasApiAssetAndAssetMintLimit = AssetV1 & DasExtra & {
  assetMintLimit?: number;
  assetMintLimitPda?: Pda;
}

export const addressGateChecker = (wallet: PublicKey, address: PublicKey) => {
  if (wallet != address) {
    return false;
  }
  return true;
};

export const allocationChecker = async (
  umi: Umi,
  candyMachine: CandyMachine,
  guard: {
    label: string;
    guards: GuardSet;
  }
) => {
  const allocation = guard.guards.allocation as Some<Allocation>;

  try {
    const mintCounter = await safeFetchAllocationTrackerFromSeeds(umi, {
      id: allocation.value.id,
      candyMachine: candyMachine.publicKey,
      candyGuard: candyMachine.mintAuthority,
    });

    if (mintCounter) {
      return allocation.value.limit - mintCounter.count;
    } else {
      // no allocation mint Counter found - not created yet
      createStandaloneToast().toast({
        title: "Allocation Guard not Initialized!",
        description: "Minting will fail!",
        status: "error",
        duration: 900,
        isClosable: true,
      });
      return allocation.value.limit;
    }
  } catch (error) {
    console.error(`AllocationChecker: ${error}`);
    return 0;
  }
};

export const solBalanceChecker = (
  solBalance: SolAmount,
  solAmount: SolAmount
) => {
  if (solAmount > solBalance) {
    return false;
  }
  return true;
};

export const tokenBalanceChecker = async (
  umi: Umi,
  tokenAmount: bigint,
  tokenMint: PublicKey
) => {
  const ata = findAssociatedTokenPda(umi, {
    mint: tokenMint,
    owner: umi.identity.publicKey,
  });

  const balance = await fetchToken(umi, umi.identity.publicKey);

  if (Number(balance.amount) < Number(tokenAmount)) {
    return false;
  }
  return true;
};

export const mintLimitChecker = async (
  umi: Umi,
  candyMachine: CandyMachine,
  guard: {
    label: string;
    guards: GuardSet;
  }
) => {
  const mintLimit = guard.guards.mintLimit as Some<MintLimit>;

  //not minted yet
  try {
    const mintCounter = await safeFetchMintCounterFromSeeds(umi, {
      id: mintLimit.value.id,
      user: umi.identity.publicKey,
      candyMachine: candyMachine.publicKey,
      candyGuard: candyMachine.mintAuthority,
    });

    if (mintCounter) {
      return mintLimit.value.limit - mintCounter.count;
    } else {
      // no mintlimit counter found. Possibly the first mint
      return mintLimit.value.limit;
    }
  } catch (error) {
    console.error(`mintLimitChecker: ${error}`);
    return 0;
  }
};

export const nftMintLimitChecker = async (
  umi: Umi,
  candyMachine: CandyMachine,
  guard: {
    label: string;
    guards: GuardSet;
  },
  ownedNfts: DigitalAssetWithTokenAndNftMintLimit[]
) => {
  const nftMintLimit = guard.guards.nftMintLimit as Some<NftMintLimit>;

  const collectionAssets = ownedNfts.filter(
    (el) =>
      el.metadata.collection.__option === "Some" &&
      el.metadata.collection.value.key ===
        nftMintLimit.value.requiredCollection &&
      el.metadata.collection.value.verified === true
  );
  try {
    let counterPromises = collectionAssets.map((asset) => {
      const pda = findNftMintCounterPda(umi, {
        id: nftMintLimit.value.id,
        mint: asset.publicKey,
        candyGuard: candyMachine.mintAuthority,
        candyMachine: candyMachine.publicKey,
      });

      return fetchNftMintCounter(umi, pda)
        .then((counterValue) => ({
          ...asset,
          nftMintLimit: counterValue.count + 1,
          nftMintLimitPda: pda,
        }))
        .catch((e) => ({
          ...asset,
          nftMintLimit: nftMintLimit.value.limit,
        }));
    });

    let filteredResults: DigitalAssetWithTokenAndNftMintLimit[] = [];
    await Promise.all(counterPromises)
      .then((results) => {
        filteredResults = results.filter(
          (item) =>
            item.nftMintLimit !== undefined &&
            item.nftMintLimit < nftMintLimit.value.limit + 1
        );
      })
      .catch((error) => {
        console.error("An error occurred while fetching counters:", error);
      });

      const resultObject = {
        nftMintLimitAssets: filteredResults,
        ownedNfts: ownedNfts.map((asset) => {
          const matchingAsset = filteredResults.find((result) => result.publicKey === asset.publicKey);
          if (matchingAsset) {
            return {
              ...asset,
              nftMintLimit: matchingAsset.nftMintLimit,
              nftMintLimitPda: matchingAsset.nftMintLimitPda,
            };
          } else {
            // If no matching asset found in filteredResults, retain original asset data
            return {
              ...asset,
              nftMintLimit: 0, // or any default value you prefer
              nftMintLimitPda: undefined, // or any default value you prefer
            };
          }
        }),
      };
    return resultObject;
  } catch (error) {
    console.error(`mintLimitChecker: ${error}`);
    return {
      nftMintLimitAssets: [],
      ownedNfts,
    };
  }
};

export const assetMintLimitChecker = async (
  umi: Umi,
  candyMachine: CandyMachine,
  guard: {
    label: string;
    guards: GuardSet;
  },
  ownedCoreAssets: DasApiAssetAndAssetMintLimit[]
) => {
  const assetMintLimit = guard.guards.assetMintLimit as Some<AssetMintLimit>;

  const collectionAssets = ownedCoreAssets.filter(
    (el) =>
      el.updateAuthority.address ===
        assetMintLimit.value.requiredCollection
  );
  try {
    let counterPromises = collectionAssets.map((asset) => {
      const pda = findAssetMintCounterPda(umi, {
        id: assetMintLimit.value.id,
        asset: asset.publicKey,
        candyGuard: candyMachine.mintAuthority,
        candyMachine: candyMachine.publicKey,
      });

      return fetchAssetMintCounter(umi, pda)
        .then((counterValue) => ({
          ...asset,
          assetMintLimit: counterValue.count + 1,
          assetMintLimitPda: pda,
        }))
        .catch((e) => ({
          ...asset,
          assetMintLimit: assetMintLimit.value.limit,
        }));
    });

    let filteredResults: DasApiAssetAndAssetMintLimit[] = [];
    await Promise.all(counterPromises)
      .then((results) => {
        filteredResults = results.filter(
          (item) =>
            item.assetMintLimit !== undefined &&
            item.assetMintLimit < assetMintLimit.value.limit + 1
        );
      })
      .catch((error) => {
        console.error("An error occurred while fetching counters:", error);
      });

      const resultObject = {
        assetMintLimitAssets: filteredResults,
        ownedCoreAssets: ownedCoreAssets.map((asset) => {
          const matchingAsset = filteredResults.find((result) => result.publicKey === asset.publicKey);
          if (matchingAsset) {
            return {
              ...asset,
              assetMintLimit: matchingAsset.assetMintLimit,
              nftMintLimitPda: matchingAsset.assetMintLimitPda,
            };
          } else {
            // If no matching asset found in filteredResults, retain original asset data
            return {
              ...asset,
              assetMintLimit: 0, // or any default value you prefer
              assetMintLimitPda: undefined, // or any default value you prefer
            };
          }
        }),
      };
    return resultObject;
  } catch (error) {
    console.error(`assetLimitChecker: ${error}`);
    return {
      assetMintLimitAssets: [],
      ownedCoreAssets,
    };
  }
};

export const ownedNftChecker = async (
  ownedNfts: DigitalAssetWithToken[],
  requiredCollection: PublicKey
) => {
  const count = ownedNfts.filter(
    (el) =>
      el.metadata.collection.__option === "Some" &&
      el.metadata.collection.value.key === requiredCollection &&
      el.metadata.collection.value.verified === true
  ).length;
  return count;
};

export const ownedCoreAssetChecker = async (
  ownedNfts: DasApiAssetAndAssetMintLimit[],
  requiredCollection: PublicKey
) => {
  const count = ownedNfts.filter(
    (el) =>
      el.updateAuthority.address === requiredCollection
  ).length;
  return count;
};

export const allowlistChecker = (
  allowLists: Map<string, string[]>,
  umi: Umi,
  guardlabel: string
) => {
  if (!allowLists.has(guardlabel)) {
    console.error(`Guard ${guardlabel}; allowlist missing from allowlist.tsx`);
    return false;
  }
  if (
    !allowLists.get(guardlabel)?.includes(publicKey(umi.identity.publicKey))
  ) {
    return false;
  }
  return true;
};

export const getSolanaTime = async (umi: Umi) => {
  const slot = await umi.rpc.getSlot();

  let solanaTime = await umi.rpc.getBlockTime(slot);

  if (!solanaTime) solanaTime = BigInt(0);
  return solanaTime;
};

export const checkDateRequired = (
  guards: { label: string; guards: GuardSet }[]
) => {
  for (const guard of guards) {
    if (guard.guards.startDate || guard.guards.endDate) {
      return true;
    }
  }

  return false;
};

export const checkSolBalanceRequired = (
  guards: { label: string; guards: GuardSet }[]
) => {
  let solBalanceRequired: boolean = false;
  guards.forEach((guard) => {
    if (guard.guards.freezeSolPayment || guard.guards.solPayment) {
      solBalanceRequired = true;
    }
  });

  return solBalanceRequired;
};

export const checkTokensRequired = (
  guards: { label: string; guards: GuardSet }[]
) => {
  let nftBalanceRequired: boolean = false;
  guards.forEach((guard) => {
    if (
      guard.guards.nftBurn ||
      guard.guards.nftGate ||
      guard.guards.nftPayment ||
      guard.guards.nftMintLimit
    ) {
      nftBalanceRequired = true;
    }
  });

  return nftBalanceRequired;
};

export const checkCoreAssetsRequired = (
  guards: { label: string; guards: GuardSet }[]
) => {
  let coreAssetBalanceRequired: boolean = false;
  guards.forEach((guard) => {
    if (
      guard.guards.assetBurn ||
      guard.guards.assetBurnMulti ||
      guard.guards.assetPayment ||
      guard.guards.assetPaymentMulti ||
      guard.guards.assetMintLimit
    ) {
      coreAssetBalanceRequired = true;
    }
  });

  return coreAssetBalanceRequired;
};

export const calculateMintable = (
  mintableAmount: number,
  newAmount: number
) => {
  if (mintableAmount > newAmount) {
    mintableAmount = newAmount;
  }

  if (!process.env.NEXT_PUBLIC_MAXMINTAMOUNT) return mintableAmount;
  let maxmintamount = 0;
  try {
    maxmintamount = Number(process.env.NEXT_PUBLIC_MAXMINTAMOUNT);
  } catch (e) {
    console.error("process.env.NEXT_PUBLIC_MAXMINTAMOUNT is not a number!", e);
    return mintableAmount;
  }
  if (mintableAmount > maxmintamount) {
    mintableAmount = maxmintamount;
  }

  return mintableAmount;
};
