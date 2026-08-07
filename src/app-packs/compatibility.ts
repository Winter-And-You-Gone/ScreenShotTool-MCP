// App Pack ↔ EXE compatibility diagnostics.
//
// Packs may OPTIONALLY declare `testedAgainst` (manifest.json): the build
// identity (sha256 / fileVersion / productVersion / appVersion /
// sourceRevision) their selectors were verified against. profile_launch
// computes a packCompatibility status from the ACTUAL executable:
//
//   verified             - at least one strong identity matched (sha256)
//   compatible-unverified- version info exists but binary identity could not
//                          be fully proven
//   mismatch             - the pack's declared verified binary does NOT match
//                          the current binary
//   not-declared         - the pack declares no compatibility metadata
//
// A mismatch is a WARNING, never a hard error: layout changes do not
// necessarily invalidate every selector. The status is carried into
// profile_action failures so the model knows "selector drift is plausible"
// instead of assuming the UIA core broke. No app-specific logic lives here.

import { McpUiError } from "../uia/results.js";
import type { LoadedPack } from "./types.js";

export type PackCompatibilityStatus =
  | "verified"
  | "compatible-unverified"
  | "mismatch"
  | "not-declared";

export type PackCompatibility = {
  status: PackCompatibilityStatus;
  checked: boolean;
  matchedBy?: string[];
  mismatchReasons?: string[];
};

// The installed windows module exports getExeIdentity; this interface keeps
// the module decoupled (injected at call time).
export type ExeIdentityReader = (exePath: string) => Promise<{
  sha256?: string;
  fileVersion?: string;
  productVersion?: string;
  error?: string;
}>;

export function packCompatibilityStatusFor(
  declared: LoadedPack["manifest"]["testedAgainst"],
  actual: { sha256?: string; fileVersion?: string; productVersion?: string; error?: string } | undefined
): PackCompatibility {
  if (!declared) {
    return { status: "not-declared", checked: false };
  }
  if (!actual || actual.error) {
    // The pack declared identity but the EXE identity could not be read.
    // Do not claim a mismatch on unreadable data.
    return { status: "compatible-unverified", checked: false, mismatchReasons: ["EXE identity could not be read"] };
  }

  const matchedBy: string[] = [];
  const mismatchReasons: string[] = [];
  const declaredExe = declared.executable ?? {};

  // Strong identity: sha256 equality is a full binary proof.
  if (declaredExe.sha256) {
    if (actual.sha256 && actual.sha256.toLowerCase() === declaredExe.sha256.toLowerCase()) {
      matchedBy.push("sha256");
      return { status: "verified", checked: true, matchedBy };
    }
    mismatchReasons.push("sha256");
  }
  // Version-level identity (weak: two builds can share a version).
  const versionMatched: string[] = [];
  if (declaredExe.fileVersion && actual.fileVersion && declaredExe.fileVersion === actual.fileVersion) {
    versionMatched.push("fileVersion");
  }
  if (declaredExe.productVersion && actual.productVersion && declaredExe.productVersion === actual.productVersion) {
    versionMatched.push("productVersion");
  }
  if (versionMatched.length > 0) {
    matchedBy.push(...versionMatched);
  }

  if (matchedBy.length > 0) {
    return { status: "compatible-unverified", checked: true, matchedBy };
  }
  return { status: "mismatch", checked: true, mismatchReasons: mismatchReasons.length > 0 ? mismatchReasons : ["no identity matched"] };
}

// Attach packCompatibility details to a profile-action failure so the model
// can distinguish "App Pack drift" from "UIA core failure". Returns the
// details object to merge into the McpUiError.
export function compatibilityDetails(pack: LoadedPack | undefined, status: PackCompatibilityStatus | undefined): Record<string, unknown> | undefined {
  if (!pack || !status) return undefined;
  return { packCompatibility: { status, checked: status !== "not-declared" } };
}

// Wrapped helper: never throws for an unreadable EXE - the identity reader
// returns an error field instead, and the status becomes compatible-unverified.
export async function checkPackCompatibility(
  pack: LoadedPack | undefined,
  exePath: string | undefined,
  readIdentity: ExeIdentityReader
): Promise<PackCompatibility | undefined> {
  if (!pack?.manifest.testedAgainst || !exePath) {
    return pack ? { status: "not-declared", checked: false } : undefined;
  }
  try {
    const identity = await readIdentity(exePath);
    return packCompatibilityStatusFor(pack.manifest.testedAgainst, identity);
  } catch {
    return { status: "compatible-unverified", checked: false, mismatchReasons: ["EXE identity could not be read"] };
  }
}

export function compatibilityError(status: PackCompatibilityStatus): McpUiError | undefined {
  if (status !== "mismatch") return undefined;
  return new McpUiError(
    "PACK_COMPATIBILITY_MISMATCH",
    "The App Pack declares a tested-against binary identity that does not match the current executable. Selector drift is plausible - re-verify the pack's controls against the running app before trusting failures.",
    { packCompatibility: { status: "mismatch", checked: true } }
  );
}
