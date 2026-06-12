import { access, constants as fsConstants } from "node:fs/promises";

/**
 * Returns the path to a testable GUI executable.
 * Prefers notepad.exe; falls back to mspaint.exe if notepad is absent
 * (e.g. on some Windows 11 configurations where the system notepad
 * stub has been removed or redirected).
 */
export async function testExePath(): Promise<string> {
  const notepad = "C:\\Windows\\System32\\notepad.exe";
  try {
    await access(notepad, fsConstants.X_OK);
    return notepad;
  } catch {
    const mspaint = "C:\\Windows\\System32\\mspaint.exe";
    await access(mspaint, fsConstants.X_OK);
    return mspaint;
  }
}
