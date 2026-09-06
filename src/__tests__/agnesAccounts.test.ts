import { describe, expect, it } from "vitest";

import {
  fingerprintAgnesKey,
  loadAgnesAccounts,
} from "../providers/agnes/index.js";

describe("loadAgnesAccounts", () => {
  it("returns no accounts when no keys or IDs are configured", () => {
    expect(loadAgnesAccounts({})).toEqual([]);
  });

  it("orders sparse lanes and supplies stable labels, IDs, and fingerprints", () => {
    expect(loadAgnesAccounts({
      AGNES_API_KEY: " primary-secret ",
      AGNES_ACCOUNT_ID: " studio.primary ",
      AGNES_API_KEY_3: "third-secret",
      AGNES_ACCOUNT_ID_3: "studio-third",
    })).toEqual([
      {
        accountId: "studio.primary",
        apiKey: "primary-secret",
        keyLabel: "key-1",
        keyFingerprint: fingerprintAgnesKey("primary-secret"),
      },
      {
        accountId: "studio-third",
        apiKey: "third-secret",
        keyLabel: "key-3",
        keyFingerprint: fingerprintAgnesKey("third-secret"),
      },
    ]);
  });

  it("accepts _1 aliases and assigns lane-based default account IDs", () => {
    expect(loadAgnesAccounts({
      AGNES_API_KEY_1: "first-secret",
      AGNES_API_KEY_2: "second-secret",
    })).toEqual([
      expect.objectContaining({ accountId: "account-1", keyLabel: "key-1" }),
      expect.objectContaining({ accountId: "account-2", keyLabel: "key-2" }),
    ]);
  });

  it("loads five independent account lanes in numeric order", () => {
    const accounts = loadAgnesAccounts({
      AGNES_API_KEY_1: "first-secret",
      AGNES_API_KEY_2: "second-secret",
      AGNES_API_KEY_3: "third-secret",
      AGNES_API_KEY_4: "fourth-secret",
      AGNES_API_KEY_5: "fifth-secret",
      AGNES_ACCOUNT_ID_1: "studio-one",
      AGNES_ACCOUNT_ID_2: "studio-two",
      AGNES_ACCOUNT_ID_3: "studio-three",
      AGNES_ACCOUNT_ID_4: "studio-four",
      AGNES_ACCOUNT_ID_5: "studio-five",
    });

    expect(accounts).toHaveLength(5);
    expect(accounts.map(({ accountId, keyLabel }) => ({ accountId, keyLabel }))).toEqual([
      { accountId: "studio-one", keyLabel: "key-1" },
      { accountId: "studio-two", keyLabel: "key-2" },
      { accountId: "studio-three", keyLabel: "key-3" },
      { accountId: "studio-four", keyLabel: "key-4" },
      { accountId: "studio-five", keyLabel: "key-5" },
    ]);
    expect(new Set(accounts.map(({ keyFingerprint }) => keyFingerprint)).size).toBe(5);
  });

  it("accepts matching unsuffixed and _1 aliases", () => {
    expect(loadAgnesAccounts({
      AGNES_API_KEY: "same-secret",
      AGNES_API_KEY_1: " same-secret ",
      AGNES_ACCOUNT_ID: "studio-one",
      AGNES_ACCOUNT_ID_1: " studio-one ",
    })).toHaveLength(1);
  });

  it("rejects conflicting unsuffixed and _1 aliases", () => {
    expect(() => loadAgnesAccounts({
      AGNES_API_KEY: "first-secret",
      AGNES_API_KEY_1: "other-secret",
    })).toThrow("Conflicting unsuffixed and _1 Agnes API key values");

    expect(() => loadAgnesAccounts({
      AGNES_API_KEY: "first-secret",
      AGNES_ACCOUNT_ID: "studio-one",
      AGNES_ACCOUNT_ID_1: "studio-other",
    })).toThrow("Conflicting unsuffixed and _1 Agnes account ID values");
  });

  it("rejects duplicate keys and duplicate account IDs across lanes", () => {
    expect(() => loadAgnesAccounts({
      AGNES_API_KEY: "same-secret",
      AGNES_API_KEY_2: " same-secret ",
    })).toThrow("Duplicate Agnes API key configured for account lanes 1 and 2");

    expect(() => loadAgnesAccounts({
      AGNES_API_KEY: "first-secret",
      AGNES_API_KEY_2: "second-secret",
      AGNES_ACCOUNT_ID: "same-account",
      AGNES_ACCOUNT_ID_2: "same-account",
    })).toThrow("Duplicate Agnes account ID");
  });

  it.each([
    ["", "must not be empty"],
    ["   ", "must not be empty"],
    ["bad/account", "must be 1-64 characters"],
    [`a${"b".repeat(64)}`, "must be 1-64 characters"],
  ])("rejects invalid account ID %j", (accountId, message) => {
    expect(() => loadAgnesAccounts({
      AGNES_API_KEY: "first-secret",
      AGNES_ACCOUNT_ID: accountId,
    })).toThrow(message);
  });

  it("rejects an account ID without a corresponding API key", () => {
    expect(() => loadAgnesAccounts({
      AGNES_ACCOUNT_ID_2: "orphan-account",
    })).toThrow("has no matching AGNES_API_KEY_2");
  });
});
