import { InvalidPack } from "./errors.js";

export type Pack = {
  id: string;
  credits: number;
  amount: number;
  currency: string;
  label?: string;
};

export function definePacks(packs: Pack[]): Pack[] {
  const ids = new Set<string>();
  for (const pack of packs) {
    if (typeof pack.id !== "string" || pack.id.length === 0) {
      throw new InvalidPack("Pack id must be a non-empty string");
    }
    if (ids.has(pack.id)) {
      throw new InvalidPack(`Duplicate pack id: ${pack.id}`);
    }
    ids.add(pack.id);
    if (!Number.isInteger(pack.credits) || pack.credits <= 0) {
      throw new InvalidPack(`Pack ${pack.id} credits must be a positive integer`);
    }
    if (!Number.isInteger(pack.amount) || pack.amount <= 0) {
      throw new InvalidPack(`Pack ${pack.id} amount must be a positive integer`);
    }
    if (typeof pack.currency !== "string" || pack.currency.length === 0) {
      throw new InvalidPack(`Pack ${pack.id} currency must be a non-empty string`);
    }
  }
  return packs;
}
