/**
 * @deprecated
 *
 * The old manual reassembler discovered scene PNGs, prepended two key-art
 * sections, accepted transition inputs, and could delete/re-upload a matching
 * YouTube video. None of those behaviors belong to the Agnes-only production
 * contract, and bypassing persisted episode/upload state is unsafe.
 *
 * Keep the public function as a fail-closed compatibility shim for anyone with
 * an old import or command. It intentionally performs no filesystem, Agnes, or
 * YouTube operation.
 */

export const MANUAL_REASSEMBLY_DISABLED_MESSAGE = [
  "scripts/manualReassembleAndUpload.ts is disabled because it bypasses the current Agnes-only assembly and persisted upload workflow.",
  "Run the production agent so assembly consumes both canonical Agnes key-art title cards and each scene clip exactly once with matching WAVs and no transition padding.",
].join(" ");

export async function runManualReassembleAndUpload(): Promise<never> {
  throw new Error(MANUAL_REASSEMBLY_DISABLED_MESSAGE);
}

function isDirectInvocation(): boolean {
  return /(?:^|[/\\])manualReassembleAndUpload\.(?:[cm]?[jt]s)$/.test(process.argv[1] ?? "");
}

if (isDirectInvocation()) {
  console.error(MANUAL_REASSEMBLY_DISABLED_MESSAGE);
  process.exitCode = 1;
}
