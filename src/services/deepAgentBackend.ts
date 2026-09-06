import path from "node:path";
import { CompositeBackend, FilesystemBackend } from "deepagents";

export const CONVERSATION_HISTORY_ROUTE = "/conversation_history/";
export const LARGE_TOOL_RESULTS_ROUTE = "/large_tool_results/";

/**
 * DeepAgents uses virtual absolute paths for its own offloaded context files.
 * Its default FilesystemBackend instead treats absolute paths as host paths,
 * which attempts to create /conversation_history at the filesystem root.
 *
 * Keep the framework's existing filesystem behavior for all caller paths and
 * route only those internal namespaces into durable writable storage.
 */
export function createDeepAgentBackend(storageRoot: string): CompositeBackend {
  const resolvedStorageRoot = path.resolve(storageRoot);
  return new CompositeBackend(new FilesystemBackend(), {
    [CONVERSATION_HISTORY_ROUTE]: new FilesystemBackend({
      rootDir: path.join(resolvedStorageRoot, "conversation_history"),
      virtualMode: true,
    }),
    [LARGE_TOOL_RESULTS_ROUTE]: new FilesystemBackend({
      rootDir: path.join(resolvedStorageRoot, "large_tool_results"),
      virtualMode: true,
    }),
  });
}

/**
 * The pinned framework version does not expose its backend as a constructor
 * option, even though it forwards that backend to createDeepAgent. Install the
 * routed backend explicitly and fail fast if a future framework version changes
 * that runtime contract instead of silently restoring root-level writes.
 */
export function installDeepAgentBackend(
  runner: object,
  storageRoot: string,
): CompositeBackend {
  if (!Object.prototype.hasOwnProperty.call(runner, "backend")) {
    throw new Error(
      "The installed DeepAgentRunner no longer exposes its runtime backend; update the backend integration before running the agent.",
    );
  }

  const backend = createDeepAgentBackend(storageRoot);
  if (!Reflect.set(runner, "backend", backend) || Reflect.get(runner, "backend") !== backend) {
    throw new Error("Could not install the writable DeepAgents history backend.");
  }
  return backend;
}
