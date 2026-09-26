export class CreditsError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InsufficientCredits extends CreditsError {
  constructor(
    public readonly account: string,
    public readonly requested: number,
    public readonly balance: number,
  ) {
    super(
      `Insufficient credits for account ${account}: requested ${requested}, balance ${balance}`,
      "insufficient_credits",
    );
  }
}

export class AccountSuspended extends CreditsError {
  constructor(
    public readonly account: string,
    public readonly reason: string | null = null,
  ) {
    super(
      reason
        ? `Account ${account} is suspended: ${reason}`
        : `Account ${account} is suspended`,
      "account_suspended",
    );
  }
}

export class AccountNotFound extends CreditsError {
  constructor(public readonly account: string) {
    super(`Account ${account} not found`, "account_not_found");
  }
}

export class IdempotencyConflict extends CreditsError {
  constructor(public readonly idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} was reused with different inputs`,
      "idempotency_conflict",
    );
  }
}

export class InvalidAmount extends CreditsError {
  constructor(message = "Credits amount must be a positive integer") {
    super(message, "invalid_amount");
  }
}

export class RefundLimitExceeded extends CreditsError {
  constructor(
    public readonly spendEntryId: string,
    public readonly requested: number,
    public readonly remaining: number,
  ) {
    super(
      `Refund of ${requested} exceeds remaining ${remaining} on spend ${spendEntryId}`,
      "refund_limit_exceeded",
    );
  }
}

export class EntryNotFound extends CreditsError {
  constructor(public readonly entryId: string) {
    super(`Ledger entry ${entryId} not found`, "entry_not_found");
  }
}

export class PurchaseNotFound extends CreditsError {
  constructor(public readonly purchaseRef: string) {
    super(`No grant found for purchase ref ${purchaseRef}`, "purchase_not_found");
  }
}

export class MigrationDrift extends CreditsError {
  constructor(
    public readonly id: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Migration ${id} checksum drifted (stored ${actual}, current ${expected})`,
      "migration_drift",
    );
  }
}

export class HoldNotFound extends CreditsError {
  constructor(public readonly holdId: string) {
    super(`Hold ${holdId} not found`, "hold_not_found");
  }
}

export class HoldNotActive extends CreditsError {
  constructor(
    public readonly holdId: string,
    public readonly status: string,
  ) {
    super(`Hold ${holdId} is ${status}`, "hold_not_active");
  }
}

export class HoldExceedsReserved extends CreditsError {
  constructor(
    public readonly holdId: string,
    public readonly requested: number,
    public readonly reserved: number,
  ) {
    super(
      `Settle of ${requested} exceeds reserved ${reserved} on hold ${holdId}`,
      "hold_exceeds_reserved",
    );
  }
}

export class InvalidPack extends CreditsError {
  constructor(message: string) {
    super(message, "invalid_pack");
  }
}
